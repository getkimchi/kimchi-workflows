/**
 * The telemetry contract (telemetry spec R1): the one channel this package publishes on `pi.events`,
 * and the discriminated union of payloads that travel on it.
 *
 * This package SHIPS no telemetry. It publishes curated domain events onto the harness's shared event
 * bus and stops there; a subscriber loaded into the same session (kimchi's telemetry extension) decides
 * whether anything is exported, batched or dropped. Under plain PI, with nobody listening, publishing is
 * a no-op — which is why there is no enablement toggle here to get out of sync with the exporter's own
 * (spec R7).
 *
 * ## One channel, not one per event
 *
 * Everything travels on {@link WORKFLOW_TELEMETRY_CHANNEL}, discriminated by each payload's `event`
 * field — a deliberate divergence from ferment's one-channel-per-event contract. The harness bus is a
 * thin wrapper over Node's `EventEmitter`: channels match by exact string, with no prefix or wildcard
 * subscription, so a per-event contract forces the subscriber to enumerate every channel and makes each
 * event added later a silent two-repo change. The known subscriber is a uniform translator — every
 * handler would be the same handler — so the envelope gives it one subscription, a mechanical
 * channel→OTLP derivation, and new event types that ship with no subscriber change at all. An in-process
 * consumer that wants a single event type filters on `event` inside its handler; that is one `if`,
 * where the reverse migration would touch two repos and a shipping pipeline.
 *
 * The canonical shapes live HERE. The subscriber mirrors the channel string and these interfaces locally
 * rather than importing them (spec R1's accepted trade-off: no dependency in either direction, and
 * contract drift is therefore silent rather than a compile error), so this module is the one place a
 * change to either side has to be reconciled against.
 *
 * Two conventions meet at this boundary and neither bends: the channel name is `namespace:snake_case`
 * (the harness bus convention, as ferment's `ferment:step_started` already is), and `event` values are
 * snake_case (`run_started`), while the OTLP event names the subscriber translates them into are dotted
 * (`workflow.run.started`) — a mechanical derivation, `workflow.` + the discriminator with `_` → `.`.
 * Payload FIELDS are snake_case here — unlike ferment's camelCase payloads — because the subscriber's
 * job is then a pass-through rather than a rename table it could get wrong one field at a time.
 *
 * ## What may travel (spec R2)
 *
 * Flat records of primitives, and nothing derived from what a run was ABOUT: no step input or output, no
 * questionnaire text, no answers, no `step-log` messages. Names, paths, statuses, counts, attempt
 * numbers, classifications, timestamps, durations — plus error messages, truncated
 * ({@link MAX_ERROR_LENGTH}), because a failure whose cause is unstated is not worth exporting. The
 * engine's error strings name schemas, fields and tools, never the values that failed them
 * (`describeSchemaViolations`), so the truncation is a size bound rather than a redaction.
 *
 * `test/telemetry-contract.test.ts` asserts this over every mapped event, so it is an executable rule
 * rather than a convention.
 */
import type { AgentOutputViolationKind, AgentTurnErrorKind, RetryReason } from "../engine/types.ts"

/**
 * The single channel this package publishes on. What arrives is always a {@link WorkflowEventPayload};
 * `event` says which one.
 */
export const WORKFLOW_TELEMETRY_CHANNEL = "workflow:telemetry"

/** How much of an error message travels (spec R2 — kimchi's own convention for the same field). */
export const MAX_ERROR_LENGTH = 300

/**
 * On every payload (spec R4). There is no trace context in this pipeline — flat attributes ARE the
 * correlation mechanism, and the subscriber layers its ambient identifiers (session id, account,
 * turn index) on top.
 *
 * `event` is the discriminator: which fact this payload states, and the sole thing a subscriber needs to
 * derive the OTLP event name from (see the module header).
 *
 * `workflow_name` is the author-declared name, unique within a project by convention and not globally
 * namespaced: two projects may each run a `deploy`. It is `""` in exactly one case — a terminal event
 * written for a run whose log this invocation never started or read, which today means the stale-lock
 * reclaim of another session's abandoned run (spec R6). Such an event still carries `run_id`, and the
 * run's own `run_started` record — published by the session that started it — is what names it.
 *
 * `at` is the event's own ISO timestamp as recorded in the run log, not the moment of publication: the
 * producer's clock is the only one that can date an event that was written before anyone subscribed.
 */
