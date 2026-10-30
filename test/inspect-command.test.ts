/**
 * `/workflow inspect` (inspection, specs/progress-ui.md §14) — resolution, transcript reading, and
 * the three surfaces, driven the way `handleStatus` is: a real run recorded off a real file, reloaded
 * from a real store, because the whole point of the command is that a step recorded a week ago
 * renders identically to the one that was live on screen.
 *
 * The transcript sidecar the command reads is written through the real `createStepTranscriptWriter`
 * (the same path the bridge drives in step-activity.test.ts's bridge coverage), so what is asserted
 * here is the COMMAND's behaviour end to end: name resolution, file discovery, rendering, live
 * refresh, and dismissal.
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RunEvent } from "../src/engine/types.ts"
import type { CommandCtx } from "../src/host/commands/context.ts"
import { handleInspect } from "../src/host/commands/inspect.ts"
import { completeWorkflowArgument } from "../src/host/completions.ts"
import { viewportBudget } from "../src/host/inspect-navigator.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import { traceSessionFile } from "../src/host/naming.ts"
import type { ProgressCtx, ProgressMode } from "../src/host/progress-sink.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import { createActivityBus } from "../src/host/step-activity.ts"
import { createStepTranscriptWriter } from "../src/host/step-transcript.ts"
import { prepareWorkflowPackageFixture } from "./workflow-package-fixture.ts"

const WORKFLOW_SOURCE = `
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows";

export default createWorkflow({ name: "audit" })
  .then(createStep({ name: "collect", run: () => ({ ok: true }) }))
  .then(createStep({ name: "report", run: () => ({ ok: true }) }))
  .commit();
`

const RUN_ID = "workflow-audit-1a2b3c4d"

/** The overlay factory a fake `ui.custom` captured: what PI would mount and focus. */
type TestFactory = (
	tui: { requestRender(): void; terminal?: { rows?: number } },
	theme: unknown,
	keybindings: { matches(data: string, keyId: string): boolean },
	done: (result: unknown) => void,
) => { render(width: number): string[]; handleInput?(data: string): void }

interface FakeCtx {
	ctx: CommandCtx & ProgressCtx
	notes: [string, string | undefined][]
	widgets: [string, unknown, unknown][]
	custom: TestFactory[]
}

/** A fake command context; TUI adds a capturable `ui.custom`, RPC does not have one. */
function fakeCtx(mode: ProgressMode, options: { readonly cwd?: string; readonly sessionDir?: string } = {}): FakeCtx {
	const notes: [string, string | undefined][] = []
	const widgets: [string, unknown, unknown][] = []
	const custom: FakeCtx["custom"] = []
	const ctx = {
		mode,
		cwd: options.cwd ?? "/tmp",
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
			setWidget: (key: string, content: unknown, options?: unknown) => void widgets.push([key, content, options]),
			setWorkingMessage: () => {},
			...(mode === "tui"
				? {
						custom: (factory: TestFactory): Promise<unknown> => {
							custom.push(factory)
							return new Promise((resolve) => {
								pendingClose.push(resolve)
							})
						},
					}
				: {}),
		},
		sessionManager: { getSessionDir: () => options.sessionDir ?? "/tmp/session" },
	} as unknown as CommandCtx & ProgressCtx
	return { ctx, notes, widgets, custom }
}

/** Resolvers for the overlays a test opened — closing one resolves its `ui.custom` promise. */
const pendingClose: ((value: unknown) => void)[] = []

