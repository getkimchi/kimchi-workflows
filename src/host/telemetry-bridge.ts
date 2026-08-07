/**
 * The bridge from the run log onto the harness event bus (telemetry spec R5/R6): the `RunEvent` →
 * {@link WorkflowEventPayload} translation, and the `RunStore` decorator that publishes it — every
 * payload on the one {@link WORKFLOW_TELEMETRY_CHANNEL}, discriminated by its `event` field.
 *
 * Three decisions carry this module:
 *
 *  - **It decorates the STORE, not the engine's event tee.** Every event a run produces reaches its log
 *    through the one `RunStore` an invocation is built with — including the two terminals the engine
 *    never emits: the cold cancel of a blocked run (`commands/lifecycle.ts`) and the stale-lock reclaim
 *    that records another session's abandoned run as crashed (`run-lock.ts`). A bridge attached to
 *    `HostPort.emit` would see neither, and terminal-state completeness (spec R6) would be a thing to
 *    remember at each new write site rather than a property of the wiring.
 *  - **Persist first, publish second, and never throw.** `appendEvent` is awaited by the engine, so an
 *    exception here would fail a step whose work already succeeded. It adopts the progress sink's
 *    invariants verbatim (`progress-sink.ts`): it tees rather than replaces, catches everything, and
 *    self-disables after one warning — a subscriber that throws once will throw on every event. Store
 *    errors are the store's own and propagate unchanged.
 *  - **Events are self-contained** (spec R7). Durations are computed HERE, from the timestamps the log
 *    already carries, so a subscriber needs no cross-event state of its own. That is what makes the same
 *    stream useful to a subscriber that started listening halfway through.
 *
 * `publish` is typed structurally so this file imports nothing from PI; the caller hands it
 * `pi.events.emit.bind(pi.events)`. The bus fans out synchronously and shares payload references with
 * every subscriber, so a fresh payload object is built per event — nothing a subscriber does to what it
 * receives can reach engine state.
 */
import { parsePath } from "../engine/node-path.ts"
import type { AgentTurnErrorKind, RetryReason, RunEvent, RunResult } from "../engine/types.ts"
import {
	type RunBlockedPayload,
	truncateError,
	WORKFLOW_TELEMETRY_CHANNEL,
	type WorkflowError,
	type WorkflowEventCommon,
	type WorkflowEventPayload,
	type WorkflowRetryReason,
	type WorkflowStepEventCommon,
} from "./telemetry-events.ts"
import type { RunStore } from "./types.ts"

/**
 * The engine's retry vocabulary → telemetry's (spec R1: internal nomenclature stays internal).
 * `agent-error` is deliberately absent: it is resolved per-retry from the kind the preceding
 * `agent-error` event recorded (see {@link RunTelemetryState.agentErrorKind}). Typed exhaustively over
 * the engine's union so a `RetryReason` added later is a compile error HERE — a classification
 * decision — rather than a silent misreport under whichever value a fallback would guess.
 */
const RETRY_REASONS: Record<Exclude<RetryReason, "agent-error">, WorkflowRetryReason> = {
	"thrown-error": "exception",
	"invalid-output": "invalid_output",
	"budget-exceeded": "budget_exceeded",
}

/** The agent-turn error kinds → the retry reasons that absorbed them (no separate agent event travels). */
const AGENT_REASONS: Record<AgentTurnErrorKind, WorkflowRetryReason> = {
	"provider-error": "provider_error",
	"context-window-exceeded": "context_window",
}

/** How an event leaves this package. Structurally the harness bus's `emit` — see the module header. */
export type PublishTelemetry = (channel: string, data: unknown) => void

export interface TelemetryOptions {
	/** Injected so a test can freeze the one timestamp the log cannot supply (see {@link TelemetryMapper.blocked}). */
	readonly now?: () => Date
	/** Where the single self-disabling warning goes. Default: stderr, tagged. */
	readonly warn?: (message: string) => void
}

/**
 * The pure half: `RunEvent` in, telemetry event out, plus the small amount of per-run state a
 * self-contained event needs (the run's name, and the start timestamps durations are measured from).
 *
 * Stateful but deterministic — no clock, no I/O — so the whole translation is unit-testable by feeding
 * it a sequence of events.
 */
