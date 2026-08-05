/**
 * Engine-facing types: the run event log and the `HostPort` seam.
 *
 * The engine (run-workflow.ts) imports only from here and from the pure
 * flow types — never from PI, `node:fs`, or any network lib.
 */
import type { TSchema } from "typebox"
import type { Questionnaire } from "../flow/questionnaire.ts"

/** Why a step is being retried (spec §9.2/§9.3). Input-schema violations are never retried. */
export type RetryReason = "thrown-error" | "invalid-output" | "budget-exceeded" | "agent-error"

/**
 * How an agent's reply failed its output contract (spec §9.2) — the classification behind an
 * `agent-steer`, decided where the violation is DETECTED (`checkAgentTurn`) rather than re-derived by
 * matching on the human-readable message it also produces.
 *
 * The message names the specific field and is what the model is corrected with; this is the bounded
 * vocabulary a consumer can count. The distinction matters because these fail for unrelated reasons:
 * `no-submission` is a model that ended its turn without calling the tool at all, `schema-violation` is
 * one that answered in the wrong shape, and `asking-not-allowed` is an author who declared a step that
 * cannot ask questions and prompted it as though it could.
 */
export type AgentOutputViolationKind =
	| "no-submission"
	| "malformed-arguments"
	| "asking-not-allowed"
	| "invalid-questions"
	| "schema-violation"

/**
 * Append-only lifecycle events (spec §8.1, §12.1), each tagged with the run id and an ISO timestamp.
 *
 * Every event that names a step or node carries its `path` — the full DYNAMIC node path (spec §8.5),
 * indices included (`until-valid#3/design`, `batch#7/review`), formatted by `formatPath`
 * (node-path.ts). Under concurrency the log's order is not deterministic (spec §4.2/§8.1), so
 * consumers reconstruct per-step history by path, not by adjacency. This is a P2 log-format change:
 * a log written before this phase has no `path` field and is not readable by this build (no
 * migration, by design) — `parsePath` fails loudly rather than mis-parsing it.
 */