/** A recorded run: real file, real store, the events a completed two-step run leaves. */
async function recordedRun() {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-workflows-inspect-"))
	await prepareWorkflowPackageFixture({ directory: workflowsDir(dir) })
	const file = path.join(dir, "audit.workflow.ts")
	await writeFile(file, WORKFLOW_SOURCE, "utf8")

	const store = createMemoryStore()
	const at = (offset: number) => new Date(Date.parse("2026-10-30T10:00:00.000Z") + offset).toISOString()
	const events: RunEvent[] = [
		{ type: "run-meta", runId: RUN_ID, workflowFilePath: file, at: at(0) },
		{ type: "run-started", runId: RUN_ID, workflowName: "audit", input: undefined, at: at(0) },
		{ type: "step-started", runId: RUN_ID, path: "collect", input: undefined, at: at(100) },
		{ type: "step-completed", runId: RUN_ID, path: "collect", output: { ok: true }, at: at(900) },
		{ type: "step-started", runId: RUN_ID, path: "report", input: undefined, at: at(1000) },
		{ type: "step-completed", runId: RUN_ID, path: "report", output: { ok: true }, at: at(1600) },
		{ type: "run-completed", runId: RUN_ID, output: { ok: true }, at: at(1700) },
	]
	for (const event of events) await store.appendEvent(event)
	return { store, dir, file }
}

afterEach(() => {
	pendingClose.length = 0
})

/** The harness's Keybindings shape, faithfully: `matches` reads per-id key lists off `this`.
 * A factory that passes the BARE method on loses the receiver — `this.keysById` is then undefined
 * and every keypress crashes the process (the crash report that found this). Mounting with a
 * class instance is the regression guard: detached calls blow up right here in the test. */
class FakeKeybindings {
	private readonly keysById = new Map<string, string[]>([
		["tui.select.up", ["\x1b[A"]],
		["tui.select.down", ["\x1b[B"]],
		["tui.select.confirm", ["\r"]],
		["tui.select.cancel", ["\x1b", "\x03"]], // escape + ctrl+c, per pi-tui defaults
	])

	matches(data: string, keyId: string): boolean {
		return (this.keysById.get(keyId) ?? []).includes(data)
	}
}

describe("handleInspect — post-hoc (recorded runs)", () => {
	it("shows a step's transcript from its sidecar file, with the file named", async () => {
		const { store, dir } = await recordedRun()
		const sessionDir = path.join(dir, "session")
		const writer = createStepTranscriptWriter(path.join(sessionDir, "workflow"), {
			runId: RUN_ID,
			workflowName: "audit",
			path: "collect",
			attempt: 1,
			stepName: "collect",
		} as Parameters<typeof createStepTranscriptWriter>[1])
		writer.appendMessage({
			role: "custom",
			customType: "kimchi-workflow-agent",
			content: "collect the audit facts",
			display: false,
		})
		writer.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Collected." },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "git log" } },
			],
			usage: { totalTokens: 900 },
		})
		writer.appendMessage({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "12 commits" }] })

		const h = fakeCtx("tui", { cwd: dir, sessionDir })
		await handleInspect(h.ctx, store, { activeRunIds: () => [], width: 80 }, "1a2b3c4d", "collect")

		expect(h.custom).toEqual([]) // a recorded run has no live overlay
		expect(h.notes).toHaveLength(1)
		const message = h.notes[0]?.[0] ?? ""
		expect(message).toContain("step collect (collect)")
		expect(message).toContain("collect the audit facts")
		expect(message).toContain("→ bash")
		expect(message).toContain("12 commits")
		expect(message).toContain(traceSessionFile("audit", RUN_ID, "collect", 1)) // where the full read lives
	})

	it("falls back to the log's facts when no transcript exists — a function step", async () => {
		const { store, dir } = await recordedRun()
		const h = fakeCtx("tui", { cwd: dir })
		await handleInspect(h.ctx, store, { activeRunIds: () => [], width: 80 }, RUN_ID, "report")

		const message = h.notes[0]?.[0] ?? ""
		expect(message).toContain("step report (report)")
		expect(message).toContain("● started")
		expect(message).toContain("● completed")
		expect(message).not.toContain("→") // no tool lines from facts alone
	})

	it("includes retries, steers, and step-log lines in the facts", async () => {
		const { store, dir } = await recordedRun()
		const at = (offset: number) => new Date(Date.parse("2026-10-30T10:00:00.000Z") + offset).toISOString()
		await store.appendEvent({
			type: "step-retry",
			runId: RUN_ID,
			path: "report",
			attempt: 1,
			reason: "thrown-error",
			error: "boom",
			at: at(1200),
		})
		await store.appendEvent({
			type: "step-log",
			runId: RUN_ID,
			path: "report",
			level: "info",
			message: "wrote 3 files",
			at: at(1300),
		})

		const h = fakeCtx("tui", { cwd: dir })
		await handleInspect(h.ctx, store, { activeRunIds: () => [], width: 80 }, RUN_ID, "report")

		const message = h.notes[0]?.[0] ?? ""
		expect(message).toContain("↻ retry 1")
		expect(message).toContain("● info  wrote 3 files")
	})

	it("reports an unknown step path rather than guessing one", async () => {
		const { store, dir } = await recordedRun()
		const h = fakeCtx("tui", { cwd: dir })
		await handleInspect(h.ctx, store, { activeRunIds: () => [], width: 80 }, RUN_ID, "nope")
		expect(h.notes[0]?.[0] ?? "").toContain('no step "nope"')
	})

	it("notifies when no run is executing and none was named", async () => {
		const { store, dir } = await recordedRun()
		const h = fakeCtx("tui", { cwd: dir })
		await handleInspect(h.ctx, store, { activeRunIds: () => [], width: 80 }, undefined, undefined)
		expect(h.notes[0]?.[0]).toContain("no run is executing")
	})
})

