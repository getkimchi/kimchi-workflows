import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts"
import { currentStepName, deriveRunStatus, pendingQuestionCount } from "../src/engine/run-status.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { deriveStepStates, stepState } from "../src/engine/step-state.ts"
import type { RunEvent } from "../src/engine/types.ts"
import { createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { createTestHost } from "./helpers.ts"

const at = "2026-01-01T00:00:00.000Z"
const runId = "r1"
const started: RunEvent = { type: "run-started", runId, workflowName: "w", input: undefined, at }

/**
 * `deriveStepStates` (spec §5.1/§5.4) is a pure function over the event log, so the derivation table
 * is driven directly with hand-built event arrays — one behaviour per state/transition — rather than
 * running the engine for every case. A handful of engine-driven tests below cross-check the same
 * derivation against real runs (retry, loop, branch, drift).
 */
describe("deriveStepStates (spec §5.1, §5.4): one state per case", () => {
	it("todo — a step with no recorded events", () => {
		const states = deriveStepStates([started])
		expect(stepState(states, "never-touched")).toBe("todo")
	})

	it("in_progress — step-started with nothing after it", () => {
		const events: RunEvent[] = [started, { type: "step-started", runId, path: "s", input: undefined, at }]
		expect(stepState(deriveStepStates(events), "s")).toBe("in_progress")
	})

	it("in_progress — a retry keeps the step in_progress (spec §5.1: 'including retries and output steering')", () => {
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "step-retry", runId, path: "s", attempt: 1, reason: "thrown-error", error: "boom", at },
		]
		expect(stepState(deriveStepStates(events), "s")).toBe("in_progress")
	})

	it("in_progress — an agent-steer correction keeps the step in_progress", () => {
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{
				type: "agent-steer",
				runId,
				path: "s",
				attempt: 1,
				violation: "bad json",
				violationKind: "schema-violation",
				at,
			},
		]
		expect(stepState(deriveStepStates(events), "s")).toBe("in_progress")
	})

	it("in_progress — answers-provided reopens a blocked step (spec §8.4 resume)", () => {
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "questionnaire-asked", runId, path: "s", questionnaire: { questions: [] }, conversation: [], at },
			{ type: "answers-provided", runId, path: "s", answers: {}, at },
		]
		expect(stepState(deriveStepStates(events), "s")).toBe("in_progress")
	})

	it("blocked — questionnaire-asked", () => {
		const events: RunEvent[] = [
			started,
			{ type: "questionnaire-asked", runId, path: "ask", questionnaire: { questions: [] }, conversation: [], at },
		]
		expect(stepState(deriveStepStates(events), "ask")).toBe("blocked")
	})

	it("completed — step-completed", () => {
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "step-completed", runId, path: "s", output: { ok: true }, at },
		]
		expect(stepState(deriveStepStates(events), "s")).toBe("completed")
	})

	it("skipped — a branch-arm event with taken: false (spec §3.2)", () => {
		const events: RunEvent[] = [started, { type: "branch-arm", runId, path: "arm-b", taken: false, at }]
		expect(stepState(deriveStepStates(events), "arm-b")).toBe("skipped")
	})

	it("a taken branch arm runs and then completes with its node", () => {
		const taken: RunEvent = { type: "branch-arm", runId, path: "arm-a", taken: true, at }
		expect(stepState(deriveStepStates([started, taken]), "arm-a")).toBe("in_progress")

		const done: RunEvent = { type: "node-completed", runId, path: "arm-a", output: undefined, at }
		expect(stepState(deriveStepStates([started, taken, done]), "arm-a")).toBe("completed")
	})

	it("only a taken arm is closed by node-completed — an enclosing construct's node is not a step", () => {
		const events: RunEvent[] = [started, { type: "node-completed", runId, path: "some-loop", output: undefined, at }]
		expect(stepState(deriveStepStates(events), "some-loop")).toBe("todo")
	})

	it("cancelled — a step-attributed run-cancelled (mid-step boundary cancel)", () => {
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "run-cancelled", runId, path: "s", at },
		]
		expect(stepState(deriveStepStates(events), "s")).toBe("cancelled")
	})

	it("crashed — a step-attributed run-crashed (retries exhausted, spec §9.5)", () => {
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "run-crashed", runId, path: "s", error: "boom", at },
		]
		expect(stepState(deriveStepStates(events), "s")).toBe("crashed")
	})

	it("a run-level terminal event force-closes a step left open, even without naming it", () => {
		// A cold cancel of a blocked run (spec §6.4) records `run-cancelled` with NO path — but the
		// step that was blocked is definitely no longer waiting on anyone (spec §5.1: blocked means, and
		// only ever means, waiting on a human), so it must not read `blocked` forever.
		const cancelled: RunEvent[] = [
			started,
			{ type: "questionnaire-asked", runId, path: "ask", questionnaire: { questions: [] }, conversation: [], at },
			{ type: "run-cancelled", runId, at },
		]
		expect(stepState(deriveStepStates(cancelled), "ask")).toBe("cancelled")

		// Symmetrically for a node-level crash with no path (e.g. a resume's drift check, spec §8.7)
		// hitting a step still recorded in_progress from before.
		const crashed: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "run-crashed", runId, error: "drift", at },
		]
		expect(stepState(deriveStepStates(crashed), "s")).toBe("crashed")
	})

	it("a node-level terminal event with no open step is a no-op for already-settled steps", () => {
		// Loop maxIterations / workflow input violation: no step is open when the crash fires, so
		// already-completed/todo/skipped steps must be untouched.
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "seed", input: undefined, at },
			{ type: "step-completed", runId, path: "seed", output: { n: 0 }, at },
			{ type: "branch-arm", runId, path: "unused-arm", taken: false, at },
			{ type: "run-crashed", runId, error: "loop exceeded max iterations", at }, // no path
		]
		const states = deriveStepStates(events)
		expect(stepState(states, "seed")).toBe("completed")
		expect(stepState(states, "unused-arm")).toBe("skipped")
		expect(stepState(states, "never-touched")).toBe("todo")
	})

	it("latest execution wins — a step re-entered by a loop reflects only its most recent iteration (spec §5.4)", () => {
		// Each iteration's event carries the FULL dynamic path (indexed) — `deriveStepStates` collapses
		// them to the static key ("count-loop/inc"), so all three iterations share one map entry.
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "count-loop#1/inc", input: { count: 0 }, at },
			{ type: "step-completed", runId, path: "count-loop#1/inc", output: { count: 1 }, at },
			{ type: "step-started", runId, path: "count-loop#2/inc", input: { count: 1 }, at },
			{ type: "step-completed", runId, path: "count-loop#2/inc", output: { count: 2 }, at },
			{ type: "step-started", runId, path: "count-loop#3/inc", input: { count: 2 }, at }, // 3rd iteration in flight
		]
		const states = deriveStepStates(events)
		expect(stepState(states, "count-loop/inc")).toBe("in_progress")
		expect(states.size).toBe(1) // one key, not one per iteration — bounded regardless of iteration count (spec §5.4)
	})
})

