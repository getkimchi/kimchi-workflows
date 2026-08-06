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
	// Deferred or excluded, each for its own reason — see the mapper's `switch`. `agent-error` is
	// observed (its kind resolves the retry reason that follows) but never published itself.
	"questionnaire-asked": undefined,
	"answers-provided": undefined,
	"agent-error": undefined,
	"agent-steer": undefined,
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
			expect(key).not.toMatch(
				/^(input|output|conversation|answers|questionnaire|violation|message|data|path|from_path|static_key|resume_key)$/,
			)
			if (key === "error") {
				// The one named envelope (spec R2): an object of exactly one level of primitives.
				expect(value).toBeTypeOf("object")
				for (const inner of Object.values(value as object)) {
					expect(["string", "number", "boolean", "undefined"]).toContain(typeof inner)
				}
			} else {
				expect(["string", "number", "boolean", "undefined"]).toContain(typeof value)
			}
		}
	})

	it("truncates a long error message rather than dropping or forwarding it whole", () => {
		const error = "x".repeat(MAX_ERROR_LENGTH + 50)
		const mapped = seeded().observe({ type: "step-failed", runId: RUN_ID, path: "review", error, at: AT })

		const forwarded = (mapped as unknown as { error: { message: string } }).error.message
		expect(forwarded).toHaveLength(MAX_ERROR_LENGTH + 1) // the cut is marked, so it cannot read as complete
		expect(forwarded.startsWith("x".repeat(MAX_ERROR_LENGTH))).toBe(true)
		expect(forwarded.endsWith("…")).toBe(true)
	})

	it("wraps a short error message in the envelope exactly as the engine wrote it", () => {
		const mapped = seeded().observe(SAMPLES["step-failed"])

		expect(mapped).toMatchObject({ error: { message: "gate did not pass" } })
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

	it("reduces a step's address to its leaf name — no path, no static key travels", () => {
		// Data minimization (spec R4): of the run's structure, only the step NAME is exported. The full
		// dynamic path stays in the run log for local diagnosis.
		const mapped = seeded().observe(SAMPLES["step-started"])

		expect(mapped).toMatchObject({ step_name: "review" })
		expect(mapped).not.toHaveProperty("path")
		expect(mapped).not.toHaveProperty("static_key")
	})

	it("names iterations of a looped step identically — telemetry sees one step, however often it runs", () => {
		const mapper = seeded()
		const first = mapper.observe({ type: "step-started", runId: RUN_ID, path: "rounds#1/work", input: 1, at: AT })
		const second = mapper.observe({ type: "step-started", runId: RUN_ID, path: "rounds#2/work", input: 2, at: AT })

		expect(first).toMatchObject({ step_name: "work" })
		expect(second).toMatchObject({ step_name: "work" })
	})

	it("reports a crash's cause without its location — where it crashed is the run log's to tell", () => {
		const mapped = seeded().observe(SAMPLES["run-crashed"])

		expect(mapped).toMatchObject({ error: { message: 'step "review" input: /id: expected string' } })
		expect(mapped).not.toHaveProperty("path")
	})
})

describe("the retry taxonomy — telemetry's own vocabulary (spec R1)", () => {
	const retry = (reason: "thrown-error" | "invalid-output" | "budget-exceeded" | "agent-error") =>
		({ ...SAMPLES["step-retry"], reason }) as RunEvent

	it.each([
		["thrown-error", "exception"],
		["invalid-output", "invalid_output"],
		["budget-exceeded", "budget_exceeded"],
	] as const)("translates the engine's %s to %s", (engineReason, telemetryReason) => {
		expect(seeded().observe(retry(engineReason))).toMatchObject({ reason: telemetryReason, attempt: 2 })
	})

	it("resolves an agent-error retry to the kind the preceding agent-error event recorded", () => {
		const mapper = seeded()
		expect(mapper.observe(SAMPLES["agent-error"])).toBeUndefined() // observed for state, never published
		expect(mapper.observe(retry("agent-error"))).toMatchObject({ reason: "context_window" })
	})

	it("falls back to provider_error for an agent-error retry whose kind it never saw", () => {
		expect(seeded().observe(retry("agent-error"))).toMatchObject({ reason: "provider_error" })
	})

	it("keeps agent-error kinds per step, so concurrent steps cannot inherit each other's cause", () => {
		const mapper = seeded()
		mapper.observe({ ...SAMPLES["agent-error"], path: "batch@0/work", kind: "context-window-exceeded" })
		mapper.observe({ ...SAMPLES["agent-error"], path: "batch@1/work", kind: "provider-error" })

		expect(mapper.observe({ ...retry("agent-error"), path: "batch@1/work" } as RunEvent)).toMatchObject({
			reason: "provider_error",
		})
		expect(mapper.observe({ ...retry("agent-error"), path: "batch@0/work" } as RunEvent)).toMatchObject({
			reason: "context_window",
		})
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

		const blocked = mapper.blocked({ runId: RUN_ID, status: "blocked", path: "sign-off", questionnaire })

		// The bare fact alone: the run waits on a human. What it waits FOR is the run log's business.
		expect(blocked).toEqual({
			event: "run_blocked",
			run_id: RUN_ID,
			workflow_name: "demo",
			at: AT,
		})
	})

	it("says nothing for a terminal result — those arrived as events already", () => {
		const mapper = seeded()

		expect(mapper.blocked({ runId: RUN_ID, status: "completed" })).toBeUndefined()
		expect(mapper.blocked({ runId: RUN_ID, status: "crashed", error: "x" })).toBeUndefined()
		expect(mapper.blocked({ runId: RUN_ID, status: "cancelled" })).toBeUndefined()
	})
})
