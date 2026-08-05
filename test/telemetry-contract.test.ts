/**
 * The telemetry contract as an executable rule (telemetry spec R1–R4): what each `RunEvent` becomes, and
 * what may never travel with it.
 *
 * The sample table below is typed as a mapping over EVERY `RunEvent` variant, so adding an event to the
 * engine breaks this file until someone decides whether it is published — which is the only way an
 * "unmapped by choice" list stays a choice rather than an oversight (the mapper's `switch` returns
 * `undefined` for anything it does not name, and would absorb a new variant silently).
 *
 * Every content-bearing field in the samples carries {@link SENTINEL}, and every mapped payload is
 * searched for it. That makes spec R2 — no inputs, outputs, questionnaires, answers or log text — a test
 * rather than a convention. Error MESSAGES are the one exception the spec grants (truncated, not
 * redacted), so the samples spell those out with ordinary text.
 */
import { describe, expect, it } from "vitest"
import type { RunEvent } from "../src/engine/types.ts"
import { createTelemetryMapper } from "../src/host/telemetry-bridge.ts"
import { MAX_ERROR_LENGTH, WORKFLOW_TELEMETRY_CHANNEL, type WorkflowEventType } from "../src/host/telemetry-events.ts"

const RUN_ID = "workflow-demo-1a2b3c4d"
const AT = "2026-01-01T00:00:00.000Z"

/** Anything a payload must never carry is spelled with this, so a leak is greppable. */
const SENTINEL = "do-not-export-this"

const questionnaire = {
	title: SENTINEL,
	questions: [
		{ key: "env", header: SENTINEL, question: SENTINEL, kind: "text" as const },
		{ key: "tags", header: SENTINEL, question: SENTINEL, kind: "multi" as const },
	],
}

/** One sample per `RunEvent` variant. The mapped-over union is what makes this table exhaustive. */
const SAMPLES: { [K in RunEvent["type"]]: Extract<RunEvent, { type: K }> } = {
	"run-meta": { type: "run-meta", runId: RUN_ID, workflowFilePath: `/home/${SENTINEL}/deploy.workflow.ts`, at: AT },
	"run-started": { type: "run-started", runId: RUN_ID, workflowName: "demo", input: { secret: SENTINEL }, at: AT },
	"run-resumed": { type: "run-resumed", runId: RUN_ID, fromPath: "review", at: AT },
	"step-started": { type: "step-started", runId: RUN_ID, path: "batch@2/review", input: { secret: SENTINEL }, at: AT },
	"step-retry": {
		type: "step-retry",
		runId: RUN_ID,
		path: "review",
		attempt: 2,
		reason: "invalid-output",
		error: "submit_result: /summary: expected string",
		at: AT,
	},
	"agent-steer": {
		type: "agent-steer",
		runId: RUN_ID,
		path: "review",
		attempt: 1,
		violation: "submit_result: /summary: expected string",
		violationKind: "schema-violation",
		resumeKey: "orchestrator",
		at: AT,
	},
	"agent-error": {
		type: "agent-error",
		runId: RUN_ID,
		path: "review",
		attempt: 3,
		kind: "context-window-exceeded",
		message: "the input (295660 tokens) is longer than the context length",
		terminal: true,
		resumeKey: "orchestrator",
		at: AT,
	},
	"agent-usage": { type: "agent-usage", runId: RUN_ID, path: "review", totalTokens: 1234, at: AT },
	"step-completed": { type: "step-completed", runId: RUN_ID, path: "review", output: { secret: SENTINEL }, at: AT },
	"step-failed": { type: "step-failed", runId: RUN_ID, path: "review", error: "gate did not pass", at: AT },
	"step-cancelled": { type: "step-cancelled", runId: RUN_ID, path: "review", at: AT },
	"node-started": { type: "node-started", runId: RUN_ID, path: "rounds", nodeKind: "loop", at: AT },
	"node-completed": { type: "node-completed", runId: RUN_ID, path: "rounds", output: { secret: SENTINEL }, at: AT },
	"branch-arm": { type: "branch-arm", runId: RUN_ID, path: "hotfix", taken: true, at: AT },
	"loop-iteration": { type: "loop-iteration", runId: RUN_ID, path: "rounds#2", iteration: 2, at: AT },
	"foreach-started": { type: "foreach-started", runId: RUN_ID, path: "batch", count: 3, at: AT },
	"foreach-item-started": { type: "foreach-item-started", runId: RUN_ID, path: "batch@1", index: 1, at: AT },
	"foreach-item-completed": {
		type: "foreach-item-completed",
		runId: RUN_ID,
		path: "batch@1",
		index: 1,
		output: { secret: SENTINEL },
		at: AT,
	},
	"step-log": {
		type: "step-log",
		runId: RUN_ID,
		path: "review",
		level: "info",
		message: SENTINEL,
		data: { note: SENTINEL },
		at: AT,
	},
	"questionnaire-asked": {
		type: "questionnaire-asked",
		runId: RUN_ID,
		path: "sign-off",
		questionnaire,
		conversation: [{ role: "assistant", content: SENTINEL }],
		violation: SENTINEL,
		at: AT,
	},
	"answers-provided": {
		type: "answers-provided",
		runId: RUN_ID,
		path: "sign-off",
		answers: { env: SENTINEL, tags: SENTINEL },
		at: AT,
	},
	"run-completed": { type: "run-completed", runId: RUN_ID, output: { secret: SENTINEL }, at: AT },
	"run-crashed": {
		type: "run-crashed",
		runId: RUN_ID,
		path: "review",
		error: 'step "review" input: /id: expected string',
		at: AT,
	},
	"run-cancelled": { type: "run-cancelled", runId: RUN_ID, path: "review", at: AT },
}

