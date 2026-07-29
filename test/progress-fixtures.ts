import { Type } from "typebox"
import type { RunEvent } from "../src/engine/types.ts"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import type { Question } from "../src/flow/questionnaire.ts"
import type { WorkflowDefinition } from "../src/flow/types.ts"
import { buildOutline } from "../src/progress/outline.ts"
import { project } from "../src/progress/project.ts"
import type { ProgressTheme, ProgressView } from "../src/progress/types.ts"

/**
 * Shared scaffolding for the progress-layer tests (progress §12.1): a fake theme, a fixed clock origin,
 * and one hand-built run per construct and per state.
 *
 * The theme is a pair of identity functions, which is exactly what progress §4.11's
 * styling-applied-last ordering buys: the renderer's real output is assertable line-for-line with no
 * terminal, no ANSI stripping, and no width arithmetic in the assertions themselves.
 *
 * Every timestamp is an offset from {@link T0} and every `now` is passed in, so neither the fixtures nor
 * anything under test can read a real clock — which is also what lets the same scenario drive the
 * projection tests, the collapse tests and the golden lines without any of them drifting apart.
 *
 * The logs are written by hand rather than by running the engine, for the same reason
 * `step-state.test.ts` does it: one behaviour per case, and a state the engine cannot currently be made
 * to produce on demand (a run crashed with a sibling mid-retry, say) is as easy to write as any other.
 * Every path here is the real dynamic node path the engine emits — `until-green#2/test`,
 * `review-each@1/review` (spec §8.5) — so the static keys these fold to are the real ones.
 */
export const plainTheme: ProgressTheme = { fg: (_colour, text) => text, bold: (text) => text }

export const RUN_ID = "workflow-demo-3f9a2c1d"

/** The clock origin every fixture offset is measured from. */
export const T0 = Date.parse("2026-07-28T10:00:00.000Z")

/** An ISO timestamp `offsetMs` after {@link T0} — what an event's `at` carries. */
export function at(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString()
}

/** The `now` a projection is taken at, `offsetMs` after {@link T0}. */
export function now(offsetMs: number): Date {
	return new Date(T0 + offsetMs)
}

export function runStarted(workflowName: string, offsetMs = 0): RunEvent {
	return { type: "run-started", runId: RUN_ID, workflowName, input: undefined, at: at(offsetMs) }
}

/** A step that ran and finished: the pair of events every completed row is derived from. */
export function ranStep(path: string, from: number, to: number, input?: unknown): RunEvent[] {
	return [
		{ type: "step-started", runId: RUN_ID, path, input, at: at(from) },
		{ type: "step-completed", runId: RUN_ID, path, output: undefined, at: at(to) },
	]
}

/** A step still executing at the moment the projection is taken. */
export function runningStep(path: string, from: number, input?: unknown): RunEvent {
	return { type: "step-started", runId: RUN_ID, path, input, at: at(from) }
}

export function usage(path: string, totalTokens: number, offsetMs: number): RunEvent {
	return { type: "agent-usage", runId: RUN_ID, path, totalTokens, at: at(offsetMs) }
}

function question(key: string): Question {
	return { key, header: key, question: `${key}?`, kind: "text" }
}

/** A run in one shape: what it was defined as, what it recorded, and when it is being looked at. */
export interface Scenario {
	readonly definition: WorkflowDefinition
	readonly events: readonly RunEvent[]
	/** Offset from {@link T0} at which the projection is taken. */
	readonly nowMs: number
}

/** The scenario's view — the one call every progress test starts from. */
export function viewOf(scenario: Scenario, nowMs = scenario.nowMs): ProgressView {
	return project(buildOutline(scenario.definition), scenario.events, now(nowMs))
}

const step = (name: string) => createStep({ name, run: () => ({}) })

// -- One scenario per construct (progress §12.1) --------------------------------------------------------

/** A plain sequence: one step done, one running, one not reached. */
export function sequenceRun(): Scenario {
	return {
		definition: createWorkflow({ name: "fix-until-green" })
			.then(step("analyze"))
			.then(step("plan"))
			.then(step("summarize"))
			.commit(),
		events: [
			runStarted("fix-until-green"),
			...ranStep("analyze", 0, 3100),
			runningStep("plan", 3100),
			usage("plan", 3200, 5000),
		],
		nowMs: 15_000,
	}
}

