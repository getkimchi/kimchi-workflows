import { describe, expect, it } from "vitest"
import { deriveStepStates } from "../src/engine/step-state.ts"
import type { RunEvent } from "../src/engine/types.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { buildOutline } from "../src/progress/outline.ts"
import { project } from "../src/progress/project.ts"
import type { ProgressNode, ProgressView } from "../src/progress/types.ts"
import {
	at,
	blockedRetryRun,
	branchRun,
	foreachRun,
	idleLoopRun,
	loopRun,
	nestedRun,
	now,
	parallelRun,
	RUN_ID,
	ranStep,
	runStarted,
	type Scenario,
	sequenceRun,
	terminalRun,
	usage,
	viewOf,
} from "./progress-fixtures.ts"

function walk(nodes: readonly ProgressNode[]): ProgressNode[] {
	return nodes.flatMap((node) => [node, ...walk(node.children)])
}

/** Every node NOT inside an untaken branch arm — the region `deriveStepStates` speaks about at all. */
function walkOutsideSkips(nodes: readonly ProgressNode[]): ProgressNode[] {
	return nodes.flatMap((node) => (node.state === "skipped" ? [node] : [node, ...walkOutsideSkips(node.children)]))
}

/** The projected node at `path`, or a loud failure — a typo'd path in a test must not read as a pass. */
function nodeAt(view: ProgressView, path: string): ProgressNode {
	const found = walk(view.nodes).find((node) => node.path === path)
	if (!found) throw new Error(`no projected node at "${path}" (have: ${walk(view.nodes).map((node) => node.path)})`)
	return found
}

const step = (name: string) => createStep({ name, run: () => ({}) })

/**
 * The rule progress §3.1 exists to enforce: **the projection never re-derives step state.** Two answers
 * to "is this step done?" from one log is the bug this layer is shaped to make impossible, so every
 * scenario's leaf states are checked against `deriveStepStates` itself rather than against a literal.
 *
 * The one region excluded is the inside of an untaken branch arm, and it is an EXTENSION of the map
 * rather than a disagreement with it: `deriveStepStates` records the skip on the arm and explicitly
 * declines to walk into its body (spec §5.1 — a pure fold over the log has no workflow tree to walk).
 * The projection has the tree, so it finishes that job; the separate test below pins it.
 */
describe("project (progress §3.1): step state is deriveStepStates', copied", () => {
	const scenarios: readonly [string, Scenario][] = [
		["sequence", sequenceRun()],
		["loop", loopRun()],
		["foreach", foreachRun()],
		["parallel", parallelRun()],
		["branch", branchRun()],
		["nested workflow", nestedRun()],
		["blocked + retrying", blockedRetryRun()],
		["terminal", terminalRun()],
	]

	for (const [label, scenario] of scenarios) {
		it(`${label}: every projected step and arm agrees with the state map`, () => {
			const states = deriveStepStates(scenario.events)
			const view = viewOf(scenario)
			for (const node of walkOutsideSkips(view.nodes)) {
				if (node.kind !== "step" && node.kind !== "branch-arm") continue
				expect([node.path, node.state]).toEqual([node.path, states.get(node.path) ?? "todo"])
			}
		})
	}
})