export interface WorkflowEventCommon {
	readonly event: string
	readonly run_id: string
	readonly workflow_name: string
	readonly at: string
}

/**
 * Added by every event that names a step (spec R4).
 *
 * All three are derived from the one dynamic node path the engine records (spec §8.5):
 *  - `path` — the full dynamic address, indices included (`phases@1/steps@0/attempts#2/step-turn`).
 *    Under concurrency the event ORDER is not deterministic, so a consumer correlates by this, never by
 *    adjacency.
 *  - `static_key` — the same path with loop iteration indices dropped and foreach item indices kept
 *    (`staticKeyOf`). The stable per-item identity: it is what makes "this step, across every iteration
 *    of the loop it sits in" a groupable series.
 *  - `step_name` — the leaf segment alone, for the common case where the enclosing structure does not
 *    matter.
 *
 * `attempt` is deliberately NOT here: it appears only on the events that record one (a retry, an agent
 * turn), because a step's lifecycle events do not — `step-started` is emitted once per execution, with
 * the retry loop inside it.
 */
export interface WorkflowStepEventCommon extends WorkflowEventCommon {
	readonly path: string
	readonly static_key: string
	readonly step_name: string
}

/**
 * Added by events raised during an agent step's turn.
 *
 * `resume_key` is the conversation the step continues (spec §2.2's `resumable`) — a short author-chosen
 * slug, content-free by construction (it becomes a filename). Present only when the step declared one.
 * It is what separates a degrading SESSION from a hard step: a shared transcript that has outgrown the
 * context window fails every later step keyed to it, which `path` alone reads as unrelated failures.
 */
