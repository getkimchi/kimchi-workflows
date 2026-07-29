import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunEvent } from "../src/engine/types.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createHostPort } from "../src/host/host-port.ts"
import { createProgressSink, PROGRESS_OFF_ENV, type ProgressCtx, type ProgressMode } from "../src/host/progress-sink.ts"
import { PROGRESS_WIDGET_KEY } from "../src/host/progress-widget.ts"
import { buildOutline } from "../src/progress/outline.ts"
import type { ProgressTheme } from "../src/progress/types.ts"
import { at, plainTheme, RUN_ID, runningStep, runStarted, usage } from "./progress-fixtures.ts"

/**
 * The sink against a fake `ui` (progress §12.3).
 *
 * The **mode matrix (§7.2) is the part this file exists for**. `ctx.mode` and `ctx.hasUI` disagree
 * exactly where it matters — RPC has a UI and no frame clock — and the three surfaces fail in three
 * different ways when they are confused: a component factory handed to RPC cannot cross the wire at
 * all, a `string[]` handed to the TUI never animates, and a progress line written to stdout in JSON
 * mode corrupts the event protocol a caller is parsing. None of those is visible offline unless it is
 * pinned here, and all of them are expensive to discover in a live session.
 */

const definition = createWorkflow({ name: "demo" })
	.then(createStep({ name: "analyze", run: () => ({}) }))
	.then(createStep({ name: "plan", run: () => ({}) }))
	.commit()

const outline = buildOutline(definition)

/**
 * A run with `analyze` done and `plan` in flight. The `agent-usage` sits BEFORE the completion on
 * purpose: that is the order the engine emits them in (a turn reports its usage, then the step
 * finishes), and a headless line that reported the duration without the cost would be wrong about
 * exactly the number progress §5.4 exists to surface.
 */
const LIVE: RunEvent[] = [
	runStarted("demo"),
	runningStep("analyze", 0),
	usage("analyze", 4100, 3000),
	{ type: "step-completed", runId: RUN_ID, path: "analyze", output: undefined, at: at(3100) },
	runningStep("plan", 3100),
]
/** What a real completed run looks like: every step settled BEFORE the run-level event (spec §5.3). */
const FINISH: RunEvent[] = [
	{ type: "step-completed", runId: RUN_ID, path: "plan", output: undefined, at: at(8000) },
	{ type: "run-completed", runId: RUN_ID, output: undefined, at: at(9000) },
]

/** The byte an ANSI sequence opens with — none may reach an RPC client (progress §7.2). */
const ESCAPE = String.fromCharCode(27)

/** What a widget push looked like: the key, the content, and the placement options. */
type WidgetCall = readonly [string, unknown, unknown]

/** The shape `setWidget` receives in TUI mode — a factory PI calls when it mounts the component. */
type WidgetFactory = (
	tui: { requestRender(): void },
	theme: ProgressTheme,
) => { render(width: number): string[]; invalidate(): void; dispose?(): void }

function harness(mode: ProgressMode, sessionDir = "/tmp/session") {
	const widgets: WidgetCall[] = []
	const notes: [string, string | undefined][] = []
	const working: (string | undefined)[] = []
	const entries: [string, unknown][] = []
	const lines: string[] = []

	const ctx: ProgressCtx = {
		mode,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
			setWidget: ((key: string, content: unknown, options?: unknown) =>
				void widgets.push([key, content, options])) as ProgressCtx["ui"]["setWidget"],
			setWorkingMessage: (message?: string) => void working.push(message),
		},
		sessionManager: { getSessionDir: () => sessionDir },
	}

	const sink = createProgressSink({
		ctx,
		outline,
		runLabel: "3f9a2c1d",
		workflowFilePath: "/abs/demo.workflow.ts",
		now: () => new Date(Date.parse(at(12_000))),
		write: (line: string) => void lines.push(line),
		env: {},
	})

	return { sink, widgets, notes, working, entries, lines }
}

