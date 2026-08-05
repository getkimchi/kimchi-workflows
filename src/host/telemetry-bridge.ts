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
import { parsePath, staticKeyOf } from "../engine/node-path.ts"
import type { RunEvent, RunResult } from "../engine/types.ts"
import {
	type AgentErrorPayload,
	type AgentSteeredPayload,
	type AnswersProvidedPayload,
	type QuestionnaireAskedPayload,
	type RunBlockedPayload,
	truncateError,
	WORKFLOW_TELEMETRY_CHANNEL,
	type WorkflowEventCommon,
	type WorkflowEventPayload,
	type WorkflowStepEventCommon,
} from "./telemetry-events.ts"
import type { RunStore } from "./types.ts"

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
	/** Static keys of the steps currently blocked on questions — `run_blocked`'s count (spec §8.6). */
	readonly pending: Set<string>
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
		const created: RunTelemetryState = { workflowName: "", stepStartedAt: new Map(), pending: new Set() }
		states.set(runId, created)
		return created
	}

	const common = (runId: string, at: string): Omit<WorkflowEventCommon, "event"> => ({
		run_id: runId,
		workflow_name: states.get(runId)?.workflowName ?? "",
		at,
	})

	/** The three correlation fields every step-scoped payload carries (spec R4). */
	const stepFields = (runId: string, path: string, at: string): Omit<WorkflowStepEventCommon, "event"> => {
		const parsed = parsePath(path)
		return {
			...common(runId, at),
			path,
			static_key: staticKeyOf(parsed),
			step_name: parsed[parsed.length - 1]?.name ?? path,
		}
	}

	const runDuration = (runId: string, at: string): number | undefined => elapsed(states.get(runId)?.startedAt, at)

	/** A step settled: its start no longer needs keeping, and it is no longer waiting on anyone. */
	const settleStep = (runId: string, path: string): string | undefined => {
		const state = states.get(runId)
		if (!state) return undefined
		state.pending.delete(staticKeyOf(parsePath(path)))
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
		state?.pending.clear()
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
				return { event: "run_resumed", ...common(event.runId, event.at), from_path: event.fromPath }

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
					event: "run_crashed",
					...common(event.runId, event.at),
					path: event.path,
					error: truncateError(event.error),
					duration_ms: runDuration(event.runId, event.at),
				}
				settleRun(event.runId)
				return payload
			}

			case "run-cancelled": {
				const payload: WorkflowEventPayload = {
					event: "run_cancelled",
					...common(event.runId, event.at),
					path: event.path,
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
					reason: event.reason,
					error: truncateError(event.error),
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
					error: truncateError(event.error),
					duration_ms: elapsed(settleStep(event.runId, event.path), event.at),
				}

			case "step-cancelled":
				settleStep(event.runId, event.path)
				return { event: "step_cancelled", ...stepFields(event.runId, event.path, event.at) }

			case "questionnaire-asked": {
				stateOf(event.runId).pending.add(staticKeyOf(parsePath(event.path)))
				const payload: QuestionnaireAskedPayload = {
					event: "questionnaire_asked",
					...stepFields(event.runId, event.path, event.at),
					question_count: event.questionnaire.questions.length,
				}
				return payload
			}

			case "answers-provided": {
				states.get(event.runId)?.pending.delete(staticKeyOf(parsePath(event.path)))
				const payload: AnswersProvidedPayload = {
					event: "answers_provided",
					...stepFields(event.runId, event.path, event.at),
					answer_count: Object.keys(event.answers).length,
				}
				return payload
			}

			case "agent-error": {
				const payload: AgentErrorPayload = {
					event: "agent_error",
					...stepFields(event.runId, event.path, event.at),
					resume_key: event.resumeKey,
					attempt: event.attempt,
					kind: event.kind,
					terminal: event.terminal,
					error: truncateError(event.message),
				}
				return payload
			}

			case "agent-steer": {
				const payload: AgentSteeredPayload = {
					event: "agent_steered",
					...stepFields(event.runId, event.path, event.at),
					resume_key: event.resumeKey,
					attempt: event.attempt,
					violation_kind: event.violationKind,
				}
				return payload
			}

			// Deliberately unmapped in this iteration, each for its own reason (spec R3):
			//  - `run-meta` carries a raw filesystem path (revisit with hashing, if dashboards need to tell
			//    two projects' identically-named workflows apart);
			//  - `step-log` is free text the author wrote, and its structured `data` is theirs too (spec R2);
			//  - `agent-usage` waits on a double-counting policy against the harness's own request telemetry;
			//  - node/branch/loop/foreach structure is already reconstructable from every step event's `path`.
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
			const state = states.get(result.runId)
			return {
				event: "run_blocked",
				run_id: result.runId,
				workflow_name: state?.workflowName ?? "",
				at: now().toISOString(),
				// The state's count is the authority (every blocked step, spec §8.6); the reported result is
				// the fallback for a block this mapper never saw the question for.
				pending_questionnaires: state?.pending.size ?? (result.questionnaire ? 1 : 0),
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
