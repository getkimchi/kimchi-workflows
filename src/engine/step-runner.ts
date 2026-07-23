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
 * `answer` resume (spec §8.4) seeds the session with the parked conversation and replays the user's
 * structured answers as the next turn.
 */
export type AgentEntry = { kind: "fresh" } | { kind: "answer"; answers: Record<string, unknown>; conversation: readonly unknown[] };

/**
 * Outcome of a single attempt:
 *  - `ok`        — produced schema-valid output;
 *  - `retryable` — a failure the retry policy may re-attempt (thrown error / invalid function output /
 *                  agent transport error / budget exceeded, spec §9.3);
 *  - `fatal`     — a non-retryable failure (an agent whose output stays invalid after steering);
 *  - `parked`    — a Q&A step emitted a `{questionnaire}` batch (spec §10);
 *  - `cancelled` — the abort signal fired.
 */
type AttemptResult =
  | { kind: "ok"; output: unknown }
  | { kind: "retryable"; reason: RetryReason; error: string }
  | { kind: "fatal"; error: string }
  | { kind: "parked"; questionnaire: Questionnaire; conversation: readonly unknown[] }
  | { kind: "cancelled" };

/** Run a function step under its retry + time budget (spec §9). Emits `step-retry`; the caller emits step lifecycle. */
export async function runFunctionStep(step: FunctionStep, input: unknown, host: HostPort, state: RunState, signal: AbortSignal): Promise<StepOutcome> {
  const ctx = createRunContext(state);
  const logger = createStepLogger(host, state.runId, step.name);
  return retryLoop(step, host, state, signal, (sig) => runFunctionAttempt(step, input, ctx, logger, sig));
}

/**
 * Run an agent step under its retry policy (spec §9), budgets (time + tokens, §9.3), steering (§9.2),
 * and Q&A (§10). `entry` selects a fresh run or an answer-resume that continues the same loop (§8.4).
 * Emits `step-retry`/`agent-steer`; the caller emits step lifecycle + `questionnaire-asked`.
 */
export async function runAgentStep(step: AgentStep, input: unknown, host: HostPort, state: RunState, signal: AbortSignal, entry: AgentEntry): Promise<StepOutcome> {
  const ctx = createRunContext(state);
  return retryLoop(step, host, state, signal, (sig) => runAgentSession(step, input, host, ctx, state, sig, entry));
}

/** Shared retry loop (spec §9): wrap each attempt in the time budget, re-attempt `retryable` failures within budget. */
async function retryLoop(
  step: BudgetedStep,
  host: HostPort,
  state: RunState,
  runSignal: AbortSignal,
  attempt: (signal: AbortSignal) => Promise<AttemptResult>,
): Promise<StepOutcome> {
  const maxAttempts = Math.max(1, step.retry?.maxAttempts ?? 1);
  const backoffMs = step.retry?.backoffMs ?? 0;
  let lastError = "";

  for (let n = 1; n <= maxAttempts; n++) {
    if (runSignal.aborted) return { kind: "cancelled" };

    const result = await withTimeBudget(step, host, runSignal, attempt);
    if (result.kind === "cancelled") return { kind: "cancelled" };
    if (result.kind === "ok") return { kind: "ok", output: result.output };
    if (result.kind === "parked") return { kind: "parked", questionnaire: result.questionnaire, conversation: result.conversation };
    if (result.kind === "fatal") return { kind: "crashed", error: result.error };

    // Retryable failure (thrown / invalid output / budget exceeded): re-attempt if budget remains.
    lastError = result.error;
    if (await retryScheduled(host, state.runId, step.name, n, maxAttempts, backoffMs, result.reason, result.error)) continue;
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
 * Q&A `{questionnaire}` → `parked` (§10); steering exhausted → `fatal`; transport error → `retryable`.
 *
 * When `asks`, the framework owns the questionnaire schema: the reply union is `{result}|{questionnaire}`
 * and the asking protocol is auto-injected into the fresh prompt (so the author's prompt is task-only).
 */
async function runAgentSession(step: AgentStep, input: unknown, host: HostPort, ctx: RunContext, state: RunState, signal: AbortSignal, entry: AgentEntry): Promise<AttemptResult> {
  const model = step.model ?? state.defaultModel; // step → workflow default; host applies the session default when undefined (spec §9.5)
  const maxRepairs = Math.max(0, step.maxOutputRepairs ?? DEFAULT_MAX_OUTPUT_REPAIRS);
  const steerSchema = step.asks ? buildQaSchema(step.outputSchema) : step.outputSchema;
  const history = entry.kind === "answer" ? entry.conversation : undefined;
  const session = host.startAgent({ model, history, stepName: step.name });

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
        if (check.kind === "questionnaire") {
          return { kind: "parked", questionnaire: check.questionnaire, conversation: session.getConversation() };
        }
        return { kind: "ok", output: check.value };
      }
      lastViolation = check.violation;

      if (repair < maxRepairs) {
        await host.emit({ type: "agent-steer", runId: state.runId, stepName: step.name, attempt: repair + 1, violation: lastViolation, time: iso(host) });
        message = buildCorrectionMessage(steerSchema, lastViolation);
        continue;
      }
      return { kind: "fatal", error: `step "${step.name}" output: ${lastViolation}` };
    }

    return { kind: "fatal", error: `step "${step.name}" output: ${lastViolation}` };
  } finally {
    session.dispose();
  }
}

type ReplyCheck = { ok: true; kind: "result"; value: unknown } | { ok: true; kind: "questionnaire"; questionnaire: Questionnaire } | { ok: false; violation: string };

/** Validate the agent's reply against the step's output schema — or, for Q&A steps, the `{result}|{questionnaire}` union. */
function checkAgentReply(step: AgentStep, text: string): ReplyCheck {
  if (step.asks) {
    const check = validateQaOutput(step.outputSchema, text);
    if (!check.ok) return check;
    // `questionnaire` validated against QuestionnaireSchema above, so the cast is sound.
    return check.kind === "questionnaire"
      ? { ok: true, kind: "questionnaire", questionnaire: check.questionnaire as Questionnaire }
      : { ok: true, kind: "result", value: check.value };
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
  stepName: string,
  attempt: number,
  maxAttempts: number,
  backoffMs: number,
  reason: RetryReason,
  error: string,
): Promise<boolean> {
  if (attempt >= maxAttempts) return false;
  await host.emit({ type: "step-retry", runId, stepName, attempt, reason, error, time: iso(host) });
  if (backoffMs > 0) await host.sleep(backoffMs);
  return true;
}