/** A run whose `collect` step is executing (re-started, as a resume or loop body would), with a
 * sidecar being written as it goes. */
async function liveRun() {
	const { store, dir } = await recordedRun()
	const at = (offset: number) => new Date(Date.parse("2026-10-30T10:00:00.000Z") + offset).toISOString()
	await store.appendEvent({
		type: "run-execution-started",
		runId: RUN_ID,
		executionId: "e1",
		owner: { host: "h", pid: 1, processStartedAt: at(0) },
		at: at(0),
	})
	// The run is executing again and `collect` is in flight: the same path re-started is what makes
	// the run live AND gives the view a step in progress to target.
	await store.appendEvent({ type: "run-resumed", runId: RUN_ID, fromPath: "collect", at: at(2000) })
	await store.appendEvent({ type: "step-started", runId: RUN_ID, path: "collect", input: undefined, at: at(2100) })
	const sessionDir = path.join(dir, "session")
	const transcriptDir = path.join(sessionDir, "workflow")
	const writer = createStepTranscriptWriter(transcriptDir, {
		runId: RUN_ID,
		workflowName: "audit",
		path: "collect",
		attempt: 1,
		stepName: "collect",
	} as Parameters<typeof createStepTranscriptWriter>[1])
	return { store, dir, sessionDir, writer }
}

/** Mount the overlay a live TUI invocation opened: the component PI would have rendered. Closing it
 * (a dismiss key) resolves the `ui.custom` promise the command is awaiting, exactly as PI would. */
function mount(factory: TestFactory) {
	const rendered: string[][] = []
	const close = pendingClose.shift()
	const component = factory({ requestRender: () => {}, terminal: { rows: 24 } }, {}, new FakeKeybindings(), () =>
		close?.(undefined),
	) as {
		render(width: number): string[]
		handleInput?(data: string): void
	}
	return {
		component,
		draw: () => rendered.push(component.render(80)),
		last: () => rendered.at(-1) ?? [],
	}
}

