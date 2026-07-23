/**
 * Engine-facing types: the run event log and the `HostPort` seam.
 *
 * The engine (run-workflow.ts) imports only from here and from the pure
 * flow types — never from PI, `node:fs`, or any network lib.
 */
import type { Questionnaire } from "../flow/questionnaire.ts";

/** Why a step is being retried (spec §9.2/§9.3). Input-schema violations are never retried. */
export type RetryReason = "thrown-error" | "invalid-output" | "budget-exceeded";

/** Append-only lifecycle events (spec §8.1, §12.1), each tagged with the run id and an ISO timestamp. */
export type RunEvent =
  | { type: "run-started"; runId: string; workflowName: string; input: unknown; time: string }
  // A resume (spec §8) continuing an existing run: appended to the same log instead of a second
  // `run-started`. `fromStepName` is the step execution resumes at (absent if nothing remained).
  | { type: "run-resumed"; runId: string; fromStepName?: string; time: string }
  | { type: "step-started"; runId: string; stepIndex: number; stepName: string; input: unknown; time: string }
  // A failed attempt is being retried (spec §9.1). `attempt` is the 1-based attempt that just failed.
  | { type: "step-retry"; runId: string; stepName: string; attempt: number; reason: RetryReason; error: string; time: string }
  // An in-session output-steering correction (spec §9.2): the agent's reply was invalid and a
  // correction was sent within the same session. `attempt` is the 1-based repair number.
  | { type: "agent-steer"; runId: string; stepName: string; attempt: number; violation: string; time: string }
  | { type: "step-completed"; runId: string; stepIndex: number; stepName: string; output: unknown; time: string }
  // Control-flow node (branch/loop/foreach, spec §3.2–§3.4) lifecycle. `node-completed` is the
  // node-atomic resume checkpoint (spec §8): its output feeds the next node and rebuilds context.
  | { type: "node-started"; runId: string; nodeName: string; nodeKind: "branch" | "loop" | "foreach" | "workflow"; time: string }
  | { type: "node-completed"; runId: string; nodeName: string; output: unknown; time: string }
  // Observability (spec §12): which branch arms were taken, and each loop iteration as it starts.
  | { type: "branch-arm"; runId: string; nodeName: string; armName: string; taken: boolean; time: string }
  | { type: "loop-iteration"; runId: string; nodeName: string; iteration: number; time: string }
  // Foreach (spec §3.4). `foreach-item-completed` is the per-item resume checkpoint (spec §8): a
  // top-level foreach resumes at the first item with no such event. `count` is the selected length.
  | { type: "foreach-started"; runId: string; nodeName: string; count: number; time: string }
  | { type: "foreach-item-started"; runId: string; nodeName: string; index: number; time: string }
  | { type: "foreach-item-completed"; runId: string; nodeName: string; index: number; output: unknown; time: string }
  | {
      type: "step-log";
      runId: string;
      stepName: string;
      level: "info" | "warn" | "error";
      message: string;
      data?: Record<string, unknown>;
      time: string;
    }
  | { type: "run-completed"; runId: string; output: unknown; time: string }
  // `stepName` is omitted when the failure is the workflow's own input validation (no step ran yet).
  | { type: "run-crashed"; runId: string; stepName?: string; error: string; time: string }
  // A cooperative cancel (spec §5, §8.6): applied side effects are NOT rolled back; the run is
  // recoverable via resume. `stepName` is the step the run was cancelled at, if one was executing.
  | { type: "run-cancelled"; runId: string; stepName?: string; time: string }
  // A Q&A suspension (spec §8.4/§10): a step asked a `questionnaire` BATCH → the run is `parked`.
  // `conversation` is the opaque agent history needed to resume the SAME loop (empty for form input).
  // `violation` is set only on a RE-park of a form input step: why the delivered answers were rejected
  // (absent on a first ask, and on an agent's ask — which is an intentional question, not a rejection).
  | { type: "questionnaire-asked"; runId: string; stepName: string; questionnaire: Questionnaire; conversation: readonly ConversationMessage[]; violation?: string; time: string }
  // The user's structured answers (question `key` → value); resume delivers them back (spec §8.4).
  | { type: "answers-provided"; runId: string; stepName: string; answers: Record<string, unknown>; time: string };

/** One message of an agent conversation. Opaque to the engine — the host defines the concrete shape. */
export type ConversationMessage = unknown;

/**
 * What an agent step needs from the host to run (spec §2.2). Model is `provider/modelId`; omit for
 * the session default. `history` seeds a resumed session with the parked step's prior messages so it
 * continues the same loop (spec §8.4).
 */
export interface AgentRequest {
  readonly model?: string;
  readonly history?: readonly ConversationMessage[];
  /** The step this session belongs to. Lets a host attribute cost/telemetry — and lets a test double script replies per step. */
  readonly stepName: string;
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
  /** The full conversation after the last turn — captured when a Q&A step parks, to resume it (spec §8.4). */
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
 * `cancelled`, and `parked` are resumable. `parked` carries the pending `questionnaire` + `stepName`.
 */
export interface RunResult {
  readonly runId: string;
  readonly status: "completed" | "crashed" | "cancelled" | "parked";
  readonly output?: unknown;
  readonly error?: string;
  /** Present when `parked`: the questionnaire batch the step asked, and the step that asked it. */
  readonly questionnaire?: Questionnaire;
  readonly stepName?: string;
  /** Present when a form input step RE-parked: why the delivered answers were rejected (spec §2.4). */
  readonly violation?: string;
}