describe("progress sink (progress §7.2): one case per ctx.mode", () => {
	it("tui — a component FACTORY, installed once however many events arrive", () => {
		const h = harness("tui")
		for (const event of LIVE) h.sink.accept(event)

		expect(h.widgets).toHaveLength(1) // installed once — one setWidget per event would leak a component (and a timer) each time
		const [key, content, options] = h.widgets[0] as WidgetCall
		expect(key).toBe(PROGRESS_WIDGET_KEY)
		expect(typeof content).toBe("function")
		expect(options).toEqual({ placement: "aboveEditor" })

		// Mounting the factory yields the same panel the pure layer draws.
		const component = (content as WidgetFactory)({ requestRender: () => {} }, plainTheme)
		const drawn = component.render(72)
		expect(drawn.some((line) => line.includes("✓ analyze"))).toBe(true)
		expect(drawn.some((line) => line.includes("3f9a2c1d"))).toBe(true)
	})

	it("tui — setWorkingMessage names the current step while live, and is restored on terminal (§7.4)", () => {
		const h = harness("tui")
		for (const event of LIVE) h.sink.accept(event)
		expect(h.working.at(-1)).toBe("workflow: plan (1 of 2)")

		for (const event of FINISH) h.sink.accept(event)
		expect(h.working.at(-1)).toBeUndefined() // restores PI's own message
	})

	it("rpc — `string[]` re-pushed per event: no factory, because one cannot cross the wire", () => {
		const h = harness("rpc")
		for (const event of LIVE) h.sink.accept(event)

		expect(h.widgets.length).toBe(LIVE.length) // redrawn only when an event moves it — the honest thing without a frame clock
		for (const [key, content] of h.widgets) {
			expect(key).toBe(PROGRESS_WIDGET_KEY)
			expect(Array.isArray(content)).toBe(true)
		}
		const lines = h.widgets.at(-1)?.[1] as string[]
		expect(lines.some((line) => line.includes("✓ analyze"))).toBe(true)
		// Plain lines over the wire: ANSI would be the client's decision to make, not ours.
		for (const line of lines) expect(line.includes(ESCAPE)).toBe(false)
		expect(h.working).toEqual([]) // a documented no-op in RPC, so it is never called (§7.4)
	})

	for (const mode of ["json", "print"] as const) {
		it(`${mode} — plain lines only: no setWidget, no card, nothing that could reach stdout (§8.1, §8.2)`, () => {
			const h = harness(mode)
			for (const event of LIVE) h.sink.accept(event)
			for (const event of FINISH) h.sink.accept(event)

			expect(h.widgets).toEqual([])
			expect(h.working).toEqual([])
			expect(h.lines).toEqual([
				"[workflow] demo workflow-demo-3f9a2c1d started",
				"[workflow]   run   analyze",
				"[workflow]   done  analyze (3.1s, 4.1k tok)",
				"[workflow]   run   plan",
				"[workflow]   done  plan (4.9s)",
				"[workflow] completed · 2 steps · 00:09 · 4.1k tok",
			])
			// Every line is plain words: the theme, the width and often the font are unknown downstream.
			for (const line of h.lines) expect(line).not.toMatch(/[⠋✓○▾▸━]/)
		})
	}
})