describe("handleInspect — live (executing runs)", () => {
	it("opens a live overlay for the executing step, refreshed by activity events, closed by Escape", async () => {
		const { store, dir, sessionDir, writer } = await liveRun()
		const bus = createActivityBus()
		const h = fakeCtx("tui", { cwd: dir, sessionDir })

		const inspecting = handleInspect(
			h.ctx,
			store,
			{ activeRunIds: () => [RUN_ID], activityBus: bus, width: 80 },
			undefined,
			"collect", // explicit target: the DIRECT overlay (bare inspect now opens the navigator)
		)
		// The command is async up to the overlay: the factory registers once its promises settle. The
		// explicit timeout matters — `vi.waitFor` defaults to 1s, and recording the run (file + workflow
		// compile + store) can exceed that under a loaded full-suite run, which made this test flake.
		await vi.waitFor(() => expect(h.custom).toHaveLength(1), { timeout: 10_000 })
		const { component, draw, last } = mount(h.custom[0] as TestFactory)

		// The overlay opens on the executing step and re-reads the transcript when activity arrives:
		// the file is written, then the same message's events poke the view — that ordering is
		// production's (one message_end write, one activity poke), not a re-read per frame (design-003).
		const poke = (): void =>
			bus.publish({
				runId: RUN_ID,
				path: "collect",
				attempt: 1,
				at: new Date().toISOString(),
				kind: "tool-start",
				toolName: "read",
				summary: "src/x.ts",
			})
		writer.appendMessage({
			role: "custom",
			customType: "kimchi-workflow-agent",
			content: "collect the facts",
			display: false,
		})
		poke()
		draw()
		expect(last().some((line) => line.includes("collect the facts"))).toBe(true)

		writer.appendMessage({ role: "assistant", content: [{ type: "text", text: "on it" }] })
		poke()
		draw()
		expect(last().some((line) => line.includes("on it"))).toBe(true)

		// Escape closes: the component's own dismissal path resolves the awaited overlay promise.
		component.handleInput?.("\x1b")
		await inspecting
	})

	it("opens on the compact feed and drills down to the bounded transcript behind Enter", async () => {
		const { store, dir, sessionDir, writer } = await liveRun()
		const bus = createActivityBus()
		const h = fakeCtx("tui", { cwd: dir, sessionDir })

		const inspecting = handleInspect(
			h.ctx,
			store,
			{ activeRunIds: () => [RUN_ID], activityBus: bus, width: 80 },
			undefined,
			"collect", // explicit target: the DIRECT overlay (bare inspect now opens the navigator)
		)
		await vi.waitFor(() => expect(h.custom).toHaveLength(1), { timeout: 10_000 })
		const { component, draw, last } = mount(h.custom[0] as TestFactory)

		writer.appendMessage({
			role: "custom",
			customType: "kimchi-workflow-agent",
			content: "first line of the brief\nand the second line",
			display: false,
		})
		bus.publish({
			runId: RUN_ID,
			path: "collect",
			attempt: 1,
			at: new Date().toISOString(),
			kind: "tool-start",
			toolName: "read",
			summary: "src/x.ts",
		})
		draw()

		// Compact by default (§14.11): the prompt's FIRST line, and the footer names the keys.
		expect(last().some((line) => line.includes("first line of the brief"))).toBe(true)
		expect(last().some((line) => line.includes("and the second line"))).toBe(false) // one Enter away
		expect(last().some((line) => line.includes("enter: full detail · esc: close"))).toBe(true)

		component.handleInput?.("\r") // Enter: drill down
		draw()
		expect(last().some((line) => line.includes("and the second line"))).toBe(true)

		component.handleInput?.("\r") // Enter again: back to the compact feed
		draw()
		expect(last().some((line) => line.includes("and the second line"))).toBe(false)
		expect(last().some((line) => line.includes("enter: full detail · esc: close"))).toBe(true)

		component.handleInput?.("\x1b") // Escape still closes — Enter never stole it
		await inspecting
	})

	it("RPC pushes the same lines as a widget, refreshed per activity event", async () => {
		const { store, dir, sessionDir, writer } = await liveRun()
		const bus = createActivityBus()
		const h = fakeCtx("rpc", { cwd: dir, sessionDir })

		// Not awaited to completion: the RPC path returns after installing the widget subscription.
		await handleInspect(
			h.ctx,
			store,
			{ activeRunIds: () => [RUN_ID], activityBus: bus, width: 80 },
			undefined,
			"collect", // explicit target: the DIRECT overlay (bare inspect now opens the navigator)
		)
		expect(h.widgets.length).toBeGreaterThan(0)
		expect(h.widgets[0]?.[0]).toBe("pi-workflows:inspect")

		writer.appendMessage({ role: "assistant", content: [{ type: "text", text: "still working" }] })
		bus.publish({
			runId: RUN_ID,
			path: "collect",
			attempt: 1,
			at: new Date().toISOString(),
			kind: "tool-start",
			toolName: "read",
			summary: "src/x.ts",
		})
		const pushed = h.widgets.at(-1)?.[1] as string[]
		expect(pushed.some((line) => line.includes("still working"))).toBe(true)
	})

	it("shows the bus's recent activity before the transcript's first message lands", async () => {
		const { store, dir, sessionDir } = await liveRun()
		const bus = createActivityBus()
		const h = fakeCtx("tui", { cwd: dir, sessionDir })

		const inspecting = handleInspect(
			h.ctx,
			store,
			{ activeRunIds: () => [RUN_ID], activityBus: bus, width: 80 },
			undefined,
			"collect", // explicit target: the DIRECT overlay (bare inspect now opens the navigator)
		)
		await vi.waitFor(() => expect(h.custom).toHaveLength(1), { timeout: 10_000 })
		const { component, draw, last } = mount(h.custom[0] as TestFactory)

		// No sidecar content yet — the ring is the earliest signal a live step has anything to show.
		bus.publish({
			runId: RUN_ID,
			path: "collect",
			attempt: 1,
			at: new Date().toISOString(),
			kind: "tool-start",
			toolName: "bash",
			summary: "npm test",
		})
		draw()
		expect(last().some((line) => line.includes("→ bash") && line.includes("npm test"))).toBe(true)

		component.handleInput?.("\x1b")
		await inspecting
	})

	it("with several steps executing, bare inspect opens the navigator instead of demanding a path", async () => {
		const { store, dir, sessionDir } = await liveRun()
		const at = (offset: number) => new Date(Date.parse("2026-10-30T10:00:00.000Z") + offset).toISOString()
		await store.appendEvent({ type: "step-started", runId: RUN_ID, path: "report", input: undefined, at: at(2200) })
		const bus = createActivityBus()
		const h = fakeCtx("tui", { cwd: dir, sessionDir })

		const inspecting = handleInspect(
			h.ctx,
			store,
			{ activeRunIds: () => [RUN_ID], activityBus: bus, width: 80 },
			undefined,
			undefined,
		)
		await vi.waitFor(() => expect(h.custom).toHaveLength(1), { timeout: 10_000 })
		const { component, draw, last } = mount(h.custom[0] as TestFactory)

		// The list shows BOTH running steps; the cursor follows the first of them (collect) — no path
		// demanded, no ambiguity notified: navigating is the answer to "several are running".
		draw()
		expect(last().some((line) => line.includes("●") && line.includes("collect"))).toBe(true)
		expect(last().some((line) => line.includes("●") && line.includes("report"))).toBe(true)
		expect(last().some((line) => line.includes("❯") && line.includes("collect"))).toBe(true)

		component.handleInput?.("\x1b") // close — the list is the entry, nothing was demanded
		await inspecting
	})
})