export interface WorkflowAgentEventCommon extends WorkflowStepEventCommon {
	readonly resume_key?: string
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export interface RunStartedPayload extends WorkflowEventCommon {
	readonly event: "run_started"
}

/** `from_path` is the node execution resumed at; absent when nothing remained to run. */
export interface RunResumedPayload extends WorkflowEventCommon {
	readonly event: "run_resumed"
	readonly from_path?: string
}

/**
 * The run handed control back with questions outstanding (spec §10). Not a `RunEvent`: blocking is the
 * ABSENCE of a terminal event, so this is published where a `blocked` result is observed instead.
 *
 * `pending_questionnaires` counts every step currently blocked, not just the one being reported — under
 * concurrency several can block in the same round (spec §8.6).
 */
export interface RunBlockedPayload extends WorkflowEventCommon {
	readonly event: "run_blocked"
	readonly pending_questionnaires: number
}

/**
 * `duration_ms` spans the run's whole recorded life — from the `run-started` in its log, across every
 * resume — and is absent when that start is not in reach (a log this invocation neither wrote nor read).
 */
export interface RunCompletedPayload extends WorkflowEventCommon {
	readonly event: "run_completed"
	readonly duration_ms?: number
}

/** `path` is absent when the failure belongs to no single step: input validation, or resume-time drift. */
export interface RunCrashedPayload extends WorkflowEventCommon {
	readonly event: "run_crashed"
	readonly path?: string
	readonly error: string
	readonly duration_ms?: number
}

/** A cooperative cancel (spec §8.6). `path` is the step it stopped at, if one was executing. */
export interface RunCancelledPayload extends WorkflowEventCommon {
	readonly event: "run_cancelled"
	readonly path?: string
}

// ---------------------------------------------------------------------------
// Step lifecycle
// ---------------------------------------------------------------------------

export interface StepStartedPayload extends WorkflowStepEventCommon {
	readonly event: "step_started"
}

/** `attempt` is the 1-based attempt that just failed; `reason` is the engine's own retry taxonomy. */
export interface StepRetriedPayload extends WorkflowStepEventCommon {
	readonly event: "step_retried"
	readonly attempt: number
	readonly reason: RetryReason
	readonly error: string
}

export interface StepCompletedPayload extends WorkflowStepEventCommon {
	readonly event: "step_completed"
	readonly duration_ms?: number
}

/**
 * An `optional` step exhausted its retries and the run carried on without its output (spec §9.1).
 *
 * This — not `run_crashed` — is the failure signal that matters for workflows built the way the shipped
 * ones are: they mark nearly every agent step `optional`, so a failed turn degrades the run rather than
 * ending it, and a run can therefore complete "successfully" with many failed steps.
 */
export interface StepFailedPayload extends WorkflowStepEventCommon {
	readonly event: "step_failed"
	readonly error: string
	readonly duration_ms?: number
}

/** A blocked step abandoned because a sibling crashed in the same concurrent construct (spec §9.5). */
export interface StepCancelledPayload extends WorkflowStepEventCommon {
	readonly event: "step_cancelled"
}

// ---------------------------------------------------------------------------
// Human-in-the-loop
// ---------------------------------------------------------------------------

/** `question_count` only — the questions themselves are content (spec R2). */
export interface QuestionnaireAskedPayload extends WorkflowStepEventCommon {
	readonly event: "questionnaire_asked"
	readonly question_count: number
}

/** `answer_count` only — the answers are the user's own words (spec R2). */
export interface AnswersProvidedPayload extends WorkflowStepEventCommon {
	readonly event: "answers_provided"
	readonly answer_count: number
}

// ---------------------------------------------------------------------------
// Agent turns
// ---------------------------------------------------------------------------

/**
 * A turn that ended on a FAILED REQUEST rather than on anything the model did.
 *
 * The distinction the engine draws deliberately, preserved across the boundary: `kind` separates a
 * provider that refused from a context window that overflowed, and `terminal` marks the failure no retry
 * can clear. Without it, a flaky gateway and a misbehaving model are one number.
 */
export interface AgentErrorPayload extends WorkflowAgentEventCommon {
	readonly event: "agent_error"
	readonly attempt: number
	readonly kind: AgentTurnErrorKind
	readonly terminal: boolean
	readonly error: string
}

/**
 * The model broke the step's output contract and was corrected inside the attempt (spec §9.2).
 *
 * Repairs happen WITHIN an attempt, so retry counts alone hide them entirely — which is what makes this
 * the leading indicator of a badly specified step: it climbs before anything starts failing. `attempt`
 * is the repair number, not the step's attempt.
 */
export interface AgentSteeredPayload extends WorkflowAgentEventCommon {
	readonly event: "agent_steered"
	readonly attempt: number
	readonly violation_kind: AgentOutputViolationKind
}

/** Every payload this package publishes, discriminated by `event`. */
export type WorkflowEventPayload =
	| RunStartedPayload
	| RunResumedPayload
	| RunBlockedPayload
	| RunCompletedPayload
	| RunCrashedPayload
	| RunCancelledPayload
	| StepStartedPayload
	| StepRetriedPayload
	| StepCompletedPayload
	| StepFailedPayload
	| StepCancelledPayload
	| QuestionnaireAskedPayload
	| AnswersProvidedPayload
	| AgentErrorPayload
	| AgentSteeredPayload

/** The discriminator values — every kind of fact this package publishes. */
export type WorkflowEventType = WorkflowEventPayload["event"]

/**
 * Bound an error message to {@link MAX_ERROR_LENGTH}, marking the cut so a truncated message cannot be
 * read as a complete one.
 */
export function truncateError(message: string): string {
	return message.length <= MAX_ERROR_LENGTH ? message : `${message.slice(0, MAX_ERROR_LENGTH)}…`
}