describe("progress sink: widget and summary lifecycle (progress §7.1, §7.6)", () => {
	/**
	 * The summary is a multi-line `notify`, not a custom entry with a registered renderer — see
	 * progress-card.ts. The richer surface took the whole extension down on a harness whose
	 * `ExtensionAPI` predates `registerEntryRenderer` (pi 0.80.2), which no offline test could have
	 * caught: the installed package's TYPES have the method, the running binary does not. These tests
	 * pin the behaviour that works on every harness instead.
	 */
	it("clears the widget exactly once and announces the outcome once, on a terminal event", () => {
		const h = harness("tui")
		for (const event of LIVE) h.sink.accept(event)
		for (const event of FINISH) h.sink.accept(event)

		const clears = h.widgets.filter(([, content]) => content === undefined)
		expect(clears).toHaveLength(1)

		expect(h.notes).toHaveLength(1)
		const [message, level] = h.notes[0] as [string, string]
		expect(level).toBe("info")
		expect(message).toContain('workflow "demo" completed')
		expect(message).toContain("2 of 2 steps")
		expect(message).toContain("3f9a2c1d")
		expect(message).toContain("/abs/demo.workflow.ts")
		expect(h.sink.reportedOutcome()).toBe(true) // → the caller does NOT notify again (§7.8)

		// `dispose()` afterwards must not push a second clear — the widget is already gone.
		h.sink.dispose()
		expect(h.widgets.filter(([, content]) => content === undefined)).toHaveLength(1)
	})

	it("points at `/workflow status` for the full tree, since the panel it was in has just cleared", () => {
		const h = harness("tui")
		for (const event of LIVE) h.sink.accept(event)
		for (const event of FINISH) h.sink.accept(event)
		expect((h.notes[0] as [string, string])[0]).toContain("/workflow status 3f9a2c1d")
	})

	it("a crashed run puts the failure reason in the summary, at error level", () => {
		const h = harness("tui")
		h.sink.accept(runStarted("demo"))
		h.sink.accept({ type: "run-crashed", runId: RUN_ID, path: "analyze", error: "kaboom", at: at(500) })

		const [message, level] = h.notes[0] as [string, string]
		expect(message).toContain("kaboom")
		expect(level).toBe("error")
	})

	it("announces on EVERY harness — no session directory and rpc both still report (§7.7)", () => {
		for (const h of [harness("tui", ""), harness("rpc")]) {
			h.sink.accept(runStarted("demo"))
			for (const event of FINISH) h.sink.accept(event)
			expect(h.notes).toHaveLength(1)
			expect(h.sink.reportedOutcome()).toBe(true)
		}
	})

	it("a blocked run KEEPS its widget and says nothing — the panel is what says which step is asking (§7.5)", () => {
		const h = harness("tui")
		h.sink.accept(runStarted("demo"))
		h.sink.accept(runningStep("analyze", 0))
		h.sink.accept({
			type: "questionnaire-asked",
			runId: RUN_ID,
			path: "analyze",
			questionnaire: { questions: [{ key: "k", header: "k", question: "k?", kind: "text" }] },
			conversation: [],
			at: at(1000),
		})

		expect(h.widgets.filter(([, content]) => content === undefined)).toEqual([])
		expect(h.notes).toEqual([]) // blocked is not terminal (spec §5.5): nothing announced yet
	})

	it("seeds from a log loaded off disk, so a resumed run opens showing its history (§9.1)", () => {
		const h = harness("rpc")
		h.sink.seed(LIVE)
		expect(h.widgets).toHaveLength(1)
		const pushed = h.widgets[0]?.[1] as string[]
		expect(pushed.some((line) => line.includes("✓ analyze"))).toBe(true)
	})
})

