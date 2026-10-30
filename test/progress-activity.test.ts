/**
 * Live activity on the progress panel (inspection, specs/progress-ui.md §14): the pure overlay that
 * puts a step's current tool call on its in-progress row, the renderer rung it occupies, the working
 * message it extends, and the sink wiring that feeds it from the activity bus.
 *
 * Everything here follows the progress suite's conventions (progress §12.1–§12.3): the fake theme is
 * a pair of identity functions, every clock is injected, and the assertions are on plain output.
 */
import { describe, expect, it } from "vitest"
import type { RunEvent } from "../src/engine/types.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { createProgressSink, PROGRESS_OFF_ENV, type ProgressCtx } from "../src/host/progress-sink.ts"
import { workingMessage } from "../src/host/progress-widget.ts"
import { createActivityBus, type StepActivity } from "../src/host/step-activity.ts"
import { withActivity } from "../src/progress/activity.ts"
import { collapse } from "../src/progress/collapse.ts"
import { buildOutline } from "../src/progress/outline.ts"
import { project } from "../src/progress/project.ts"
import { render } from "../src/progress/render.ts"
import type { ProgressNode, ProgressTheme, ProgressView } from "../src/progress/types.ts"
import { at, plainTheme, RUN_ID, runningStep, runStarted, usage } from "./progress-fixtures.ts"

// -- The pure overlay ------------------------------------------------------------------------------------------

/** A hand-built node — withActivity's own tests care about the gating rules, not a real fold. */
function stepNode(overrides: Partial<ProgressNode> & Pick<ProgressNode, "path" | "state">): ProgressNode {
	return {
		kind: "step",
		name: overrides.path,
		children: [],
		live: false,
		tokens: 0,
		optional: false,
		...overrides,
	} as ProgressNode
}

const baseView = (nodes: readonly ProgressNode[]): ProgressView =>
	({
		workflowName: "demo",
		nodes,
		live: true,
		stepsSettled: 1,
		stepsTotal: 2,
		tokens: 0,
		optionalFailures: [],
	}) as ProgressView

describe("withActivity (inspection §14)", () => {
	it("puts the hint on an in-progress step, keyed by its dynamic path", () => {
		const view = baseView([stepNode({ path: "test", state: "in_progress" })])
		const hinted = withActivity(view, new Map([["test", "bash · npm test"]]))
		expect(hinted.nodes[0]?.activityHint).toBe("bash · npm test")
	})

	it("never puts one on a settled, blocked, or unstarted row — the projection's state is the gate", () => {
		const view = baseView([
			stepNode({ path: "done", state: "completed" }),
			stepNode({ path: "waiting", state: "blocked" }),
			stepNode({ path: "later", state: "todo" }),
			stepNode({ path: "running", state: "in_progress" }),
		])
		const hinted = withActivity(
			view,
			new Map([
				["done", "x"],
				["waiting", "x"],
				["later", "x"],
				["running", "x"],
			]),
		)
		expect(hinted.nodes[0]?.activityHint).toBeUndefined()
		expect(hinted.nodes[1]?.activityHint).toBeUndefined()
		expect(hinted.nodes[2]?.activityHint).toBeUndefined()
		expect(hinted.nodes[3]?.activityHint).toBe("x")
	})

	it("annotates a foreach item by its indexed path, and never a construct row", () => {
		const view = baseView([
			stepNode({ path: "batch", state: "in_progress", kind: "foreach", children: [] }),
			stepNode({ path: "batch@7/review", state: "in_progress", kind: "foreach-item", name: "review" }),
		])
		const hinted = withActivity(view, new Map([["batch@7/review", "read · src/x.ts"]]))
		expect(hinted.nodes[0]?.activityHint).toBeUndefined()
		expect(hinted.nodes[1]?.activityHint).toBe("read · src/x.ts")
	})

	it("returns the same view object when there is nothing to apply", () => {
		const view = baseView([stepNode({ path: "test", state: "in_progress" })])
		expect(withActivity(view, new Map())).toBe(view)
	})
})

// -- The renderer rung and the working message -------------------------------------------------------------------

const definition = createWorkflow({ name: "demo" })
	.then(createStep({ name: "analyze", run: () => ({}) }))
	.then(createStep({ name: "test", run: () => ({}) }))
	.commit()

const LIVE: RunEvent[] = [
	runStarted("demo"),
	{ type: "step-completed", runId: RUN_ID, path: "analyze", output: undefined, at: at(3100) },
	runningStep("test", 3100),
	usage("test", 3200, 5000),
]

