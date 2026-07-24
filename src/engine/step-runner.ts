/**
 * Runs a single step to a validated output under its unified retry policy (spec §9), per-step budgets
 * (time + tokens, spec §9.3), and — for agent steps — in-session output steering (spec §9.2) and Q&A
 * suspension (spec §10). Pure w.r.t. the engine boundary: all agent/network coupling is behind
 * `host.startAgent`; all delay (backoff + budget timers) is `host.sleep`.
 */
import { buildAskingProtocol, formatAnswers, type Questionnaire } from "../flow/questionnaire.ts";
import type { AgentStep, FunctionStep, RetryPolicy, RunContext, StepLogger } from "../flow/types.ts";
import { describeSchemaViolations } from "../flow/validation.ts";
import { buildCorrectionMessage, buildQaSchema, validateAgentOutput, validateQaOutput } from "./agent-output.ts";
import { createRunContext, createStepLogger, iso, type RunState, type StepOutcome } from "./context.ts";
import type { NodePath } from "./node-path.ts";
import type { AgentTurn, HostPort, RetryReason } from "./types.ts";

/** Default in-session output-steering budget (spec §9.2) when an agent step declares none. */
const DEFAULT_MAX_OUTPUT_REPAIRS = 2;

/** Fields the retry loop / budget wrapper need from any step. */
interface BudgetedStep {
  readonly name: string;
  readonly retry?: RetryPolicy;
  readonly maxDurationMs?: number;
}

/**
 * How an agent step's conversation begins: a `fresh` run builds the prompt from input+context; an
 * `answer` resume (spec §8.4) seeds the session with the blocked conversation and replays the user's
 * structured answers as the next turn.
 */
export type AgentEntry = { kind: "fresh" } | { kind: "answer"; answers: Record<string, unknown>; conversation: readonly unknown[] };

/**
 * Outcome of a single attempt:
 *  - `ok`        — produced schema-valid output;
 *  - `retryable` — a failure the retry policy may re-attempt (thrown error / invalid function output /
 *                  agent transport error / budget exceeded, spec §9.3; also a `background` step's
 *                  invalid output, which has no steering budget to exhaust first, spec §9.2);
 *  - `fatal`     — a non-retryable failure (a non-background agent whose output stays invalid after
 *                  steering);
 *  - `blocked`    — a Q&A step emitted a `{questions}` batch (spec §10);
 *  - `cancelled` — the abort signal fired.
 */
type AttemptResult =
  | { kind: "ok"; output: unknown }
  | { kind: "retryable"; reason: RetryReason; error: string }
  | { kind: "fatal"; error: string }
  | { kind: "blocked"; questionnaire: Questionnaire; conversation: readonly unknown[] }
  | { kind: "cancelled" };

/** Run a function step under its retry + time budget (spec §9). Emits `step-retry`; the caller emits step lifecycle. */
export async function runFunctionStep(
  step: FunctionStep,
  input: unknown,
  host: HostPort,
  state: RunState,
  signal: AbortSignal,
  parentPath: NodePath,
  path: string,
): Promise<StepOutcome> {
  const ctx = createRunContext(state, parentPath);
  const logger = createStepLogger(host, state.runId, path);
  return retryLoop(step, host, state, signal, path, (sig) => runFunctionAttempt(step, input, ctx, logger, sig));
}

/**
 * Run an agent step under its retry policy (spec §9), budgets (time + tokens, §9.3), steering (§9.2),
 * and Q&A (§10). `entry` selects a fresh run or an answer-resume that continues the same loop (§8.4).
 * Emits `step-retry`/`agent-steer`; the caller emits step lifecycle + `questionnaire-asked`.
 */
export async function runAgentStep(
  step: AgentStep,
  input: unknown,
  host: HostPort,
  state: RunState,
  signal: AbortSignal,
  parentPath: NodePath,
  path: string,
  entry: AgentEntry,
): Promise<StepOutcome> {
  const ctx = createRunContext(state, parentPath);
  return retryLoop(step, host, state, signal, path, (sig) => runAgentSession(step, input, host, ctx, state, sig, path, entry));
}