describe("progress sink: failure isolation (progress §2.3, §10.1)", () => {
	it("self-disables after one warning and never throws into the engine's emit", () => {
		const notes: [string, string | undefined][] = []
		let pushes = 0
		const ctx: ProgressCtx = {
			mode: "rpc",
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
				setWidget: (() => {
					pushes += 1
					throw new Error("terminal exploded")
				}) as ProgressCtx["ui"]["setWidget"],
				setWorkingMessage: () => {},
			},
			sessionManager: { getSessionDir: () => "/tmp/session" },
		}
		const sink = createProgressSink({ ctx, outline, runLabel: "3f9a2c1d", env: {} })

		// Every event still returns normally: a run must not die because a terminal could not draw a box.
		for (const event of [...LIVE, ...FINISH]) expect(() => sink.accept(event)).not.toThrow()

		expect(pushes).toBe(1) // disabled after the FIRST throw, not retried per event
		expect(notes).toHaveLength(1)
		expect(notes[0]?.[0]).toContain("progress display disabled")
		expect(notes[0]?.[1]).toBe("warning")
	})

	it("PI_WORKFLOWS_PROGRESS=off costs nothing at all, rather than merely rendering nothing (§11.2)", () => {
		const widgets: WidgetCall[] = []
		const ctx: ProgressCtx = {
			mode: "tui",
			ui: {
				notify: () => {},
				setWidget: ((key: string, content: unknown) =>
					void widgets.push([key, content, undefined])) as ProgressCtx["ui"]["setWidget"],
				setWorkingMessage: () => {},
			},
			sessionManager: { getSessionDir: () => "/tmp/session" },
		}
		const entries: unknown[] = []
		const sink = createProgressSink({
			ctx,
			outline,
			runLabel: "3f9a2c1d",
			env: { [PROGRESS_OFF_ENV]: "off" },
		})
		for (const event of [...LIVE, ...FINISH]) sink.accept(event)
		expect(widgets).toEqual([])
		expect(entries).toEqual([])
	})
})

describe("progress sink: the emit seam (progress §2.3, §10.3)", () => {
	it("persists FIRST and renders second, so a rendering failure can never lose an event", async () => {
		const order: string[] = []
		let release: (() => void) | undefined
		const store = {
			appendEvent: async () => {
				order.push("persist:start")
				await new Promise<void>((resolve) => {
					release = resolve
				})
				order.push("persist:done")
			},
			loadEvents: async () => [],
			list: async () => [],
			delete: async () => {},
		}
		const host = createHostPort(store, { onEvent: () => void order.push("render") })

		const emitted = host.emit(runStarted("demo"))
		expect(order).toEqual(["persist:start"]) // the tee has NOT run yet
		release?.()
		await emitted
		expect(order).toEqual(["persist:start", "persist:done", "render"])
	})
})

describe("progress widget: the TUI timer (progress §7.3)", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("runs only while work is in flight, and stops the moment none remains", () => {
		const h = harness("tui")
		h.sink.accept(runStarted("demo"))
		h.sink.accept(runningStep("analyze", 0))

		// PI mounts the component; only then is there a `requestRender` to drive.
		let renders = 0
		const factory = h.widgets[0]?.[1] as WidgetFactory
		factory(
			{
				requestRender: () => {
					renders += 1
				},
			},
			plainTheme,
		)

		vi.advanceTimersByTime(500)
		expect(renders).toBeGreaterThan(0) // the spinner is turning

		const before = renders
		h.sink.accept({ type: "step-completed", runId: RUN_ID, path: "analyze", output: undefined, at: at(1000) })
		vi.advanceTimersByTime(5000)
		// Nothing is in flight any more, so the interval is gone: the only render after the completion is
		// the one `update` asked for synchronously. A panel that kept waking the TUI with nothing moving
		// is exactly the cost progress §7.3 rations.
		expect(renders).toBe(before + 1)

		for (const event of FINISH) h.sink.accept(event)
		expect(h.widgets.filter(([, content]) => content === undefined)).toHaveLength(1)
	})

	it("never starts a timer while merely blocked — a wait of hours must not wake the TUI", () => {
		const h = harness("tui")
		h.sink.accept(runStarted("demo"))
		h.sink.accept(runningStep("analyze", 0))
		h.sink.accept({
			type: "questionnaire-asked",
			runId: RUN_ID,
			path: "analyze",
			questionnaire: { questions: [{ key: "k", header: "k", question: "k?", kind: "text" }] },
			conversation: [],
			at: at(1000),
		})

		let renders = 0
		const factory = h.widgets[0]?.[1] as WidgetFactory
		factory(
			{
				requestRender: () => {
					renders += 1
				},
			},
			plainTheme,
		)
		vi.advanceTimersByTime(5000)
		expect(renders).toBe(0)
	})
})