export type RunEvent =
	// Host-written provenance (spec §8.9), appended by the ADAPTER at run start — never by the engine,
	// which stays file-unaware and could not name a `workflowFilePath` if it wanted to. It replaces the
	// `<run-id>.meta.json` sidecar: one file per run, self-describing wherever it is read, and a
	// `/workflow resume` that needs nothing but the log to reload the definition (spec §8.5). Kept
	// separate from `run-started` for exactly that reason — that event is the ENGINE's, and folding a
	// file path into it would put the filesystem inside the engine's vocabulary. Every consumer of the
	// log already ignores it: `deriveStepStates` has a `default: break`, `deriveRunStatus` filters by
	// type, and `summarizeRun` keys off `run-started`.
	| { type: "run-meta"; runId: string; workflowFilePath: string; at: string }
	| { type: "run-started"; runId: string; workflowName: string; input: unknown; at: string }
	// A resume (spec §8) continuing an existing run: appended to the same log instead of a second
	// `run-started`. `fromPath` is the node path execution resumes at (absent if nothing remained).
	| { type: "run-resumed"; runId: string; fromPath?: string; at: string }
	| { type: "step-started"; runId: string; path: string; input: unknown; at: string }
	// A failed attempt is being retried (spec §9.1). `attempt` is the 1-based attempt that just failed.
	| { type: "step-retry"; runId: string; path: string; attempt: number; reason: RetryReason; error: string; at: string }
	// An in-session output-steering correction (spec §9.2): the agent's reply was invalid and a
	// correction was sent within the same session. `attempt` is the 1-based repair number.
	// `violationKind` classifies the failure (`violation` states it); `resumeKey` names the conversation
	// this step continues, when it declared one (spec §2.2) — a repair on a SHARED session is a different
	// fact from one on a cold session, and neither `path` nor `attempt` distinguishes them.
	| {
			type: "agent-steer"
			runId: string
			path: string
			attempt: number
			violation: string
			violationKind: AgentOutputViolationKind
			resumeKey?: string
			at: string
	  }
	// A turn that ended on a FAILED REQUEST rather than on anything the model did (see `AgentTurnError`).
	// Recorded as its own event because the alternative is silence: the provider's message is stated
	// nowhere else the engine can see, and the step failure it causes is otherwise indistinguishable from
	// a model that declined to submit. `attempt` is the step's outer attempt number (as on `step-retry`),
	// not a repair number — a failed request never reaches the repair budget. `terminal` marks a failure
	// no retry can clear: a resumed session whose transcript no longer fits the context window is over,
	// and the run should say so once rather than re-discover it on every later step sharing the session.
	// `resumeKey` is the conversation this step continues, when it declared one (spec §2.2): it is what
	// separates "this SESSION is degrading" — a shared transcript growing past the context window, which
	// every later step keyed to it will hit too — from "this step is hard".
	| {
			type: "agent-error"
			runId: string
			path: string
			attempt: number
			kind: AgentTurnErrorKind
			message: string
			terminal: boolean
			resumeKey?: string
			at: string
	  }
	// One completed agent turn's token usage (spec §9.3), recorded as it happens rather than only summed
	// into a budget check. Without it a run's cost is invisible: the totals a host can see from OUTSIDE
	// (a session file, a provider bill) miss every isolated step entirely, since those run as their own
	// one-shot subprocesses with no session of their own. Emitted per turn — a step that retried or was
	// steered has several — so a consumer sums by `path` for a step, or over the log for a run.
	| { type: "agent-usage"; runId: string; path: string; totalTokens: number; at: string }
	| { type: "step-completed"; runId: string; path: string; output: unknown; at: string }
	// A step declared `optional` failed for good and the run carried on (spec §9.1). Distinct from
	// `run-crashed`: nothing about the RUN ended here, so this records what was lost — the step's output
	// is `undefined` from this point on — without claiming the run stopped.
	| { type: "step-failed"; runId: string; path: string; error: string; at: string }
	// Control-flow node (branch/loop/foreach/workflow, spec §3.2–§3.4, §11) lifecycle. `node-completed`
	// is a resume checkpoint (spec §8): its output feeds the next node and rebuilds context. Emitted for
	// a branch's own node AND for each taken arm (`path` = the arm's own path, spec §8.5's re-entry).
	| {
			type: "node-started"
			runId: string
			path: string
			nodeKind: "branch" | "loop" | "foreach" | "parallel" | "workflow"
			at: string
	  }
	| { type: "node-completed"; runId: string; path: string; output: unknown; at: string }
	// Observability (spec §12): which branch arms were taken (`path` = the ARM's own path — the
	// addressing unit a step inside it nests under, spec §8.5), and each loop iteration as it starts
	// (`path` = that iteration's path, e.g. `until-valid#3`).
	| { type: "branch-arm"; runId: string; path: string; taken: boolean; at: string }
	| { type: "loop-iteration"; runId: string; path: string; iteration: number; at: string }
	// Foreach (spec §3.4). `foreach-item-completed` is the per-item resume checkpoint (spec §8.2): a
	// foreach resumes at the first item with no such event. `count` is the selected length; `path` on
	// `foreach-started` is the foreach's own path (no index), on the item events the item's path (indexed).
	| { type: "foreach-started"; runId: string; path: string; count: number; at: string }
	| { type: "foreach-item-started"; runId: string; path: string; index: number; at: string }
	| { type: "foreach-item-completed"; runId: string; path: string; index: number; output: unknown; at: string }
	| {
			type: "step-log"
			runId: string
			path: string
			level: "info" | "warn" | "error"
			message: string
			data?: Record<string, unknown>
			at: string
	  }
	| { type: "run-completed"; runId: string; output: unknown; at: string }
	// `path` is omitted when the failure is the workflow's own input validation (no step ran yet) or a
	// resume-time definition-drift check (spec §8.7, no single step to attribute to).
	| { type: "run-crashed"; runId: string; path?: string; error: string; at: string }
	// A cooperative cancel (spec §5, §8.6): applied side effects are NOT rolled back; the run is
	// recoverable via resume. `path` is the step the run was cancelled at, if one was executing.
	| { type: "run-cancelled"; runId: string; path?: string; at: string }
	// A Q&A suspension (spec §8.4/§8.5/§10): a step asked a `questions` BATCH → the run is `blocked`.
	// `path` is the step's full node path — legal anywhere (inside a loop, foreach, branch arm, or
	// nested workflow, spec §8.5), not just top-level. `conversation` is the opaque agent history needed
	// to resume the SAME loop (empty for a questionnaire step). `violation` is set only on a RE-block of
	// a questionnaire step: why the delivered answers were rejected (absent on a first ask, and on an
	// agent's ask — which is an intentional question, not a rejection). `elapsedMs`/`tokensUsed` are the
	// per-step budget clock's running totals AT THE MOMENT OF BLOCKING (spec §9.4, agent Q&A steps only):
	// wall time actually spent `in_progress` so far this attempt (blocked spans excluded by construction —
	// nothing samples the clock while there is no code running) and tokens summed across this attempt's
	// turns. An answer-continuation reads these back to carry the budgets forward instead of resetting
	// them, since only a genuinely fresh retry attempt resets a step's budgets (spec §9.1). Absent for a
	// questionnaire step, which has no retry/budget policy at all.
	| {
			type: "questionnaire-asked"
			runId: string
			path: string
			questionnaire: Questionnaire
			conversation: readonly ConversationMessage[]
			violation?: string
			elapsedMs?: number
			tokensUsed?: number
			at: string
	  }
	// The user's structured answers (question `key` → value); resume delivers them back (spec §8.4).
	| { type: "answers-provided"; runId: string; path: string; answers: Record<string, unknown>; at: string }
	// Drain-then-crash (spec §9.5): a SIBLING step crashed elsewhere in the same concurrent construct
	// (`.parallel`/`.foreach`, spec §3.4/§3.5), and this step — `blocked`, waiting on a human — is not
	// drained: its pending question drops and it is recorded `cancelled` directly, rather than waiting
	// indefinitely on an answer that can no longer change a doomed run's outcome. Distinct from the
	// blanket `run-crashed` force-close (which turns a lone open step `crashed`, unchanged since P2):
	// this is scoped to exactly the step being abandoned, emitted BEFORE the run's own `run-crashed`.
	| { type: "step-cancelled"; runId: string; path: string; at: string }