describe("project (progress §3.2): what each event contributes", () => {
	it("a loop's rows are keyed by static path, so only the current iteration is visible", () => {
		const view = viewOf(loopRun())
		// Iteration 2 overwrote iteration 1 in place (progress §3.3): `implement` shows 21.0s from THIS
		// iteration, not the sum of both, and there is exactly one row per body step however long it runs.
		expect(nodeAt(view, "until-green/implement").elapsedMs).toBe(21_000)
		expect(nodeAt(view, "until-green").children).toHaveLength(3)
		// Nothing is lost: the counter on the loop row says which iteration this is, against its guard.
		expect(nodeAt(view, "until-green").loop).toEqual({ iteration: 2, max: 10 })
	})

	it("a loop's token sum spans every iteration, because cost accrues and does not reset", () => {
		// `implement` spent 8.1k in iteration 2 and `test` 3.2k so far — the loop reports its whole subtree
		// (progress §4.9), which is the only figure that stays honest once the detail folds away (§6.1).
		expect(nodeAt(viewOf(loopRun()), "until-green").tokens).toBe(11_300)
	})

	it("an unentered loop has no counter at all — nothing is invented (progress §3.4)", () => {
		const body = createWorkflow({ name: "b" }).then(step("inner")).commit()
		const workflow = createWorkflow({ name: "w" })
			.dountil(body, () => true, { name: "later", maxIterations: 3 })
			.commit()
		const view = project(buildOutline(workflow), [runStarted("w")], now(1000))
		expect(nodeAt(view, "later").loop).toBeUndefined()
		expect(nodeAt(view, "later").state).toBe("todo")
	})

	it("a foreach's count comes from foreach-started and its `done` from item checkpoints", () => {
		expect(nodeAt(viewOf(foreachRun()), "review-each").foreach).toEqual({ done: 1, count: 7 })
	})

	it("a foreach item is labelled by its body step plus a stub of the item (progress §3.6)", () => {
		const view = viewOf(foreachRun())
		expect(nodeAt(view, "review-each@0").name).toBe("review · src/engine") // a string item
		expect(nodeAt(view, "review-each@2").name).toBe("review · src/flow") // an object with a `name`
	})

	it("falls back to the index when no stub is obvious — silent where it does not work (progress §3.6)", () => {
		const scenario = foreachRun()
		const events = scenario.events.map((event) =>
			event.type === "step-started" && event.path === "review-each@1/review" ? { ...event, input: 41 } : event,
		)
		expect(nodeAt(viewOf({ ...scenario, events }), "review-each@1").name).toBe("review · item 1")
	})

	it("a retry badge carries the attempt, the declared attempt budget, and the reason (progress §5.3)", () => {
		const view = viewOf(blockedRetryRun())
		expect(nodeAt(view, "flaky").retry).toEqual({ attempt: 2, of: 3, reason: "invalid-output" })
		expect(nodeAt(view, "flaky").repairs).toBe(1) // the agent-steer correction, tracked separately
	})

	it("a blocked step freezes its clock and reports its question count", () => {
		// Wall time while waiting on a human is not work (spec §5.1), so the duration stops at the ask —
		// a run blocked overnight must not report a fourteen-hour step.
		const node = nodeAt(viewOf(blockedRetryRun()), "sign-off")
		expect(node.state).toBe("blocked")
		expect(node.elapsedMs).toBe(1000)
		expect(node.live).toBe(false)
		expect(node.questions).toBe(2)
	})

	it("an optional failure keeps its recorded error on the node for the card (progress §4.10)", () => {
		const node = nodeAt(viewOf(terminalRun()), "changelog")
		expect(node.state).toBe("crashed")
		expect(node.optional).toBe(true)
		expect(node.failureReason).toBe("no changelog entry")
	})

	it("run-meta and step-log are inert in the tree (progress §3.2)", () => {
		const scenario = sequenceRun()
		const noise: RunEvent[] = [
			{ type: "run-meta", runId: RUN_ID, workflowFilePath: "/abs/demo.workflow.ts", at: at(0) },
			{ type: "step-log", runId: RUN_ID, path: "analyze", level: "info", message: "hello", at: at(1) },
		]
		expect(viewOf({ ...scenario, events: [...noise, ...scenario.events] })).toEqual(viewOf(scenario))
	})

	it("refuses an unparseable timestamp rather than propagating a NaN duration", () => {
		const events: RunEvent[] = [
			{ type: "run-started", runId: RUN_ID, workflowName: "w", input: undefined, at: "yesterday" },
		]
		expect(() => project(buildOutline(createWorkflow({ name: "w" }).then(step("s")).commit()), events, now(0))).toThrow(
			/not a parseable ISO date/,
		)
	})
})