// -- Cross-checks against the real engine -------------------------------------------------------------

const counterSchema = Type.Object({ count: Type.Integer() })

describe("deriveStepStates against real engine runs", () => {
	it("a loop body step ends completed after several iterations, keyed once (spec §5.4)", async () => {
		const seed = createStep({ name: "seed", output: counterSchema, run: () => ({ count: 0 }) })
		const inc = createStep({
			name: "inc",
			input: counterSchema,
			output: counterSchema,
			run: ({ input }) => ({ count: input.count + 1 }),
		})
		const body = createWorkflow({ name: "inc-body" }).then(inc).commit()
		const workflow = createWorkflow({ name: "loop" })
			.then(seed)
			.dountil(body, (_ctx, last) => (last as { count: number }).count >= 3, { name: "count-loop" })
			.commit()

		const { host, store } = createTestHost()
		const result = await runWorkflow(workflow, undefined, host)
		expect(result.status).toBe("completed")

		const states = deriveStepStates(await store.loadEvents(result.runId))
		// "inc" is keyed by its STATIC path (spec §5.4): the loop's own name, no iteration index.
		expect(stepState(states, "count-loop/inc")).toBe("completed")
		expect(states.size).toBe(2) // seed + inc — not one entry per iteration
	})

	it("an untaken branch arm reports skipped; the taken one reports its step's real state", async () => {
		const seed = createStep({
			name: "seed",
			output: Type.Object({ pick: Type.Boolean() }),
			run: () => ({ pick: true }),
		})
		const yes = createWorkflow({ name: "arm-yes" })
			.then(createStep({ name: "yes-step", run: () => ({ ok: true }) }))
			.commit()
		const no = createWorkflow({ name: "arm-no" })
			.then(createStep({ name: "no-step", run: () => ({ ok: true }) }))
			.commit()
		const workflow = createWorkflow({ name: "branch" })
			.then(seed)
			.branch([
				[(ctx) => ctx.getStepResult<{ pick: boolean }>("seed")?.pick === true, yes],
				[(ctx) => ctx.getStepResult<{ pick: boolean }>("seed")?.pick === false, no],
			])
			.commit()

		const { host, store } = createTestHost()
		const result = await runWorkflow(workflow, undefined, host)
		expect(result.status).toBe("completed")

		const states = deriveStepStates(await store.loadEvents(result.runId))
		// A taken arm is a peer addressing scope of the branch's own name (spec §8.5): its steps nest
		// under the ARM's own name (`arm-yes/yes-step`), not the branch's.
		expect(stepState(states, "arm-no")).toBe("skipped")
		expect(stepState(states, "arm-yes/yes-step")).toBe("completed")
		expect(stepState(states, "arm-no/no-step")).toBe("todo") // never reached — the skip is recorded on the arm, not walked into its body
	})

	it("a definition-drift crash during resumeWithAnswer closes the previously-blocked step (real resumeWithAnswer path)", async () => {
		const form = createQuestionnaireStep({ name: "ask", output: Type.Object({ name: Type.String() }) })
		const workflow = createWorkflow({ name: "drift" }).then(form).commit()
		const { host, store } = createTestHost()

		const blocked = await runWorkflow(workflow, undefined, host)
		expect(blocked.status).toBe("blocked")

		// Reload against a DIFFERENT workflow definition where "ask" no longer exists — the drift check
		// (spec §8.7) fires before the answer is ever delivered.
		const renamed = createWorkflow({ name: "drift" })
			.then(createQuestionnaireStep({ name: "ask-renamed", output: Type.Object({ name: Type.String() }) }))
			.commit()

		// resumeWithAnswer only THROWS for a stale/already-settled block (spec §8.4); definition drift is
		// a recorded run-crashed event, checked afterwards — so this resolves rather than rejecting.
		const events = await store.loadEvents(blocked.runId)
		const crashedResult = await resumeWithAnswer(renamed, events, { name: "Ada" }, host)
		expect(crashedResult.status).toBe("crashed")

		const finalEvents = await store.loadEvents(blocked.runId)
		const states = deriveStepStates(finalEvents)
		expect(stepState(states, "ask")).toBe("crashed") // NOT stuck "blocked" — nobody is waiting on it any more
		expect(deriveRunStatus(finalEvents)).toBe("crashed") // and the run-level precedence agrees
	})
})

