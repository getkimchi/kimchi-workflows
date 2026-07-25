/**
 * Engine-facing types: the run event log and the `HostPort` seam.
 *
 * The engine (run-workflow.ts) imports only from here and from the pure
 * flow types — never from PI, `node:fs`, or any network lib.
 */
import type { Questionnaire } from "../flow/questionnaire.ts";

/** Why a step is being retried (spec §9.2/§9.3). Input-schema violations are never retried. */
export type RetryReason = "thrown-error" | "invalid-output" | "budget-exceeded";

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
  | { type: "run-started"; runId: string; workflowName: string; input: unknown; at: string }
  // A resume (spec §8) continuing an existing run: appended to the same log instead of a second
  // `run-started`. `fromPath` is the node path execution resumes at (absent if nothing remained).
  | { type: "run-resumed"; runId: string; fromPath?: string; at: string }
  | { type: "step-started"; runId: string; path: string; input: unknown; at: string }
  // A failed attempt is being retried (spec §9.1). `attempt` is the 1-based attempt that just failed.
  | { type: "step-retry"; runId: string; path: string; attempt: number; reason: RetryReason; error: string; at: string }
  // An in-session output-steering correction (spec §9.2): the agent's reply was invalid and a
  // correction was sent within the same session. `attempt` is the 1-based repair number.
  | { type: "agent-steer"; runId: string; path: string; attempt: number; violation: string; at: string }
  | { type: "step-completed"; runId: string; path: string; output: unknown; at: string }
  // Control-flow node (branch/loop/foreach/workflow, spec §3.2–§3.4, §11) lifecycle. `node-completed`
  // is a resume checkpoint (spec §8): its output feeds the next node and rebuilds context. Emitted for
  // a branch's own node AND for each taken arm (`path` = the arm's own path, spec §8.5's re-entry).
  | { type: "node-started"; runId: string; path: string; nodeKind: "branch" | "loop" | "foreach" | "parallel" | "workflow"; at: string }
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
      type: "step-log";
      runId: string;
      path: string;
      level: "info" | "warn" | "error";
      message: string;
      data?: Record<string, unknown>;
      at: string;
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
      type: "questionnaire-asked";
      runId: string;
      path: string;
      questionnaire: Questionnaire;
      conversation: readonly ConversationMessage[];
      violation?: string;
      elapsedMs?: number;
      tokensUsed?: number;
      at: string;
    }
  // The user's structured answers (question `key` → value); resume delivers them back (spec §8.4).
  | { type: "answers-provided"; runId: string; path: string; answers: Record<string, unknown>; at: string }
  // Drain-then-crash (spec §9.5): a SIBLING step crashed elsewhere in the same concurrent construct
  // (`.parallel`/`.foreach`, spec §3.4/§3.5), and this step — `blocked`, waiting on a human — is not
  // drained: its pending question drops and it is recorded `cancelled` directly, rather than waiting
  // indefinitely on an answer that can no longer change a doomed run's outcome. Distinct from the
  // blanket `run-crashed` force-close (which turns a lone open step `crashed`, unchanged since P2):
  // this is scoped to exactly the step being abandoned, emitted BEFORE the run's own `run-crashed`.
  | { type: "step-cancelled"; runId: string; path: string; at: string };

/** One message of an agent conversation. Opaque to the engine — the host defines the concrete shape. */
export type ConversationMessage = unknown;

/**
 * What an agent step needs from the host to run (spec §2.2). Model is `provider/modelId`; omit for
 * the session default. `history` seeds a resumed session with the blocked step's prior messages so it
 * continues the same loop (spec §8.4).
 */
export interface AgentRequest {
  readonly model?: string;
  readonly history?: readonly ConversationMessage[];
  /** The step this session belongs to. Lets a host attribute cost/telemetry — and lets a test double script replies per step. */
  readonly stepName: string;
  /**
   * True for a `background` agent step (spec §2.2): the host must run this as an isolated PI subagent
   * — its own context window and tool loop, no access to the parent session's history — rather than
   * continuing whatever session ordinary agent steps use. `history` is always undefined alongside this:
   * a background step can never be Q&A-capable (`.commit()` rejects `background` + `asks`, spec
   * §10.1), so it never blocks and is never resumed with a seeded conversation.
   */
  readonly background?: boolean;
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
  readonly isolated?: boolean;
}

/** Token usage reported by a single agent turn (spec §9.3). */
export interface TokenUsage {
  readonly totalTokens: number;
}

/** The result of one agent turn: the final assistant text plus optional token usage for budgeting. */
export interface AgentTurn {
  readonly text: string;
  readonly usage?: TokenUsage;
}

/**
 * A single agent conversation opened by the host. The engine sends the built prompt and awaits the
 * agent loop's end, receiving the final assistant text + optional usage (which it parses/validates
 * and sums against `maxTokens`). All network and PI coupling lives behind this seam.
 */
export interface AgentSession {
  /** Send `message`, run the agent loop to `agent_end`, and resolve with the final assistant text + usage. */
  sendAndAwaitEnd(message: string): Promise<AgentTurn>;
  /** The full conversation after the last turn — captured when a Q&A step blocks, to resume it (spec §8.4). */
  getConversation(): readonly ConversationMessage[];
  /** Release any listeners/resources for this session. Called by the engine in a `finally`. */
  dispose(): void;
}

/**
 * The one seam the engine depends on. A host adapter (or a fake, in tests) implements this to
 * supply the non-deterministic engine inputs (run identity, time, waiting, agent runs) and to
 * receive the event stream; it decides what to do with events (persist, print, collect in memory).
 */
export interface HostPort {
  /** Generate a unique id for a new run. */
  generateRunId(): string;
  /** Current time. Engine calls this once per emitted event/checkpoint. */
  now(): Date;
  /**
   * Wait `ms` milliseconds — the engine's only source of delay (retry backoff, time-budget timers).
   * If `signal` aborts first, resolve early (so a completed step can cancel its budget timer). Keeps
   * the engine pure + fast in tests.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Open an agent conversation (spec §2.2). Hosts without agent support throw here; function steps never call it. */
  startAgent(request: AgentRequest): AgentSession;
  /** Receive a lifecycle event, in emission order. */
  emit(event: RunEvent): void | Promise<void>;
}

/** Per-invocation run options (spec §8.6): an external `AbortSignal` for cooperative cancellation. */
export interface RunOptions {
  /** When aborted, the engine stops at the next step boundary and marks the run `cancelled`. */
  signal?: AbortSignal;
}

/**
 * Outcome of a single run/resume call (spec §5.1). Only `completed` is terminal; `crashed`,
 * `cancelled`, and `blocked` are resumable. `blocked` carries the pending `questionnaire` + `path`.
 */
export interface RunResult {
  readonly runId: string;
  readonly status: "completed" | "crashed" | "cancelled" | "blocked";
  readonly output?: unknown;
  readonly error?: string;
  /** Present when `blocked`: the questionnaire batch the step asked, and the step that asked it. */
  readonly questionnaire?: Questionnaire;
  /** The step's full node path (spec §8.5) — present when `blocked`, and when `crashed`/`cancelled` named a step. */
  readonly path?: string;
  /** Present when a questionnaire step RE-blocked: why the delivered answers were rejected (spec §2.4). */
  readonly violation?: string;
}