describe("the navigator (inspection §14.9): bare inspect on a live run", () => {
	/** A run whose workflow has FOURTEEN steps — more than any honest window — with the first in flight. */
	async function longRun() {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-workflows-inspect-"))
		await prepareWorkflowPackageFixture({ directory: workflowsDir(dir) })
		const file = path.join(dir, "big.workflow.ts")
		const steps = Array.from({ length: 14 }, (_, index) => `s${String(index + 1).padStart(2, "0")}`)
		const source = [
			'import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows";',
			"",
			'export default createWorkflow({ name: "big" })',
			...steps.map((name) => `  .then(createStep({ name: "${name}", run: () => ({ ok: true }) }))`),
			".commit();",
		].join("\n")
		await writeFile(file, source, "utf8")

		const store = createMemoryStore()
		const at = (offset: number) => new Date(Date.parse("2026-10-30T10:00:00.000Z") + offset).toISOString()
		const events: RunEvent[] = [
			{ type: "run-meta", runId: RUN_ID, workflowFilePath: file, at: at(0) },
			{ type: "run-started", runId: RUN_ID, workflowName: "big", input: undefined, at: at(0) },
			{ type: "step-started", runId: RUN_ID, path: "s01", input: undefined, at: at(100) },
		]
		for (const event of events) await store.appendEvent(event)
		const sessionDir = path.join(dir, "session")
		return { store, dir, sessionDir }
	}

	it("scrolls a long list inside its window — the cursor stays visible, pages jump (§14.12)", async () => {
		const { store, dir, sessionDir } = await longRun()
		const bus = createActivityBus()
		const h = fakeCtx("tui", { cwd: dir, sessionDir })

		const inspecting = handleInspect(
			h.ctx,
			store,
			{ activeRunIds: () => [RUN_ID], activityBus: bus, width: 80 },
			undefined,
			undefined,
		)
		await vi.waitFor(() => expect(h.custom).toHaveLength(1), { timeout: 10_000 })
		const { component, draw, last } = mount(h.custom[0] as TestFactory)

		// The window is 30% of the 24-row terminal = 7 rows (§14.12): the first seven steps are on
		// screen, the cursor is on the running one, and the scroll line says what is beyond.
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("s01"))).toBe(true)
		expect(last().some((line) => line.includes("s07"))).toBe(true)
		expect(last().some((line) => line.includes("s08"))).toBe(false)
		expect(last().some((line) => line.includes("… 0 above · 7 below"))).toBe(true)

		// PageDown jumps a window: the cursor lands on s08 and the window SCROLLS to keep it visible.
		component.handleInput?.("\x1b[6~")
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("s08"))).toBe(true)
		expect(last().some((line) => line.includes("s01"))).toBe(false) // scrolled away
		expect(last().some((line) => line.includes("… 1 above · 6 below"))).toBe(true)

		// j still moves one row at a time inside the scrolled window.
		component.handleInput?.("j")
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("s09"))).toBe(true)

		// PageUp jumps back a window, still keeping the cursor visible.
		component.handleInput?.("\x1b[5~")
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("s02"))).toBe(true)
		expect(last().some((line) => line.includes("… 1 above"))).toBe(true) // s01 sits one row above the window

		component.handleInput?.("\x1b")
		await inspecting
	})
})