describe("project: a construct's state rolls its subtree up, closed by its own checkpoint", () => {
	it("a finished construct is `completed` from its own node-completed", () => {
		expect(nodeAt(viewOf(nestedRun()), "audit").state).toBe("completed")
		expect(nodeAt(viewOf(nestedRun()), "audit").steps).toBe(2)
	})

	it("a construct is `completed` ONLY from its own node-completed, never from a settled-looking subtree", () => {
		// Between iterations every body row still holds the last iteration's `completed` state (spec §5.4),
		// so a roll-up alone would report a live loop as finished and collapse it into a past-tense summary.
		const view = viewOf(idleLoopRun())
		expect(nodeAt(view, "until-green/implement").state).toBe("completed")
		expect(nodeAt(view, "until-green/test").state).toBe("completed")
		expect(nodeAt(view, "until-green").state).toBe("in_progress")
		expect(nodeAt(view, "until-green").loop).toEqual({ iteration: 2, max: 10 })
	})

	it("a run-level terminal event settles an unclosed construct instead of leaving it spinning", () => {
		const scenario = idleLoopRun()
		const cancelled = viewOf({
			...scenario,
			events: [...scenario.events, { type: "run-cancelled", runId: RUN_ID, at: at(40_000) }],
		})
		expect(nodeAt(cancelled, "until-green").state).toBe("cancelled")
		expect(cancelled.live).toBe(false)
	})

	it("work in flight outranks everything else in the subtree (spec §5.3's own precedence)", () => {
		expect(nodeAt(viewOf(parallelRun()), "checks").state).toBe("in_progress")
		expect(nodeAt(viewOf(parallelRun()), "checks").arms).toBe(3)
	})

	it("a construct holding only a blocked step reads blocked, and surfaces the question count", () => {
		const body = createWorkflow({ name: "b" }).then(step("ask")).commit()
		const workflow = createWorkflow({ name: "w" })
			.foreach(body, () => [], { name: "each" })
			.commit()
		const events: RunEvent[] = [
			runStarted("w"),
			{ type: "foreach-started", runId: RUN_ID, path: "each", count: 1, at: at(0) },
			{ type: "foreach-item-started", runId: RUN_ID, path: "each@0", index: 0, at: at(0) },
			{ type: "step-started", runId: RUN_ID, path: "each@0/ask", input: undefined, at: at(0) },
			{
				type: "questionnaire-asked",
				runId: RUN_ID,
				path: "each@0/ask",
				questionnaire: { questions: [{ key: "k", header: "k", question: "k?", kind: "text" }] },
				conversation: [],
				at: at(500),
			},
		]
		const view = project(buildOutline(workflow), events, now(4000))
		expect(nodeAt(view, "each").state).toBe("blocked")
		expect(nodeAt(view, "each").questions).toBe(1)
	})

	it("a skipped arm carries the skip down its WHOLE subtree, not just its own row", () => {
		// `deriveStepStates` stops at the arm (spec §5.1); leaving `migrate` at `todo` would keep it in
		// the footer's denominator forever, so a cleanly completed run could never reach a full bar.
		const view = viewOf(branchRun())
		expect(nodeAt(view, "needs-migration").state).toBe("skipped")
		expect(nodeAt(view, "needs-migration/migrate").state).toBe("skipped")
		expect(nodeAt(view, "gate").state).toBe("in_progress")
	})

	it("the skip reaches through nested constructs, not just the arm's immediate steps", () => {
		const inner = createWorkflow({ name: "inner" }).then(step("deep")).commit()
		const arm = createWorkflow({ name: "untaken" })
			.dountil(inner, () => true, { name: "spin", maxIterations: 2 })
			.commit()
		const workflow = createWorkflow({ name: "w" })
			.branch([[() => false, arm]], { name: "gate" })
			.commit()
		const events: RunEvent[] = [
			runStarted("w"),
			{ type: "node-started", runId: RUN_ID, path: "gate", nodeKind: "branch", at: at(0) },
			{ type: "branch-arm", runId: RUN_ID, path: "untaken", taken: false, at: at(0) },
			{ type: "node-completed", runId: RUN_ID, path: "gate", output: undefined, at: at(10) },
			{ type: "run-completed", runId: RUN_ID, output: undefined, at: at(10) },
		]
		const view = project(buildOutline(workflow), events, now(50))
		expect(nodeAt(view, "untaken/spin").state).toBe("skipped")
		expect(nodeAt(view, "untaken/spin/deep").state).toBe("skipped")
		expect([view.stepsSettled, view.stepsTotal]).toEqual([1, 1])
	})
})