/** One message of an agent conversation. Opaque to the engine — the host defines the concrete shape. */
export type ConversationMessage = unknown

/**
 * What an agent step needs from the host to run (spec §2.2). Model is `provider/modelId`; omit for
 * the session default. `history` seeds a resumed session with the blocked step's prior messages so it
 * continues the same loop (spec §8.4).
 */
export interface AgentRequest {
	readonly model?: string
	readonly history?: readonly ConversationMessage[]
	/** The step this session belongs to. Lets a host attribute cost/telemetry — and lets a test double script replies per step. */
	readonly stepName: string
	/**
	 * Which run, and which execution within it, this session belongs to (spec §8.5/§8.9).
	 *
	 * The engine needs none of it — it is passed because a host that PERSISTS a session has to name the
	 * file, and only these four make a name that is both unique and readable: two executions of one step
	 * differ by `attempt`, two items of a `.foreach` differ by `path` (the full dynamic node path, indices
	 * included — `stepName` alone is the same string for all of them), and two runs of one workflow differ
	 * by `runId`. A host that keeps nothing (the test double, an in-memory host) simply ignores them.
	 */
	readonly runId: string
	readonly workflowName: string
	readonly path: string
	/** 1-based retry attempt (spec §9.1) this session was opened for; an answer-continuation stays on the attempt it resumes. */
	readonly attempt: number
	/**
	 * True for a `background` agent step (spec §2.2): the host must run this as an isolated PI subagent
	 * — its own context window and tool loop, no access to the parent session's history — rather than
	 * continuing whatever session ordinary agent steps use. `history` is always undefined alongside this:
	 * a background step can never be Q&A-capable (`.commit()` rejects `background` + `asks`, spec
	 * §10.1), so it never blocks and is never resumed with a seeded conversation.
	 */
	readonly background?: boolean
	/**
	 * True when this step CAN run concurrently with another agent step — inside a `.parallel` arm, or
	 * inside a `.foreach` whose declared concurrency exceeds 1 — decided **statically** from the workflow
	 * definition and tagged onto the step at `.commit()` (spec §2.2 "Overlap implies isolation",
	 * `flow/isolation.ts`), never from what happens to be in flight. Independent of `background`: a step
	 * can be `isolated` without being `background`
	 * (an ordinary agent step that merely happens to sit in a fan-out), and a host must treat the two as
	 * the same instruction — run this isolated, exactly like `background` — even though they arise for
	 * different reasons. A session hosts one conversation at a time, so a host MUST route an `isolated`
	 * (or `background`) request through its isolated/subagent path (spec §12.2) rather than the shared
	 * in-session one; sharing one session between two turns that can overlap is exactly the cross-talk
	 * spec §2.2 exists to rule out.
	 */
	readonly isolated?: boolean
	/**
	 * A stable identity for a conversation this step CONTINUES across separate executions (spec §2.2).
	 *
	 * An isolated step is a one-shot subprocess, so by default every execution of it starts cold — which
	 * is right for a verifier (fresh eyes are the point) and wrong for a worker that was interrupted:
	 * a step time-boxed out of one round and re-run in the next re-derives everything it already knew.
	 * When this is set, a host that runs the step out-of-process is asked to persist the conversation
	 * under this key and resume it next time, so the second execution continues the first.
	 *
	 * Set from `AgentStep.resumable`; absent otherwise, which keeps the default behaviour (and the small,
	 * cheap contexts that make a chain of isolated steps far cheaper than one long session).
	 */
	readonly resumeKey?: string
	/**
	 * The step's declared output contract, when it has one (spec §9.2).
	 *
	 * Passed so a host that runs this request out-of-process can register a `submit_result` tool typed by
	 * it inside that process — the payload then travels as a tool call, which a later message cannot
	 * displace. A host with nowhere to register tools leaves this undefined, and every step under a
	 * contract then fails — there is no text channel behind it.
	 */
	readonly outputSchema?: TSchema
	/** True when the step may answer with a questionnaire instead of a result (spec §10.1) — enables `submit_questions`. */
	readonly asks?: boolean
	/**
	 * The attempt's abort signal — the run's cancel signal (spec §8.8) combined with the step's wall-time
	 * budget (spec §9.4). A host that runs this request as an out-of-process subagent MUST honour it, or
	 * the two mechanisms become lies: `/workflow cancel` would report a stopped run while its subagent
	 * kept spending tokens and writing files, and a budget would fail the attempt while orphaning the
	 * process it was meant to bound. Worse, with no budget declared — the default — an unresponsive
	 * subagent would hang the run with nothing able to interrupt it. The in-session path needs nothing
	 * here: the engine already stops at turn boundaries, and that session belongs to PI, not to us.
	 */
	readonly signal?: AbortSignal
}