/** What each variant becomes, or `undefined` for the ones this iteration deliberately drops (R3). */
const EXPECTED_EVENTS: { [K in RunEvent["type"]]: WorkflowEventType | undefined } = {
	"run-started": "run_started",
	"run-resumed": "run_resumed",
	"run-completed": "run_completed",
	"run-crashed": "run_crashed",
	"run-cancelled": "run_cancelled",
	"step-started": "step_started",
	"step-retry": "step_retried",
	"step-completed": "step_completed",
	"step-failed": "step_failed",
	"step-cancelled": "step_cancelled",
	"questionnaire-asked": "questionnaire_asked",
	"answers-provided": "answers_provided",
	"agent-error": "agent_error",
	"agent-steer": "agent_steered",
	// Deferred or excluded, each for its own reason — see the mapper's `switch`.
	"run-meta": undefined,
	"agent-usage": undefined,
	"step-log": undefined,
	"node-started": undefined,
	"node-completed": undefined,
	"branch-arm": undefined,
	"loop-iteration": undefined,
	"foreach-started": undefined,
	"foreach-item-completed": undefined,
	"foreach-item-started": undefined,
}

const eventTypes = Object.keys(SAMPLES) as RunEvent["type"][]

/** A mapper that already knows the run, as it would after the run's own `run-started`. */
function seeded() {
	const mapper = createTelemetryMapper({ now: () => new Date(AT) })
	mapper.seed([SAMPLES["run-started"]])
	return mapper
}

describe("event mapping (spec R1/R3)", () => {
	it.each(eventTypes)("maps %s to its declared event type", (type) => {
		expect(seeded().observe(SAMPLES[type])?.event).toBe(EXPECTED_EVENTS[type])
	})

	it("publishes everything on the one `workflow:`-namespaced snake_case channel", () => {
		expect(WORKFLOW_TELEMETRY_CHANNEL).toMatch(/^workflow:[a-z][a-z0-9_]*$/)
	})

	it("names event types in snake_case, so the OTLP name is a mechanical derivation", () => {
		// `run_started` → `workflow.run.started`: the subscriber replaces `_` with `.` and prefixes.
		for (const event of Object.values(EXPECTED_EVENTS)) {
			if (event !== undefined) expect(event).toMatch(/^[a-z][a-z0-9_]*$/)
		}
	})
})

describe("content-free payloads (spec R2)", () => {
	it.each(eventTypes)("%s carries nothing the run was about", (type) => {
		const mapped = seeded().observe(SAMPLES[type])
		if (!mapped) return // an unmapped event cannot leak

		expect(JSON.stringify(mapped)).not.toContain(SENTINEL)
		for (const [key, value] of Object.entries(mapped)) {
			expect(key).not.toMatch(/^(input|output|conversation|answers|questionnaire|violation|message|data)$/)
			expect(["string", "number", "boolean", "undefined"]).toContain(typeof value)
		}
	})

	it("truncates a long error message rather than dropping or forwarding it whole", () => {
		const error = "x".repeat(MAX_ERROR_LENGTH + 50)
		const mapped = seeded().observe({ type: "step-failed", runId: RUN_ID, path: "review", error, at: AT })

		const forwarded = (mapped as { error: string }).error
		expect(forwarded).toHaveLength(MAX_ERROR_LENGTH + 1) // the cut is marked, so it cannot read as complete
		expect(forwarded.startsWith("x".repeat(MAX_ERROR_LENGTH))).toBe(true)
		expect(forwarded.endsWith("…")).toBe(true)
	})

	it("leaves a short error message exactly as the engine wrote it", () => {
		const mapped = seeded().observe(SAMPLES["step-failed"])

		expect(mapped).toMatchObject({ error: "gate did not pass" })
	})
})