describe("project: the run header and footer (progress §4.1, §4.6)", () => {
	it("sums every agent-usage in the log and tallies settled leaf steps", () => {
		const view = viewOf(loopRun())
		expect(view.tokens).toBe(11_300)
		expect(view.workflowName).toBe("fix-until-green")
		expect(view.runId).toBe(RUN_ID)
		expect(view.status).toBe("in_progress")
		// analyze + the loop's three body steps + summarize. `test` counts too: it completed in iteration 1
		// and iteration 2 has merely re-entered it, so the footer holds rather than counting down by the
		// whole loop body once per iteration (progress §6.4.1).
		expect([view.stepsSettled, view.stepsTotal]).toEqual([4, 5])
	})

	it("a foreach's whole declared size lands at foreach-started, with no rows for unstarted items", () => {
		// The denominator moves ONCE, when the count becomes known — not once per item as the rows appear.
		const scenario = foreachRun()
		const before = scenario.events.findIndex((event) => event.type === "foreach-started")
		const declared = viewOf({ ...scenario, events: scenario.events.slice(0, before + 1) })

		expect(nodeAt(declared, "review-each").pendingItems).toBe(7)
		expect(nodeAt(declared, "review-each").perItemSteps).toBe(1)
		expect(nodeAt(declared, "review-each").children).toEqual([]) // no rows invented (progress §3.8)
		expect([declared.stepsSettled, declared.stepsTotal]).toEqual([1, 8])
		// ...and it does not move again as items start.
		expect(viewOf(scenario).stepsTotal).toBe(8)
	})

	it("a loop re-entering its body does not count DOWN — the bar holds instead of retreating", () => {
		// `test` is `completed` from iteration 1 and `in_progress` in iteration 2, so a tally reading only
		// the current state would drop by the whole body on every iteration of every repair loop.
		const view = viewOf(idleLoopRun())
		expect(nodeAt(view, "until-green/implement").state).toBe("completed")
		const started = viewOf({
			...idleLoopRun(),
			events: [
				...idleLoopRun().events,
				{ type: "step-started", runId: RUN_ID, path: "until-green#2/implement", input: undefined, at: at(39_300) },
			],
		})
		expect(nodeAt(started, "until-green/implement").state).toBe("in_progress") // the ROW re-enters (§3.3)
		expect(started.stepsSettled).toBe(view.stepsSettled) // the FOOTER does not
	})

	it("counts a skipped and a cancelled step as settled — neither will ever run again", () => {
		const view = viewOf(terminalRun())
		expect([view.stepsSettled, view.stepsTotal]).toEqual([3, 3])
		expect(view.status).toBe("crashed")
		expect(view.failureReason).toBe("kaboom")
	})

	it("a terminal run stops depending on `now` at all — its clocks are frozen by the terminal event", () => {
		// Without this the durable card would keep growing every time it was re-rendered, and progress
		// §4.8's byte-identity would hold only for as long as the run was live.
		const scenario = terminalRun()
		expect(viewOf(scenario, 20_000)).toEqual(viewOf(scenario, 9_000_000))
	})

	it("a resume restarts the run clock rather than counting the wait (progress §3.2)", () => {
		const workflow = createWorkflow({ name: "w" }).then(step("s")).commit()
		const events: RunEvent[] = [
			runStarted("w"),
			{ type: "run-cancelled", runId: RUN_ID, at: at(1000) },
			{ type: "run-resumed", runId: RUN_ID, fromPath: "s", at: at(600_000) },
			...ranStep("s", 600_000, 602_000),
		]
		const view = project(buildOutline(workflow), events, now(605_000))
		expect(view.elapsedMs).toBe(5000) // five seconds of work, not ten minutes of parking
	})

	it("a step's tokens land on its own row and on the run total (progress §3.2)", () => {
		const scenario = sequenceRun()
		const events = [...scenario.events, usage("plan", 800, 6000)]
		const view = viewOf({ ...scenario, events })
		expect(nodeAt(view, "plan").tokens).toBe(4000)
		expect(view.tokens).toBe(4000)
	})
})
