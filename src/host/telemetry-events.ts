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
 * ## Telemetry speaks its own language
 *
 * These payloads carry domain shapes, not wire shapes and not engine internals. Three consequences:
 *
 *  - **Vocabulary is telemetry's own.** {@link WorkflowRetryReason} says `exception` where the engine's
 *    run log says `thrown-error`, and it absorbs the agent-turn error kinds (`provider_error`,
 *    `context_window`) that the engine records as a separate event. The mapper translates; internal
 *    nomenclature stays internal.
 *  - **Errors travel as an envelope**, {@link WorkflowError} — an object with a `message`, not a bare
 *    string. The bus carries in-process objects; OTLP's flat-attribute format is the SUBSCRIBER'S
 *    constraint, and the subscriber flattens (`error` → `error.message`, generically). The envelope is
 *    the extension point: a future `retryable`, `source` or `kind` lands inside it without touching any
 *    event's shape or any subscriber code.
 *  - **Names are snake_case** (`run_started`), the channel is `namespace:snake_case` (the harness bus
 *    convention), and the subscriber's OTLP event names are a mechanical derivation — `workflow.` + the
 *    discriminator with `_` → `.` (`workflow.run.started`).
 *
 * ## What may travel (spec R2)
 *
 * Flat records of primitives — plus the one named envelope, {@link WorkflowError}, itself one level of
 * primitives — and nothing derived from what a run was ABOUT: no step input or output, no questionnaire
 * text, no answers, no `step-log` messages. Of the run's structure, only the leaf step NAME travels:
 * dynamic node paths, static keys and resume keys stay in the run log. Error messages are truncated
 * ({@link MAX_ERROR_LENGTH}), because a failure whose cause is unstated is not worth exporting; the
 * engine's error strings name schemas, fields and tools, never the values that failed them
 * (`describeSchemaViolations`), so the truncation is a size bound rather than a redaction.
 *
 * `test/telemetry-contract.test.ts` asserts this over every mapped event, so it is an executable rule
 * rather than a convention.
 */

/**
 * The single channel this package publishes on. What arrives is always a {@link WorkflowEventPayload};
 * `event` says which one.
 */
export const WORKFLOW_TELEMETRY_CHANNEL = "workflow:telemetry"

/** How much of an error message travels (spec R2 — kimchi's own convention for the same field). */
export const MAX_ERROR_LENGTH = 300

/**
 * Why a step attempt failed and was retried — telemetry's own taxonomy, translated from the engine's
 * rather than inherited (see the module header):
 *
 *  - `exception` — the step's own code threw (the run log's `thrown-error`).
 *  - `invalid_output` — the step produced output its declared schema rejects.
 *  - `budget_exceeded` — the attempt ran past a declared budget.
 *  - `provider_error` — an agent turn's REQUEST failed: the provider refused, nothing the model did.
 *  - `context_window` — an agent turn's request exceeded the context window.
 *
 * The last two preserve the distinction the engine draws deliberately (provider-failed vs
 * model-misbehaved) without a separate agent-error event: a failed request surfaces as the retry it
 * causes, and a failure no retry can clear surfaces as the `step_failed` / `run_crashed` that follows.
 */
export type WorkflowRetryReason =
	| "exception"
	| "invalid_output"
	| "budget_exceeded"
	| "provider_error"
	| "context_window"

/**
 * The error envelope (spec R2's one exception to flatness): one level of primitives, `message` today.
 * The subscriber flattens object-valued fields generically (`error` → `error.message`), so fields added
 * here later — `retryable`, `source`, a machine-readable `kind` — ship end to end with no subscriber
 * change.
 */
export interface WorkflowError {
	readonly message: string
}

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
 * `step_name` is the LEAF of the dynamic node path the engine records (spec §8.5) — and deliberately
 * the only piece of the run's structure that travels. Dynamic paths, static keys and resume keys stay
 * in the run log, where local diagnosis reads them; the exported stream is minimized to the step's
 * name alone. The accepted consequence: telemetry cannot tell two same-named steps in different
 * constructs apart, nor separate a foreach item's series from its siblings' — a consumer aggregates by
 * (`run_id`, `workflow_name`, `step_name`) and no finer.
 *
 * `attempt` is deliberately NOT here: it appears only on `step_retried`, because a step's lifecycle
 * events do not record one — `step-started` is emitted once per execution, with the retry loop inside
 * it.
 */
export interface WorkflowStepEventCommon extends WorkflowEventCommon {
	readonly step_name: string
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export interface RunStartedPayload extends WorkflowEventCommon {
	readonly event: "run_started"
}

export interface RunResumedPayload extends WorkflowEventCommon {
	readonly event: "run_resumed"
}

/**
 * The run handed control back and is waiting on a human (spec §10). Not a `RunEvent`: blocking is the
 * ABSENCE of a terminal event, so this is published where a `blocked` result is observed instead. What
 * it is waiting FOR is a run-log detail; the exported fact is only that it waits.
 */
export interface RunBlockedPayload extends WorkflowEventCommon {
	readonly event: "run_blocked"
}

/**
 * `duration_ms` spans the run's whole recorded life — from the `run-started` in its log, across every
 * resume — and is absent when that start is not in reach (a log this invocation neither wrote nor read).
 */
export interface RunCompletedPayload extends WorkflowEventCommon {
	readonly event: "run_completed"
	readonly duration_ms?: number
}

/** Where it crashed is the run log's to tell (its `run-crashed` records the path); only the cause travels. */
export interface RunCrashedPayload extends WorkflowEventCommon {
	readonly event: "run_crashed"
	readonly error: WorkflowError
	readonly duration_ms?: number
}

/** A cooperative cancel (spec §8.6). */
export interface RunCancelledPayload extends WorkflowEventCommon {
	readonly event: "run_cancelled"
}

// ---------------------------------------------------------------------------
// Step lifecycle
// ---------------------------------------------------------------------------

export interface StepStartedPayload extends WorkflowStepEventCommon {
	readonly event: "step_started"
}

/** `attempt` is the 1-based attempt that just failed; `reason` is {@link WorkflowRetryReason}. */
export interface StepRetriedPayload extends WorkflowStepEventCommon {
	readonly event: "step_retried"
	readonly attempt: number
	readonly reason: WorkflowRetryReason
	readonly error: WorkflowError
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
	readonly error: WorkflowError
	readonly duration_ms?: number
}

/** A blocked step abandoned because a sibling crashed in the same concurrent construct (spec §9.5). */
export interface StepCancelledPayload extends WorkflowStepEventCommon {
	readonly event: "step_cancelled"
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

/** The discriminator values — every kind of fact this package publishes. */
export type WorkflowEventType = WorkflowEventPayload["event"]

/**
 * Bound an error message to {@link MAX_ERROR_LENGTH}, marking the cut so a truncated message cannot be
 * read as a complete one.
 */
export function truncateError(message: string): string {
	return message.length <= MAX_ERROR_LENGTH ? message : `${message.slice(0, MAX_ERROR_LENGTH)}…`
}