// -- deriveRunStatus precedence (spec §5.3) -----------------------------------------------------------

describe("deriveRunStatus (spec §5.3): precedence", () => {
	it("undefined for a log with no run-started", () => {
		expect(deriveRunStatus([])).toBeUndefined()
	})

	it("in_progress once run-started, before anything else", () => {
		expect(deriveRunStatus([started])).toBe("in_progress")
	})

	it("blocked when a step is blocked and nothing is in_progress", () => {
		const events: RunEvent[] = [
			started,
			{ type: "questionnaire-asked", runId, path: "ask", questionnaire: { questions: [] }, conversation: [], at },
		]
		expect(deriveRunStatus(events)).toBe("blocked")
	})

	it("in_progress wins over a simultaneously blocked step (spec §5.3: work is happening even if another step is blocked)", () => {
		const events: RunEvent[] = [
			started,
			{ type: "questionnaire-asked", runId, path: "ask", questionnaire: { questions: [] }, conversation: [], at },
			{ type: "step-started", runId, path: "other", input: undefined, at },
		]
		expect(deriveRunStatus(events)).toBe("in_progress")
		// ...and the pending-question count still surfaces the blocked one (spec §6.3) even though the
		// run itself reads in_progress — this is exactly the case the count exists for.
		expect(pendingQuestionCount(deriveStepStates(events))).toBe(1)
	})

	it("completed / cancelled are run-level facts (spec §5.3), independent of any step", () => {
		expect(deriveRunStatus([started, { type: "run-completed", runId, output: {}, at }])).toBe("completed")
		// A cold cancel (spec §6.4) can land on a run with no step ever having executed.
		expect(deriveRunStatus([started, { type: "run-cancelled", runId, at }])).toBe("cancelled")
	})

	it("crashed from a run-crashed event with no path (workflow input violation, no step ever ran)", () => {
		const events: RunEvent[] = [started, { type: "run-crashed", runId, error: "bad input", at }]
		expect(deriveRunStatus(events)).toBe("crashed")
	})

	it("a later resume supersedes an earlier terminal event", () => {
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "run-crashed", runId, path: "s", error: "boom", at },
			{ type: "run-resumed", runId, fromPath: "s", at },
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "step-completed", runId, path: "s", output: {}, at },
			{ type: "run-completed", runId, output: {}, at },
		]
		expect(deriveRunStatus(events)).toBe("completed")
	})
})