describe("correlation attributes (spec R4)", () => {
	it("names the workflow on every event, learned from the run's own run-started", () => {
		const mapper = createTelemetryMapper()
		const started = mapper.observe(SAMPLES["run-started"])
		const step = mapper.observe(SAMPLES["step-started"])

		expect(started).toMatchObject({ run_id: RUN_ID, workflow_name: "demo", at: AT })
		expect(step).toMatchObject({ run_id: RUN_ID, workflow_name: "demo" })
	})

	it("reports an unnamed workflow rather than guessing, for a run this invocation never saw start", () => {
		// The stale-lock reclaim (spec R6): another session's run recorded crashed from here. `run_id` still
		// joins it to the `run_started` that session published.
		const mapped = createTelemetryMapper().observe(SAMPLES["run-crashed"])

		expect(mapped).toMatchObject({ run_id: RUN_ID, workflow_name: "" })
	})

	it("carries the dynamic path, the static key and the leaf name for a step inside a foreach", () => {
		// A foreach item's index is KEPT in the static key (spec §5.4): concurrent items are distinct series.
		expect(seeded().observe(SAMPLES["step-started"])).toMatchObject({
			path: "batch@2/review",
			static_key: "batch@2/review",
			step_name: "review",
		})
	})

	it("drops a loop iteration's index from the static key, so iterations of one step group together", () => {
		const mapper = seeded()
		const first = mapper.observe({ type: "step-started", runId: RUN_ID, path: "rounds#1/work", input: 1, at: AT })
		const second = mapper.observe({ type: "step-started", runId: RUN_ID, path: "rounds#2/work", input: 2, at: AT })

		expect(first).toMatchObject({ path: "rounds#1/work", static_key: "rounds/work" })
		expect(second).toMatchObject({ path: "rounds#2/work", static_key: "rounds/work" })
	})

	it("carries the resume key on agent-turn events, so a degrading session is separable from a hard step", () => {
		expect(seeded().observe(SAMPLES["agent-error"])).toMatchObject({
			resume_key: "orchestrator",
			kind: "context-window-exceeded",
			terminal: true,
			attempt: 3,
		})
		expect(seeded().observe(SAMPLES["agent-steer"])).toMatchObject({
			resume_key: "orchestrator",
			violation_kind: "schema-violation",
			attempt: 1,
		})
	})

	it("omits the resume key for a step that continues no conversation", () => {
		const { resumeKey: _dropped, ...cold } = SAMPLES["agent-error"]

		expect(seeded().observe(cold)).toMatchObject({ resume_key: undefined })
	})

	it("counts questions and answers without carrying either", () => {
		expect(seeded().observe(SAMPLES["questionnaire-asked"])).toMatchObject({ question_count: 2 })
		expect(seeded().observe(SAMPLES["answers-provided"])).toMatchObject({ answer_count: 2 })
	})

	it("passes the engine's retry taxonomy through unchanged", () => {
		expect(seeded().observe(SAMPLES["step-retry"])).toMatchObject({ reason: "invalid-output", attempt: 2 })
	})
})