/** Token usage reported by a single agent turn (spec §9.3). */
export interface TokenUsage {
	readonly totalTokens: number
}

/** A `submit_*` tool call the agent made, as seen in the turn's transcript. */
export interface SubmittedOutput {
	/** Which output tool was called — the discriminator (see engine/output-tools.ts). */
	readonly tool: string
	/** The call's arguments, already an object (`ToolCall.arguments`); no JSON extraction involved. */
	readonly arguments: Record<string, unknown>
}

/**
 * Why a turn produced nothing, when the reason was the provider rather than the model.
 *
 * A refused request still completes a turn: the harness records an assistant message with no content
 * and ends the loop, so from the outside it is shaped exactly like a model that declined to submit.
 * Without this distinction the engine reports "the turn ended without calling submit_result" — blaming
 * a model that was never asked — and spends a repair turn correcting an omission that never happened.
 *
 *  - `context-window-exceeded` — the request was larger than the model's context. Terminal for a session
 *    that is RESUMED (spec §2.2's `resumable`): every later turn re-sends the same transcript plus more,
 *    so it can only fail again. A non-resumable step gets a new session file per attempt, so a retry
 *    there is a genuinely different request.
 *  - `provider-error` — anything else the provider refused or failed on. Retryable like a thrown error.
 */