function liveView(): ProgressView {
	return project(buildOutline(definition), LIVE, new Date(at(12_000)))
}

describe("render + workingMessage with an activity hint (inspection §14)", () => {
	it("shows the hint in the status cell where `running · 9s` used to be", () => {
		const view = withActivity(liveView(), new Map([["test", "bash · npm test"]]))
		const lines = render(view, collapse(view), { width: 72, theme: plainTheme, runLabel: "3f9a2c1d" })
		expect(lines.some((line) => line.includes("test") && line.includes("bash · npm test"))).toBe(true)
		expect(lines.some((line) => line.includes("test") && line.includes("running ·"))).toBe(false)
	})

	it("bounds the hint at 40 characters — one chatty tool may not widen the whole column", () => {
		const long = `${"a".repeat(80)} npm test`
		const view = withActivity(liveView(), new Map([["test", long]]))
		const lines = render(view, collapse(view), { width: 72, theme: plainTheme, runLabel: "3f9a2c1d" })
		const row = lines.find((line) => line.includes("test")) ?? ""
		expect(row).toContain("a")
		expect(row).not.toContain(`${"a".repeat(41)}`)
	})

	it("keeps the completed row byte-identical — a settled row never changes (§4.8)", () => {
		const settled = render(liveView(), collapse(liveView()), { width: 72, theme: plainTheme, runLabel: "3f9a2c1d" })
		const hinted = render(withActivity(liveView(), new Map([["test", "bash · npm test"]])), collapse(liveView()), {
			width: 72,
			theme: plainTheme,
			runLabel: "3f9a2c1d",
		})
		const analyzeRow = (lines: string[]) => lines.find((line) => line.includes("✓ analyze"))
		expect(analyzeRow(hinted)).toBe(analyzeRow(settled))
	})

	it("names the step's current tool in the working message", () => {
		const view = withActivity(liveView(), new Map([["test", "bash · npm test"]]))
		expect(workingMessage(view)).toBe("workflow: test · bash · npm test (1 of 2)")
	})

	it("caps the working line's hint tighter than the panel's cell", () => {
		const view = withActivity(liveView(), new Map([["test", `${"b".repeat(60)} cmd`]]))
		expect(workingMessage(view)).toBe(`workflow: test · ${"b".repeat(31)}… (1 of 2)`)
	})
})

// -- The sink wiring ---------------------------------------------------------------------------------------------

type WidgetFactory = (
	tui: { requestRender(): void },
	theme: ProgressTheme,
) => { render(width: number): string[]; invalidate(): void; dispose?(): void }

function sinkHarness(mode: "tui" | "json") {
	const widgets: [string, unknown, unknown][] = []
	const notes: [string, string | undefined][] = []
	const working: (string | undefined)[] = []
	const lines: string[] = []
	const ctx: ProgressCtx = {
		mode,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
			setWidget: ((key: string, content: unknown, options?: unknown) =>
				void widgets.push([key, content, options])) as ProgressCtx["ui"]["setWidget"],
			setWorkingMessage: (message?: string) => void working.push(message),
		},
		sessionManager: { getSessionDir: () => "/tmp/session" },
	}
	const bus = createActivityBus()
	const sink = createProgressSink({
		ctx,
		outline: buildOutline(definition),
		runLabel: "3f9a2c1d",
		runId: RUN_ID,
		activityBus: bus,
		now: () => new Date(at(12_000)),
		monotonicNow: () => 1000,
		write: (line: string) => void lines.push(line),
		env: {},
	})
	return { sink, bus, widgets, notes, working, lines }
}

/** A tool-start activity for `path`, the only kind the sink turns into a hint. */
function toolStart(path: string, toolName: string, summary: string): StepActivity {
	return { runId: RUN_ID, path, attempt: 1, at: at(5000), kind: "tool-start", toolName, summary }
}