export interface TelemetryMapper {
	/** Translate one event, or return `undefined` for the ones this iteration does not map. */
	observe(event: RunEvent): WorkflowEventPayload | undefined
	/**
	 * Learn from a log read off disk WITHOUT publishing any of it: those events were already reported by
	 * whichever invocation wrote them. This is how a resumed run still knows its workflow name and its
	 * original start time — neither of which `run-resumed` carries.
	 *
	 * Folding a log that overlaps events already observed live is harmless: the fold is idempotent over
	 * any prefix of the same log.
	 */
	seed(events: readonly RunEvent[]): void
	/**
	 * Produce a `run_blocked` payload for a `blocked` result; `undefined` for any other status.
	 *
	 * Blocking is the one run state with no `RunEvent` behind it — it is the absence of a terminal event —
	 * so it is observed where a `RunResult` is, and its timestamp is the only one in the contract that
	 * comes from a clock rather than from the log.
	 */
	blocked(result: RunResult): RunBlockedPayload | undefined
	/** Drop a run's state (its log is gone, spec §6.5). */
	forget(runId: string): void
}

/** A `RunStore` that also publishes what passes through it. */
export interface TelemetryStore extends RunStore {
	/**
	 * Report one execution's outcome (`runGuarded`'s return). Only a `blocked` one publishes anything —
	 * every terminal status already arrived as an event through {@link RunStore.appendEvent}.
	 */
	observeResult(result: RunResult): void
}

/** What a run's events are measured against, and what only its log can tell us. */
interface RunTelemetryState {
	/** From `run-started` — the only event that names the workflow (spec R4's `workflow_name`). */
	workflowName: string
	/** From `run-started`, so a resumed run's duration still spans its whole life, not just this leg. */
	startedAt?: string
	/** Dynamic path → the `step-started` timestamp its completion is measured against. */
	readonly stepStartedAt: Map<string, string>
	/**
	 * Dynamic path → the kind of the last `agent-error` the step recorded. The engine's `step-retry`
	 * says only `agent-error`; the KIND (provider vs context window) lives on the preceding event, which
	 * always lands in the log first — this is how the retry that follows can say `provider_error` or
	 * `context_window` without a separate agent event in the contract.
	 */
	readonly agentErrorKind: Map<string, AgentTurnErrorKind>
}