/** Shared retry loop (spec §9): wrap each attempt in the time budget, re-attempt `retryable` failures within budget. */
async function retryLoop(
  step: BudgetedStep,
  host: HostPort,
  state: RunState,
  runSignal: AbortSignal,
  path: string,
  attempt: (signal: AbortSignal) => Promise<AttemptResult>,
): Promise<StepOutcome> {
  const totalAttempts = Math.max(1, (step.retry?.maxRetry ?? 0) + 1);
  const backoffMs = step.retry?.backoffMs ?? 0;
  let lastError = "";

  for (let n = 1; n <= totalAttempts; n++) {
    if (runSignal.aborted) return { kind: "cancelled" };

    const result = await withTimeBudget(step, host, runSignal, attempt);
    if (result.kind === "cancelled") return { kind: "cancelled" };
    if (result.kind === "ok") return { kind: "ok", output: result.output };
    if (result.kind === "blocked") return { kind: "blocked", questionnaire: result.questionnaire, conversation: result.conversation };
    if (result.kind === "fatal") return { kind: "crashed", error: result.error };

    // Retryable failure (thrown / invalid output / budget exceeded): re-attempt if budget remains.
    lastError = result.error;
    if (await retryScheduled(host, state.runId, path, n, totalAttempts, backoffMs, result.reason, result.error)) continue;
    return { kind: "crashed", error: lastError };
  }

  return { kind: "crashed", error: lastError || "retry loop exited without a result" };
}

/**
 * Enforce a step's wall-time budget (spec §9.3): race the attempt against a `host.sleep` timer whose
 * signal is combined with the run's cancel signal. On timeout, abort the step (cooperatively) and
 * fail with a retryable `budget-exceeded`. Without a budget, the step just gets the run signal.
 */
async function withTimeBudget(step: BudgetedStep, host: HostPort, runSignal: AbortSignal, attempt: (signal: AbortSignal) => Promise<AttemptResult>): Promise<AttemptResult> {
  if (step.maxDurationMs === undefined) {
    return attempt(runSignal);
  }

  const timeout = new AbortController();
  const cleanup = new AbortController();
  const attemptPromise = attempt(anySignal([runSignal, timeout.signal]));
  const timerPromise = host.sleep(step.maxDurationMs, cleanup.signal).then((): "timeout" => "timeout");

  const outcome = await Promise.race([attemptPromise, timerPromise]);
  if (outcome === "timeout") {
    timeout.abort(); // ask the running step to stop at its next safe point (spec §8.6)
    void attemptPromise.catch(() => {}); // swallow the abandoned step's eventual rejection
    return { kind: "retryable", reason: "budget-exceeded", error: `step "${step.name}" exceeded its ${step.maxDurationMs}ms time budget` };
  }
  cleanup.abort(); // the step finished first — cancel the timer so it does not linger
  return outcome;
}

async function runFunctionAttempt(step: FunctionStep, input: unknown, ctx: RunContext, logger: StepLogger, signal: AbortSignal): Promise<AttemptResult> {
  let output: unknown;
  try {
    output = await step.run({ input, ctx, abortSignal: signal, logger });
  } catch (err) {
    if (signal.aborted) return { kind: "cancelled" }; // a throw while cancelling is a cooperative stop
    return { kind: "retryable", reason: "thrown-error", error: err instanceof Error ? err.message : String(err) };
  }

  if (step.outputSchema) {
    const violation = describeSchemaViolations(step.outputSchema, output);
    if (violation) {
      if (signal.aborted) return { kind: "cancelled" };
      return { kind: "retryable", reason: "invalid-output", error: `step "${step.name}" output: ${violation}` };
    }
  }
  return { kind: "ok", output };
}

/**
 * One agent attempt: open a session (seeded with `entry` history), send the first message (prompt or
 * answer), and steer within the same session on invalid output up to `maxOutputRepairs` (spec §9.2).
 * Token usage is summed across turns; exceeding `maxTokens` → retryable `budget-exceeded` (§9.3). A
 * Q&A `{questions}` → `blocked` (§10); steering exhausted → `fatal`; transport error → `retryable`.
 *
 * When `asks`, the framework owns the questionnaire schema: the reply union is `{result}|{questions}`
 * and the asking protocol is auto-injected into the fresh prompt (so the author's prompt is task-only).
 *
 * When `background`, there is no steering budget at all (§9.2): invalid output → `retryable`, not
 * `fatal` — falling back to the repeat policy is the only recourse a one-shot subagent has.
 */