describe("currentStepName (spec §6.3)", () => {
	it("reports the in_progress step when the run is in_progress", () => {
		const events: RunEvent[] = [started, { type: "step-started", runId, path: "s", input: undefined, at }]
		const status = deriveRunStatus(events)
		expect(status && currentStepName(status, deriveStepStates(events))).toBe("s")
	})

	it("reports the blocked step when the run is blocked", () => {
		const events: RunEvent[] = [
			started,
			{ type: "questionnaire-asked", runId, path: "ask", questionnaire: { questions: [] }, conversation: [], at },
		]
		const status = deriveRunStatus(events)
		expect(status && currentStepName(status, deriveStepStates(events))).toBe("ask")
	})

	it("is undefined for a cleanly completed run", () => {
		const events: RunEvent[] = [
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "step-completed", runId, path: "s", output: {}, at },
			{ type: "run-completed", runId, output: {}, at },
		]
		const status = deriveRunStatus(events)
		expect(status && currentStepName(status, deriveStepStates(events))).toBeUndefined()
	})
})

/**
 * `run-meta` is the ADAPTER's own event (spec §8.9): provenance the engine never emits and no
 * derivation may notice. It sits first in every log written by `/workflow run`, so a fold that treated
 * it as a step or as a terminal event would mis-report every run in the project.
 */
describe("run-meta is inert to every derivation", () => {
	const meta: RunEvent = { type: "run-meta", runId, workflowFilePath: "/abs/deploy.workflow.ts", at }

	it("adds no step state and changes no status", () => {
		const events: RunEvent[] = [
			meta,
			started,
			{ type: "step-started", runId, path: "s", input: undefined, at },
			{ type: "step-completed", runId, path: "s", output: {}, at },
			{ type: "run-completed", runId, output: {}, at },
		]
		expect([...deriveStepStates(events).keys()]).toEqual(["s"])
		expect(deriveRunStatus(events)).toBe("completed")
		expect(pendingQuestionCount(deriveStepStates(events))).toBe(0)
	})

	it("does not make a log with no run-started look like a run", () => {
		expect(deriveRunStatus([meta])).toBeUndefined()
	})
})