describe("progress sink × activity bus (inspection §14)", () => {
	it("redraws the live panel with the hint, without any engine event arriving", () => {
		const h = sinkHarness("tui")
		for (const event of LIVE) h.sink.accept(event)
		const before = h.widgets.length

		h.bus.publish(toolStart("test", "bash", "npm test"))

		// The widget itself was installed ONCE; the hint is inside the component's next render.
		expect(h.widgets).toHaveLength(before)
		expect(h.working.at(-1)).toBe("workflow: test · bash · npm test (1 of 2)")
		const factory = h.widgets[0]?.[1] as WidgetFactory
		const drawn = factory({ requestRender: () => {} }, plainTheme).render(72)
		expect(drawn.some((line) => line.includes("bash · npm test"))).toBe(true)
	})

	it("ignores the same hint twice — the redraw is coalesced, not per-event", () => {
		const h = sinkHarness("tui")
		for (const event of LIVE) h.sink.accept(event)
		const before = h.working.length

		h.bus.publish(toolStart("test", "bash", "npm test"))
		const after = h.working.length
		h.bus.publish(toolStart("test", "bash", "npm test"))

		expect(h.working.length).toBe(after) // no second redraw for the identical fact
		expect(after).toBeGreaterThan(before)
	})

	it("notifies a notice once — an inspection problem is a warning, never a failure", () => {
		const h = sinkHarness("tui")
		for (const event of LIVE) h.sink.accept(event)

		h.bus.publish({
			runId: RUN_ID,
			path: "test",
			attempt: 1,
			at: at(5000),
			kind: "notice",
			summary: "step transcript not recorded: EROFS",
		})
		h.bus.publish({ runId: RUN_ID, path: "test", attempt: 1, at: at(5000), kind: "notice", summary: "again" })

		const warned = h.notes.filter(([message]) => message.includes("step transcript not recorded"))
		expect(warned).toHaveLength(1)
		expect(warned[0]?.[1]).toBe("warning")
	})

	it("ignores another run's activity entirely", () => {
		const h = sinkHarness("tui")
		for (const event of LIVE) h.sink.accept(event)
		const before = h.working.length

		h.bus.publish({ ...toolStart("test", "bash", "npm test"), runId: "workflow-other-00000000" })

		expect(h.working.length).toBe(before)
	})

	it("headless stays byte-identical — the user's choice: no activity lines in json/print mode", () => {
		const h = sinkHarness("json")
		for (const event of LIVE) h.sink.accept(event)
		const before = [...h.lines]

		h.bus.publish(toolStart("test", "bash", "npm test"))
		expect(h.lines).toEqual(before)
		expect(h.widgets).toEqual([]) // no surface at all, so no subscription-driven redraw either
	})

	it("a loop body's next execution starts from a clean hint", () => {
		const h = sinkHarness("tui")
		// The loop construct is irrelevant to the assertion; what matters is the same PATH started twice —
		// a loop's second iteration — and that the second start clears the first iteration's hint.
		h.sink.accept(runStarted("demo"))
		h.sink.accept({ type: "step-started", runId: RUN_ID, path: "test", input: undefined, at: at(1000) })
		h.bus.publish(toolStart("test", "bash", "npm test"))
		expect(h.working.at(-1)).toContain("npm test")

		h.sink.accept({ type: "step-completed", runId: RUN_ID, path: "test", output: undefined, at: at(2000) })
		h.sink.accept({ type: "step-started", runId: RUN_ID, path: "test", input: undefined, at: at(3000) })
		h.bus.publish({
			runId: RUN_ID,
			path: "test",
			attempt: 2,
			at: at(3000),
			kind: "assistant-text",
			summary: "thinking",
		})

		// An assistant-text event does not set a hint, and the step-started cleared the old one: the
		// second execution's working line is back to the bare step name.
		expect(h.working.at(-1)).toBe("workflow: test (1 of 2)")
	})

	it("PROGRESS=off disables the hints along with everything else", () => {
		const widgets: [string, unknown, unknown][] = []
		const working: (string | undefined)[] = []
		const bus = createActivityBus()
		const sink = createProgressSink({
			ctx: {
				mode: "tui",
				ui: {
					notify: () => {},
					setWidget: ((key: string, content: unknown, options?: unknown) =>
						void widgets.push([key, content, options])) as ProgressCtx["ui"]["setWidget"],
					setWorkingMessage: (message?: string) => void working.push(message),
				},
				sessionManager: { getSessionDir: () => "/tmp/session" },
			},
			outline: buildOutline(definition),
			runLabel: "3f9a2c1d",
			runId: RUN_ID,
			activityBus: bus,
			now: () => new Date(at(12_000)),
			monotonicNow: () => 1000,
			env: { [PROGRESS_OFF_ENV]: "off" },
		})
		for (const event of LIVE) sink.accept(event)
		const before = working.length

		bus.publish(toolStart("test", "bash", "npm test"))
		expect(widgets).toEqual([])
		expect(working.length).toBe(before)
		sink.dispose()
	})
})