async function runAgentSession(
  step: AgentStep,
  input: unknown,
  host: HostPort,
  ctx: RunContext,
  state: RunState,
  signal: AbortSignal,
  path: string,
  entry: AgentEntry,
): Promise<AttemptResult> {
  const model = step.model ?? state.defaultModel; // step → workflow default; host applies the session default when undefined (spec §9.5)
  // A `background` step is a one-shot PI subagent (spec §2.2/§9.2, see src/host/pi-agent.ts): there is
  // no resumable conversation to steer, so its repair budget is forced to 0 regardless of what the step
  // itself declares — the loop below then runs exactly one turn before it must succeed or fail outright.
  const maxRepairs = step.background ? 0 : Math.max(0, step.maxOutputRepairs ?? DEFAULT_MAX_OUTPUT_REPAIRS);
  const steerSchema = step.asks ? buildQaSchema(step.outputSchema) : step.outputSchema;
  const history = entry.kind === "answer" ? entry.conversation : undefined;
  const session = host.startAgent({ model, history, stepName: step.name, background: step.background });

  try {
    let message = entry.kind === "answer" ? formatAnswers(entry.answers) : freshPrompt(step, input, ctx);
    let lastViolation = "";
    let totalTokens = 0;

    for (let repair = 0; repair <= maxRepairs; repair++) {
      if (signal.aborted) return { kind: "cancelled" };

      let turn: AgentTurn;
      try {
        turn = await session.sendAndAwaitEnd(message);
      } catch (err) {
        if (signal.aborted) return { kind: "cancelled" };
        return { kind: "retryable", reason: "thrown-error", error: err instanceof Error ? err.message : String(err) };
      }

      if (signal.aborted) return { kind: "cancelled" };

      // Token budget (spec §9.3): accumulate usage across prompt + steering + answer turns.
      totalTokens += turn.usage?.totalTokens ?? 0;
      if (step.maxTokens !== undefined && totalTokens > step.maxTokens) {
        return { kind: "retryable", reason: "budget-exceeded", error: `step "${step.name}" exceeded its ${step.maxTokens}-token budget (used ${totalTokens})` };
      }

      const check = checkAgentReply(step, turn.text);
      if (check.ok) {
        if (check.kind === "questions") {
          return { kind: "blocked", questionnaire: check.questions, conversation: session.getConversation() };
        }
        return { kind: "ok", output: check.value };
      }
      lastViolation = check.violation;

      if (repair < maxRepairs) {
        await host.emit({ type: "agent-steer", runId: state.runId, path, attempt: repair + 1, violation: lastViolation, at: iso(host) });
        message = buildCorrectionMessage(steerSchema, lastViolation);
        continue;
      }

      const error = `step "${step.name}" output: ${lastViolation}`;
      // Non-background (unchanged, spec §9.2): repairs were attempted and exhausted (or the author set
      // maxOutputRepairs: 0) — a non-retryable failure; the step crashes without an outer retry.
      // Background: there was never a repair to exhaust — an isolated one-shot subagent cannot be
      // steered at all — so invalid output is NOT fatal here; it falls back to the repeat policy
      // (spec §9.2), the same as a thrown transport error would.
      return step.background ? { kind: "retryable", reason: "invalid-output", error } : { kind: "fatal", error };
    }

    return { kind: "fatal", error: `step "${step.name}" output: ${lastViolation}` };
  } finally {
    session.dispose();
  }
}

type ReplyCheck = { ok: true; kind: "result"; value: unknown } | { ok: true; kind: "questions"; questions: Questionnaire } | { ok: false; violation: string };

/** Validate the agent's reply against the step's output schema — or, for Q&A steps, the `{result}|{questions}` union. */
function checkAgentReply(step: AgentStep, text: string): ReplyCheck {
  if (step.asks) {
    const check = validateQaOutput(step.outputSchema, text);
    if (!check.ok) return check;
    // `questions` validated against QuestionnaireSchema above, so the cast is sound.
    return check.kind === "questions" ? { ok: true, kind: "questions", questions: check.questions as Questionnaire } : { ok: true, kind: "result", value: check.value };
  }
  const check = validateAgentOutput(step.outputSchema, text);
  return check.ok ? { ok: true, kind: "result", value: check.value } : check;
}

/** The fresh-run first message: the author's task prompt, plus the auto-injected asking protocol when `asks`. */
function freshPrompt(step: AgentStep, input: unknown, ctx: RunContext): string {
  const prompt = step.buildPrompt({ input, ctx });
  return step.asks ? `${prompt}\n\n${buildAskingProtocol(step.outputSchema)}` : prompt;
}

/** A signal that aborts as soon as any input signal aborts (combine run-cancel with the time-budget timeout). */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

async function retryScheduled(
  host: HostPort,
  runId: string,
  path: string,
  attempt: number,
  totalAttempts: number,
  backoffMs: number,
  reason: RetryReason,
  error: string,
): Promise<boolean> {
  if (attempt >= totalAttempts) return false;
  await host.emit({ type: "step-retry", runId, path, attempt, reason, error, at: iso(host) });
  if (backoffMs > 0) await host.sleep(backoffMs);
  return true;
}