export function createTelemetryMapper(options: TelemetryOptions = {}): TelemetryMapper {
	const now = options.now ?? (() => new Date())
	// One small record per run this mapper has seen an event for — and a mapper lives for one `/workflow`
	// invocation, which touches a handful of runs at most. The per-STEP maps inside it are what could grow
	// with a run's length, and those are emptied as each step settles and again at the run's terminal event.
	//
	// A terminal event does NOT drop the record: `crashed` and `cancelled` are resumable (spec §5.1), and a
	// resume in this same invocation still needs the workflow's name and the run's original start — the log
	// it re-reads has them, but `run-resumed` does not.
	const states = new Map<string, RunTelemetryState>()

	const stateOf = (runId: string): RunTelemetryState => {
		const existing = states.get(runId)
		if (existing) return existing
		const created: RunTelemetryState = { workflowName: "", stepStartedAt: new Map(), agentErrorKind: new Map() }
		states.set(runId, created)
		return created
	}

	const common = (runId: string, at: string): Omit<WorkflowEventCommon, "event"> => ({
		run_id: runId,
		workflow_name: states.get(runId)?.workflowName ?? "",
		at,
	})

	/**
	 * What a step-scoped payload carries beyond the run fields (spec R4): the leaf name alone. The full
	 * path and its static key are read here for the mapper's own bookkeeping, but do not travel.
	 */
	const stepFields = (runId: string, path: string, at: string): Omit<WorkflowStepEventCommon, "event"> => {
		const parsed = parsePath(path)
		return {
			...common(runId, at),
			step_name: parsed[parsed.length - 1]?.name ?? path,
		}
	}

	const runDuration = (runId: string, at: string): number | undefined => elapsed(states.get(runId)?.startedAt, at)

	/** A step settled: its start and its last agent-error kind no longer need keeping. */
	const settleStep = (runId: string, path: string): string | undefined => {
		const state = states.get(runId)
		if (!state) return undefined
		state.agentErrorKind.delete(path)
		const startedAt = state.stepStartedAt.get(path)
		state.stepStartedAt.delete(path)
		return startedAt
	}

	/**
	 * The run reached a terminal event: nothing is still open, so the per-step bookkeeping goes. The run's
	 * identity stays — see the `states` comment for why a crashed run's name outlives its crash.
	 */
	const settleRun = (runId: string): void => {
		const state = states.get(runId)
		state?.stepStartedAt.clear()
		state?.agentErrorKind.clear()
	}

	const errorOf = (message: string): WorkflowError => ({ message: truncateError(message) })

	/**
	 * The reason a retry travels with. For an agent turn's failed request, the engine's retry says only
	 * `agent-error`; the kind recorded by the preceding `agent-error` event resolves it to
	 * `provider_error` or `context_window`. The fallback is `provider_error` — a failed request is by
	 * definition one of the two, and a kind this mapper never saw recorded means the provider-shaped one.
	 */
	const retryReason = (runId: string, path: string, reason: RetryReason): WorkflowRetryReason => {
		if (reason !== "agent-error") return RETRY_REASONS[reason]
		const kind = states.get(runId)?.agentErrorKind.get(path)
		return kind ? AGENT_REASONS[kind] : "provider_error"
	}

	const observe = (event: RunEvent): WorkflowEventPayload | undefined => {
		switch (event.type) {
			case "run-started": {
				const state = stateOf(event.runId)
				state.workflowName = event.workflowName
				state.startedAt ??= event.at
				return { event: "run_started", ...common(event.runId, event.at) }
			}

			case "run-resumed":
				stateOf(event.runId)
				return { event: "run_resumed", ...common(event.runId, event.at) }

			case "run-completed": {
				const payload: WorkflowEventPayload = {
					event: "run_completed",
					...common(event.runId, event.at),
					duration_ms: runDuration(event.runId, event.at),
				}
				settleRun(event.runId)
				return payload
			}

			case "run-crashed": {
				const payload: WorkflowEventPayload = {
					event: "run_failed",
					...common(event.runId, event.at),
					error: errorOf(event.error),
					duration_ms: runDuration(event.runId, event.at),
				}
				settleRun(event.runId)
				return payload
			}

			case "run-cancelled": {
				const payload: WorkflowEventPayload = {
					event: "run_cancelled",
					...common(event.runId, event.at),
				}
				settleRun(event.runId)
				return payload
			}

			case "step-started":
				stateOf(event.runId).stepStartedAt.set(event.path, event.at)
				return { event: "step_started", ...stepFields(event.runId, event.path, event.at) }

			case "step-retry":
				return {
					event: "step_retried",
					...stepFields(event.runId, event.path, event.at),
					attempt: event.attempt,
					reason: retryReason(event.runId, event.path, event.reason),
					error: errorOf(event.error),
				}

			case "step-completed":
				return {
					event: "step_completed",
					...stepFields(event.runId, event.path, event.at),
					duration_ms: elapsed(settleStep(event.runId, event.path), event.at),
				}

			case "step-failed":
				return {
					event: "step_failed",
					...stepFields(event.runId, event.path, event.at),
					error: errorOf(event.error),
					duration_ms: elapsed(settleStep(event.runId, event.path), event.at),
				}

			case "step-cancelled":
				settleStep(event.runId, event.path)
				return { event: "step_cancelled", ...stepFields(event.runId, event.path, event.at) }

			// Observed for state, published never: the kind it records is what lets the retry that follows
			// say `provider_error` or `context_window` (see `retryReason`). The failure itself reaches the
			// stream as that retry — or, when no retry can clear it, as the step_failed / run_failed after.
			case "agent-error":
				stateOf(event.runId).agentErrorKind.set(event.path, event.kind)
				return undefined

			// Deliberately unmapped, each for its own reason (spec R3):
			//  - `questionnaire-asked` / `answers-provided` are below telemetry's altitude: run-level waiting
			//    is what operators care about, and `run_blocked` → `run_resumed` already carries it;
			//  - `agent-steer` measures the author's prompt and schema complexity, not system health — the
			//    run log keeps every repair with its violation kind for local diagnosis;
			//  - `run-meta` carries a raw filesystem path (revisit with hashing, if dashboards need to tell
			//    two projects' identically-named workflows apart);
			//  - `step-log` is free text the author wrote, and its structured `data` is theirs too (spec R2);
			//  - `agent-usage` waits on a double-counting policy against the harness's own request telemetry;
			//  - node/branch/loop/foreach structure is a run-log analysis, not a telemetry query (spec R4).
			case "questionnaire-asked":
			case "answers-provided":
			case "agent-steer":
			case "run-meta":
			case "step-log":
			case "agent-usage":
			case "node-started":
			case "node-completed":
			case "branch-arm":
			case "loop-iteration":
			case "foreach-started":
			case "foreach-item-started":
			case "foreach-item-completed":
				return undefined
		}
	}

	return {
		observe,

		seed(events: readonly RunEvent[]): void {
			// Same fold, output discarded: seeding differs from observing only in who publishes.
			for (const event of events) observe(event)
		},

		blocked(result: RunResult): RunBlockedPayload | undefined {
			if (result.status !== "blocked") return undefined
			return {
				event: "run_blocked",
				run_id: result.runId,
				workflow_name: states.get(result.runId)?.workflowName ?? "",
				at: now().toISOString(),
			}
		},

		forget(runId: string): void {
			states.delete(runId)
		},
	}
}