/** A loop on its second iteration (progress §3.3): body rows show iteration 2, the loop row shows `↻ 2/10`. */
export function loopRun(): Scenario {
	const body = createWorkflow({ name: "green-body" })
		.then(step("implement"))
		.then(step("test"))
		.then(step("review"))
		.commit()
	return {
		definition: createWorkflow({ name: "fix-until-green" })
			.then(step("analyze"))
			.dountil(body, () => true, { name: "until-green", maxIterations: 10 })
			.then(step("summarize"))
			.commit(),
		events: [
			runStarted("fix-until-green"),
			...ranStep("analyze", 0, 3100),
			{ type: "node-started", runId: RUN_ID, path: "until-green", nodeKind: "loop", at: at(3100) },
			{ type: "loop-iteration", runId: RUN_ID, path: "until-green#1", iteration: 1, at: at(3100) },
			...ranStep("until-green#1/implement", 3100, 24_100),
			...ranStep("until-green#1/test", 24_100, 42_300),
			...ranStep("until-green#1/review", 42_300, 45_000),
			{ type: "loop-iteration", runId: RUN_ID, path: "until-green#2", iteration: 2, at: at(45_000) },
			...ranStep("until-green#2/implement", 45_000, 66_000),
			usage("until-green#2/implement", 8100, 66_000),
			runningStep("until-green#2/test", 66_000),
			usage("until-green#2/test", 3200, 70_000),
		],
		nowMs: 78_000,
	}
}

/**
 * A loop caught BETWEEN iterations: `loop-iteration 2` is recorded and nothing after it, so every body
 * row still carries iteration 1's `completed` state (spec §5.4's latest-execution-wins).
 *
 * This is the shape that makes a roll-up lie. The loop has not finished — it has no `node-completed` —
 * but its subtree looks entirely settled, so anything inferring completion from children alone folds a
 * live loop into a past-tense summary. Caught by driving the real engine and cutting its log here.
 */
export function idleLoopRun(): Scenario {
	const body = createWorkflow({ name: "green-body" }).then(step("implement")).then(step("test")).commit()
	return {
		definition: createWorkflow({ name: "fix-until-green" })
			.dountil(body, () => true, { name: "until-green", maxIterations: 10 })
			.then(step("summarize"))
			.commit(),
		events: [
			runStarted("fix-until-green"),
			{ type: "node-started", runId: RUN_ID, path: "until-green", nodeKind: "loop", at: at(0) },
			{ type: "loop-iteration", runId: RUN_ID, path: "until-green#1", iteration: 1, at: at(0) },
			...ranStep("until-green#1/implement", 0, 21_000),
			...ranStep("until-green#1/test", 21_000, 39_200),
			{ type: "loop-iteration", runId: RUN_ID, path: "until-green#2", iteration: 2, at: at(39_200) },
		],
		nowMs: 46_000,
	}
}

/** A step that retried once and then SUCCEEDED — the row must read as history, not as in-flight. */
export function settledRetryRun(): Scenario {
	return {
		definition: createWorkflow({ name: "flaky-run" })
			.then(createStep({ name: "implement", retry: { maxRetry: 2 }, run: () => ({}) }))
			.commit(),
		events: [
			runStarted("flaky-run"),
			runningStep("implement", 0),
			{
				type: "step-retry",
				runId: RUN_ID,
				path: "implement",
				attempt: 1,
				reason: "thrown-error",
				error: "ECONNRESET",
				at: at(4000),
			},
			{ type: "step-completed", runId: RUN_ID, path: "implement", output: undefined, at: at(21_000) },
			{ type: "run-completed", runId: RUN_ID, output: undefined, at: at(21_000) },
		],
		nowMs: 30_000,
	}
}

/**
 * A concurrent foreach with three items live at once (progress §3.3's documented exception): one done,
 * two running, four not started. The body's single step declares an input schema, so each item's own
 * value reaches the log and the rows read `review · src/engine` rather than `review · item 0`
 * (progress §3.6) — including the third, whose item is an object with a `name`.
 */
export function foreachRun(): Scenario {
	const body = createWorkflow({ name: "review-body" })
		.then(createStep({ name: "review", input: Type.String(), run: () => ({}) }))
		.commit()
	return {
		definition: createWorkflow({ name: "release-audit" })
			.then(step("collect-changes"))
			.foreach(body, () => [], { name: "review-each", concurrency: 3 })
			.commit(),
		events: [
			runStarted("release-audit"),
			...ranStep("collect-changes", 0, 1200),
			{ type: "foreach-started", runId: RUN_ID, path: "review-each", count: 7, at: at(1200) },
			{ type: "foreach-item-started", runId: RUN_ID, path: "review-each@0", index: 0, at: at(1200) },
			...ranStep("review-each@0/review", 1200, 13_900, "src/engine"),
			usage("review-each@0/review", 4100, 13_900),
			{
				type: "foreach-item-completed",
				runId: RUN_ID,
				path: "review-each@0",
				index: 0,
				output: undefined,
				at: at(13_900),
			},
			{ type: "foreach-item-started", runId: RUN_ID, path: "review-each@1", index: 1, at: at(14_000) },
			runningStep("review-each@1/review", 14_000, "src/host"),
			usage("review-each@1/review", 2800, 18_000),
			{ type: "foreach-item-started", runId: RUN_ID, path: "review-each@2", index: 2, at: at(17_000) },
			runningStep("review-each@2/review", 17_000, { name: "src/flow" }),
			usage("review-each@2/review", 1900, 19_000),
		],
		nowMs: 23_000,
	}
}