describe("durations (spec R7: self-contained events)", () => {
	const at = (ms: number) => new Date(Date.parse(AT) + ms).toISOString()

	it("measures a step from its own step-started", () => {
		const mapper = seeded()
		mapper.observe({ type: "step-started", runId: RUN_ID, path: "review", input: undefined, at: at(0) })
		const completed = mapper.observe({ type: "step-completed", runId: RUN_ID, path: "review", output: 1, at: at(2500) })

		expect(completed).toMatchObject({ duration_ms: 2500 })
	})

	it("measures each foreach item separately, though their events interleave", () => {
		const mapper = seeded()
		mapper.observe({ type: "step-started", runId: RUN_ID, path: "batch@0/work", input: undefined, at: at(0) })
		mapper.observe({ type: "step-started", runId: RUN_ID, path: "batch@1/work", input: undefined, at: at(100) })
		const second = mapper.observe({
			type: "step-completed",
			runId: RUN_ID,
			path: "batch@1/work",
			output: 1,
			at: at(300),
		})
		const first = mapper.observe({
			type: "step-completed",
			runId: RUN_ID,
			path: "batch@0/work",
			output: 1,
			at: at(900),
		})

		expect(second).toMatchObject({ duration_ms: 200 })
		expect(first).toMatchObject({ duration_ms: 900 })
	})

	it("measures a failed optional step too — the run continues, but the step's cost is real", () => {
		const mapper = seeded()
		mapper.observe({ type: "step-started", runId: RUN_ID, path: "gate", input: undefined, at: at(0) })
		const failed = mapper.observe({ type: "step-failed", runId: RUN_ID, path: "gate", error: "no", at: at(50) })

		expect(failed).toMatchObject({ duration_ms: 50 })
	})

	it("measures the run from the run-started in its log, across a resume", () => {
		const mapper = createTelemetryMapper()
		// The log as a resuming invocation reads it back: the original start, then this leg's own events.
		mapper.seed([
			{ ...SAMPLES["run-started"], at: at(0) },
			{ type: "run-crashed", runId: RUN_ID, error: "x", at: at(10) },
		])
		mapper.observe({ type: "run-resumed", runId: RUN_ID, fromPath: "review", at: at(1000) })
		const completed = mapper.observe({ type: "run-completed", runId: RUN_ID, output: undefined, at: at(4000) })

		expect(completed).toMatchObject({ duration_ms: 4000, workflow_name: "demo" })
	})

	it("omits a duration it cannot know, rather than reporting zero", () => {
		// A backend can average an absent field away; it cannot un-average a fabricated 0.
		const mapped = createTelemetryMapper().observe(SAMPLES["run-completed"])

		expect(mapped).toMatchObject({ duration_ms: undefined })
	})
})

describe("run_blocked — the state no event records (spec R3)", () => {
	it("publishes only for a blocked result, and dates it from the clock", () => {
		const mapper = seeded()
		mapper.observe(SAMPLES["questionnaire-asked"])

		const blocked = mapper.blocked({ runId: RUN_ID, status: "blocked", path: "sign-off", questionnaire })

		expect(blocked).toMatchObject({
			event: "run_blocked",
			run_id: RUN_ID,
			workflow_name: "demo",
			at: AT,
			pending_questionnaires: 1,
		})
	})

	it("counts every blocked step, not just the one being reported (spec §8.6)", () => {
		const mapper = seeded()
		mapper.observe({ ...SAMPLES["questionnaire-asked"], path: "batch@0/ask" })
		mapper.observe({ ...SAMPLES["questionnaire-asked"], path: "batch@1/ask" })

		const blocked = mapper.blocked({ runId: RUN_ID, status: "blocked", path: "batch@0/ask", questionnaire })

		expect(blocked).toMatchObject({ pending_questionnaires: 2 })
	})

	it("stops counting a step once its answers arrive", () => {
		const mapper = seeded()
		mapper.observe(SAMPLES["questionnaire-asked"])
		mapper.observe(SAMPLES["answers-provided"])

		expect(mapper.blocked({ runId: RUN_ID, status: "blocked", questionnaire })).toMatchObject({
			pending_questionnaires: 0,
		})
	})

	it("stops counting a blocked step that was abandoned when a sibling crashed (spec §9.5)", () => {
		const mapper = seeded()
		mapper.observe(SAMPLES["questionnaire-asked"])
		mapper.observe({ type: "step-cancelled", runId: RUN_ID, path: "sign-off", at: AT })

		expect(mapper.blocked({ runId: RUN_ID, status: "blocked", questionnaire })).toMatchObject({
			pending_questionnaires: 0,
		})
	})

	it("says nothing for a terminal result — those arrived as events already", () => {
		const mapper = seeded()

		expect(mapper.blocked({ runId: RUN_ID, status: "completed" })).toBeUndefined()
		expect(mapper.blocked({ runId: RUN_ID, status: "crashed", error: "x" })).toBeUndefined()
		expect(mapper.blocked({ runId: RUN_ID, status: "cancelled" })).toBeUndefined()
	})
})