describe("viewportBudget (inspection §14.12)", () => {
	it("is 30% of the terminal, capped at 10 rows, floored at 3", () => {
		expect(viewportBudget(24)).toBe(7)
		expect(viewportBudget(60)).toBe(10)
		expect(viewportBudget(8)).toBe(3)
		expect(viewportBudget(undefined)).toBe(10) // no terminal to ask — the cap
	})
})

describe("the navigator compact step view", () => {
	it("opens on the running step, moves on j/k, inspects on enter, and escapes back then out", async () => {
		const { store, dir, sessionDir, writer } = await liveRun()
		const bus = createActivityBus()
		const h = fakeCtx("tui", { cwd: dir, sessionDir })

		const inspecting = handleInspect(
			h.ctx,
			store,
			{ activeRunIds: () => [RUN_ID], activityBus: bus, width: 80 },
			undefined,
			undefined,
		)
		await vi.waitFor(() => expect(h.custom).toHaveLength(1), { timeout: 10_000 })
		const { component, draw, last } = mount(h.custom[0] as TestFactory)

		// The list: header, the key legend, and the tree with the cursor on the RUNNING step.
		draw()
		expect(last().some((line) => line.includes("audit"))).toBe(true) // the run header
		expect(last().some((line) => line.includes("↑↓/jk move"))).toBe(true)
		expect(last().some((line) => line.includes("❯") && line.includes("collect"))).toBe(true)

		// Down (arrow and j both) moves to the settled step; the cursor is the user's now.
		component.handleInput?.("\x1b[B")
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("report"))).toBe(true)
		component.handleInput?.("k")
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("collect"))).toBe(true)

		// Enter opens the selected step's transcript: the sidecar's prompt is on screen.
		writer.appendMessage({
			role: "custom",
			customType: "kimchi-workflow-agent",
			content: "collect the audit facts",
			display: false,
		})
		bus.publish({
			runId: RUN_ID,
			path: "collect",
			attempt: 1,
			at: new Date().toISOString(),
			kind: "tool-start",
			toolName: "bash",
			summary: "npm test",
		})
		component.handleInput?.("\r")
		draw()
		expect(last().some((line) => line.includes("step collect"))).toBe(true)
		expect(last().some((line) => line.includes("collect the audit facts"))).toBe(true)

		// The pane opens COMPACT (§14.11) — the feed, with the drill-down keys in its header.
		expect(last().some((line) => line.includes("enter: full detail"))).toBe(true)
		expect(last().some((line) => line.includes("enter: summary"))).toBe(false)

		component.handleInput?.("\r") // Enter: drill down — the same bounded view the overlay shows
		draw()
		expect(last().some((line) => line.includes("enter: summary"))).toBe(true)
		expect(last().some((line) => line.includes("enter: full detail"))).toBe(false)

		// Escape goes BACK to the list, not out of the view; a second escape closes it.
		component.handleInput?.("\x1b")
		draw()
		expect(last().some((line) => line.includes("↑↓/jk move"))).toBe(true)
		component.handleInput?.("\x1b")
		await inspecting
	})

	it("follows the current step until the user moves the cursor, then it sticks", async () => {
		const { store, dir, sessionDir } = await liveRun()
		const bus = createActivityBus()
		const at = (offset: number) => new Date(Date.parse("2026-10-30T10:00:00.000Z") + offset).toISOString()
		const h = fakeCtx("tui", { cwd: dir, sessionDir })

		const inspecting = handleInspect(
			h.ctx,
			store,
			{ activeRunIds: () => [RUN_ID], activityBus: bus, width: 80 },
			undefined,
			undefined,
		)
		await vi.waitFor(() => expect(h.custom).toHaveLength(1), { timeout: 10_000 })
		const { component, draw, last } = mount(h.custom[0] as TestFactory)
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("collect"))).toBe(true) // following the running step

		// The user moves: the cursor is theirs. Then the run moves on to `report` — the cursor does NOT.
		component.handleInput?.("k") // no selectable row above `collect`... nothing to move to
		component.handleInput?.("j") // down to `report`
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("report"))).toBe(true)
		await store.appendEvent({ type: "step-completed", runId: RUN_ID, path: "collect", output: undefined, at: at(2300) })
		await store.appendEvent({ type: "step-started", runId: RUN_ID, path: "report", input: undefined, at: at(2400) })
		bus.publish({
			runId: RUN_ID,
			path: "report",
			attempt: 1,
			at: new Date().toISOString(),
			kind: "tool-start",
			toolName: "bash",
			summary: "npm test",
		})
		await new Promise((resolve) => setTimeout(resolve, 50)) // let the chained refresh settle
		draw()
		expect(last().some((line) => line.includes("❯") && line.includes("report"))).toBe(true) // stuck where the user put it
		expect(last().some((line) => line.includes("✓") && line.includes("collect"))).toBe(true) // ...while the list kept updating

		component.handleInput?.("\x1b")
		await inspecting
	})
})

describe("completions (inspection §14)", () => {
	it("offers the inspect verb, and its run-ids with no status filter", async () => {
		const { store } = await recordedRun()
		const runs = vi.fn(async () => [
			{
				runId: RUN_ID,
				workflowName: "audit",
				status: "completed" as const,
				startedAt: "2026-10-30T10:00:00.000Z",
				currentStep: undefined,
				pendingQuestions: 0,
			},
		])

		const verbs = await completeWorkflowArgument("", { workflows: async () => [], runs })
		expect(verbs?.some((item) => item.label === "inspect")).toBe(true)

		const args = await completeWorkflowArgument("inspect ", { workflows: async () => [], runs })
		expect(args?.some((item) => item.value === `inspect ${RUN_ID}`)).toBe(true)
		void store
	})
})