/** A `.parallel` fan-out mid-flight: three arms, one settled and two animating together (progress §5.5). */
export function parallelRun(): Scenario {
	return {
		definition: createWorkflow({ name: "audit" })
			.then(step("collect"))
			.parallel([step("lint"), step("types"), step("tests")], { name: "checks" })
			.commit(),
		events: [
			runStarted("audit"),
			...ranStep("collect", 0, 900),
			{ type: "node-started", runId: RUN_ID, path: "checks", nodeKind: "parallel", at: at(900) },
			...ranStep("checks/lint", 900, 4500),
			runningStep("checks/types", 900),
			runningStep("checks/tests", 950),
			usage("checks/tests", 12_400, 3000),
		],
		nowMs: 9000,
	}
}

/** A branch with one arm skipped and one taken — the skipped arm's body is never drawn (progress §6.3). */
export function branchRun(): Scenario {
	const migrate = createWorkflow({ name: "needs-migration" }).then(step("migrate")).commit()
	const changelog = createWorkflow({ name: "changelog" }).then(step("write-changelog")).commit()
	return {
		definition: createWorkflow({ name: "release-audit" })
			.branch(
				[
					[() => false, migrate],
					[() => true, changelog],
				],
				{ name: "gate" },
			)
			.commit(),
		events: [
			runStarted("release-audit"),
			{ type: "node-started", runId: RUN_ID, path: "gate", nodeKind: "branch", at: at(0) },
			// Arm paths are PEERS of the branch's own (spec §8.5) — no `gate/` prefix.
			{ type: "branch-arm", runId: RUN_ID, path: "needs-migration", taken: false, at: at(0) },
			{ type: "branch-arm", runId: RUN_ID, path: "changelog", taken: true, at: at(0) },
			runningStep("changelog/write-changelog", 100),
		],
		nowMs: 6000,
	}
}

/** A nested workflow that finished, so it folds to one summary row (progress §6.1), plus a live step after it. */
export function nestedRun(): Scenario {
	const sub = createWorkflow({ name: "audit" }).then(step("lint")).then(step("types")).commit()
	return {
		definition: createWorkflow({ name: "release" }).workflow(sub).then(step("publish")).commit(),
		events: [
			runStarted("release"),
			{ type: "node-started", runId: RUN_ID, path: "audit", nodeKind: "workflow", at: at(0) },
			...ranStep("audit/lint", 0, 20_000),
			...ranStep("audit/types", 20_000, 51_000),
			{ type: "node-completed", runId: RUN_ID, path: "audit", output: undefined, at: at(51_000) },
			runningStep("publish", 51_000),
		],
		nowMs: 60_000,
	}
}

// -- One scenario per state (progress §12.1) ------------------------------------------------------------

/** Live states: a step mid-retry (and mid-steer) alongside a step blocked on a two-question batch. */
export function blockedRetryRun(): Scenario {
	return {
		definition: createWorkflow({ name: "states" })
			.then(createStep({ name: "flaky", retry: { maxRetry: 2 }, run: () => ({}) }))
			.then(step("sign-off"))
			.commit(),
		events: [
			runStarted("states"),
			runningStep("flaky", 0),
			{
				type: "step-retry",
				runId: RUN_ID,
				path: "flaky",
				attempt: 2,
				reason: "invalid-output",
				error: "bad json",
				at: at(3000),
			},
			{ type: "agent-steer", runId: RUN_ID, path: "flaky", attempt: 1, violation: "no json", at: at(3500) },
			{ type: "step-started", runId: RUN_ID, path: "sign-off", input: undefined, at: at(4000) },
			{
				type: "questionnaire-asked",
				runId: RUN_ID,
				path: "sign-off",
				questionnaire: { questions: [question("a"), question("b")] },
				conversation: [],
				at: at(5000),
			},
		],
		nowMs: 9000,
	}
}

/**
 * Terminal states in one run: an `optional` step that failed and let the run carry on (spec §9.1), a
 * sibling abandoned by the drain (spec §9.5, `step-cancelled`), and the step the run actually crashed on.
 */
export function terminalRun(): Scenario {
	return {
		definition: createWorkflow({ name: "states" })
			.then(createStep({ name: "changelog", optional: true, run: () => ({}) }))
			.then(step("boom"))
			.then(step("stopped"))
			.commit(),
		events: [
			runStarted("states"),
			{ type: "step-started", runId: RUN_ID, path: "changelog", input: undefined, at: at(4000) },
			{ type: "step-failed", runId: RUN_ID, path: "changelog", error: "no changelog entry", at: at(6400) },
			usage("changelog", 6200, 6400),
			{ type: "step-started", runId: RUN_ID, path: "boom", input: undefined, at: at(6400) },
			{ type: "step-cancelled", runId: RUN_ID, path: "stopped", at: at(7000) },
			{ type: "run-crashed", runId: RUN_ID, path: "boom", error: "kaboom", at: at(7000) },
		],
		nowMs: 20_000,
	}
}