/**
 * Milliseconds between two ISO timestamps from the log, or `undefined` when the start is unknown —
 * omitted rather than reported as `0`, which a backend would average as a real duration.
 *
 * Clamped at zero: a run resumed on a different host is measured against another machine's clock, and a
 * negative duration is a worse answer than an implausibly short one.
 */
function elapsed(startedAt: string | undefined, at: string): number | undefined {
	if (startedAt === undefined) return undefined
	const start = Date.parse(startedAt)
	const end = Date.parse(at)
	if (Number.isNaN(start) || Number.isNaN(end)) return undefined
	return Math.max(0, end - start)
}

/**
 * Wrap a store so everything appended through it is also published (spec R5/R6).
 *
 * The decoration is total — all four methods forward — and only two of them do anything extra:
 * `appendEvent` publishes after the write, and `loadEvents` lets the mapper learn from history it must
 * not re-publish.
 */
export function withTelemetry(
	store: RunStore,
	publish: PublishTelemetry,
	options: TelemetryOptions = {},
): TelemetryStore {
	const mapper = createTelemetryMapper(options)
	const warn = options.warn ?? defaultWarn
	let disabled = false

	// One warning, then silence: a subscriber that throws once throws on every event, and a run must not
	// be narrated to death over telemetry it does not need. Nothing in here can reach the caller.
	const attempt = (work: () => void): void => {
		if (disabled) return
		try {
			work()
		} catch (err) {
			disabled = true
			try {
				warn(
					`telemetry publishing disabled after an error (${err instanceof Error ? err.message : String(err)}); the run is unaffected.`,
				)
			} catch {
				// Even the apology is best-effort.
			}
		}
	}

	const emit = (payload: WorkflowEventPayload | undefined): void => {
		if (payload) publish(WORKFLOW_TELEMETRY_CHANNEL, payload)
	}

	return {
		async appendEvent(event: RunEvent): Promise<void> {
			// Persist FIRST: the log is the run's state, and a telemetry failure must not be able to lose an
			// event. A store error propagates untouched, and nothing is published for a write that failed.
			await store.appendEvent(event)
			attempt(() => emit(mapper.observe(event)))
		},

		async loadEvents(runId: string): Promise<RunEvent[]> {
			const events = await store.loadEvents(runId)
			attempt(() => mapper.seed(events))
			return events
		},

		async delete(runId: string): Promise<void> {
			await store.delete(runId)
			attempt(() => mapper.forget(runId))
		},

		list() {
			return store.list()
		},

		observeResult(result: RunResult): void {
			attempt(() => emit(mapper.blocked(result)))
		},
	}
}

function defaultWarn(message: string): void {
	// Not `ctx.ui.notify`: the bridge is wired below the command layer and has no UI of its own, and this
	// fires only for a bug in a subscriber — nothing a user of `/workflow` can act on.
	console.error(`[kimchi-workflows] ${message}`)
}