export type AgentTurnErrorKind = "context-window-exceeded" | "provider-error"

/** A turn that ended because the request failed, not because the model chose what to say. */
export interface AgentTurnError {
	readonly kind: AgentTurnErrorKind
	/** The provider's own message, verbatim — the only place the real cause is stated. */
	readonly message: string
}

/** The result of one agent turn: the final assistant text plus optional token usage for budgeting. */
export interface AgentTurn {
	readonly text: string
	readonly usage?: TokenUsage
	/**
	 * The last `submit_*` call of the turn, if any — the ONLY channel a step under a contract reports
	 * through, since a later message cannot displace a tool call. A step with no `outputSchema` has no
	 * contract to submit against and reports its text instead, so this is ignored there.
	 */
	readonly submitted?: SubmittedOutput
	/**
	 * Set when the turn ended on a failed request. The engine treats it as a failure of the ATTEMPT, not
	 * of the reply: no steering correction is sent, because there is no reply to correct.
	 */
	readonly error?: AgentTurnError
}

/**
 * A single agent conversation opened by the host. The engine sends the built prompt and awaits the
 * agent loop's end, receiving the turn's submission + optional usage (which it validates against the
 * step's schema and sums against `maxTokens`). All network and PI coupling lives behind this seam.
 */
export interface AgentSession {
	/** Send `message`, run the agent loop to `agent_end`, and resolve with the turn's submission + usage. */
	sendAndAwaitEnd(message: string): Promise<AgentTurn>
	/** The full conversation after the last turn — captured when a Q&A step blocks, to resume it (spec §8.4). */
	getConversation(): readonly ConversationMessage[]
	/** Release any listeners/resources for this session. Called by the engine in a `finally`. */
	dispose(): void
}

/**
 * The one seam the engine depends on. A host adapter (or a fake, in tests) implements this to
 * supply the non-deterministic engine inputs (run identity, time, waiting, agent runs) and to
 * receive the event stream; it decides what to do with events (persist, print, collect in memory).
 */
export interface HostPort {
	/** Generate a unique id for a new run. */
	generateRunId(): string
	/** Current time. Engine calls this once per emitted event/checkpoint. */
	now(): Date
	/**
	 * Wait `ms` milliseconds — the engine's only source of delay (retry backoff, time-budget timers).
	 * If `signal` aborts first, resolve early (so a completed step can cancel its budget timer). Keeps
	 * the engine pure + fast in tests.
	 */
	sleep(ms: number, signal?: AbortSignal): Promise<void>
	/** Open an agent conversation (spec §2.2). Hosts without agent support throw here; function steps never call it. */
	startAgent(request: AgentRequest): AgentSession
	/** Receive a lifecycle event, in emission order. */
	emit(event: RunEvent): void | Promise<void>
}

/** Per-invocation run options (spec §8.6): an external `AbortSignal` for cooperative cancellation. */
export interface RunOptions {
	/** When aborted, the engine stops at the next step boundary and marks the run `cancelled`. */
	signal?: AbortSignal
}

/**
 * Outcome of a single run/resume call (spec §5.1). Only `completed` is terminal; `crashed`,
 * `cancelled`, and `blocked` are resumable. `blocked` carries the pending `questionnaire` + `path`.
 */
export interface RunResult {
	readonly runId: string
	readonly status: "completed" | "crashed" | "cancelled" | "blocked"
	readonly output?: unknown
	readonly error?: string
	/** Present when `blocked`: the questionnaire batch the step asked, and the step that asked it. */
	readonly questionnaire?: Questionnaire
	/** The step's full node path (spec §8.5) — present when `blocked`, and when `crashed`/`cancelled` named a step. */
	readonly path?: string
	/** Present when a questionnaire step RE-blocked: why the delivered answers were rejected (spec §2.4). */
	readonly violation?: string
}
