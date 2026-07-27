/**
 * kimchi's one-shot ferment, as a workflow: plan → (phase → (step → verify)* → phase gates)* → ship.
 *
 * This is the ALTERNATIVE to `tb-solver.workflow.ts`, and it is a different bet. `tb-solver` was
 * designed from measured terminal-bench failures and owes kimchi nothing. This one owes kimchi
 * everything: it is a 1:1 rendering of what `kimchi --ferment-oneshot` does — the same planning process,
 * the same P/S/F/C gate registry, the same worker budget tiers, the same judge standing in for the user,
 * the same verification triage — with exactly one thing removed.
 *
 * ## What is removed, and why it is the whole point
 *
 * In kimchi the ferment lifecycle runs inside ONE session. The model is holding the plan, the phase, the
 * step, the worker's report and the gate verdicts at once, and after every tool call it has to choose to
 * keep going. When it doesn't, the extension makes it: `maybeInjectFermentStopNudge` re-sends the next
 * action when a turn ends early, `scheduleNextFermentAction` renders "call start_ferment_step now" with
 * the ids filled in, `maybeInjectScopingProgressNudge` counts exploration turns, the lifecycle
 * obligation guard catches text-only stops, and the one-shot envelope carries a "## Turn discipline"
 * section telling it not to stall. That machinery is not decoration — dropping the scope nudge alone
 * accounted for 16 of 31 scored failures in one terminal-bench run.
 *
 * None of it is needed here. The engine decides what runs next, so a step that "stops early" has simply
 * finished; there is no turn to nudge, no lifecycle to remind anyone of, and no way to stall between
 * stages. Every prompt in `prompts.ts` therefore keeps kimchi's instruction text and drops its
 * orchestration text (see that file's header for the line-by-line provenance).
 *
 * ## The other differences, all forced, all small
 *
 * The point of this workflow is that the ONLY interesting variable is engine-vs-session, so everything
 * below is a difference the medium forces, not a design choice — and there is deliberately no scheduling
 * policy of any kind (see "Budgets").
 *
 *  - **Phases and steps run sequentially.** kimchi's `parallel_group` is dropped from the plan schema
 *    rather than silently ignored: a `.foreach` above concurrency 1 requires non-overlapping side
 *    effects (spec §3.4/§8.3), which two agents editing one container's filesystem cannot promise.
 *  - **`budget_tier` moves into the plan.** kimchi picks it per step at `start_ferment_step`; that turn
 *    is orchestration, so the tier is chosen once, at plan time, in the planner's own words.
 *  - **Structured output replaces tool calls.** A gate payload that was a `complete_ferment_step`
 *    argument is now the step's output schema; the engine validates and steers on it (spec §9.2).
 *  - **Every agent step is `optional`.** In kimchi a failing turn is a tool error the session survives;
 *    here the equivalent is a step whose failure does not take the run down with it.
 *
 * ## Shape
 *
 *   scoping = (plan → judge?)*                          until the plan has phases and no open questions
 *   phases  = foreach phase
 *               refine?                                 only a phase the plan left with no steps
 *               steps = foreach step
 *                         (worker → S gates → verify → triage? → check)*
 *               close = (rework? → F gates → grade → decide)*
 *   ship    = the C gates                               once every phase is terminal
 *
 * The three loops are where a ferment's "refuses advancement" lives, and they are not the same refusal:
 *
 *  - a flagged S gate or a failed verification sends the STEP back to its own worker for one bounded
 *    continuation (kimchi's rule for a worker that did not land: "a bounded direct continuation … do not
 *    raise the limits and retry the same broad task"), expressed as a `resumable` step in a `dountil`;
 *  - a PHASE that clears its F gates then has to clear the grader as well — A/B advance, C/D/F refuse
 *    and buy a rework, up to `MAX_BLOCK_RETRIES` times, after which the grade is accepted and the phase
 *    advances anyway. This is the piece of kimchi that is easiest to mistake for a report: the letter
 *    grade drives control flow, and an earlier version of this file omitted it entirely.
 */
import { type Static, Type } from "typebox";
import { createAgentStep, createStep, createWorkflow, type RunContext } from "../../../src/flow/index.ts";
import { taskInputSchema } from "../contract.ts";
import {
  ASK_USER_FORM_MAX_ATTEMPTS,
  budgetTier,
  defaultAnswerForQuestion,
  FERMENT_WORKER_BUDGETS,
  gradeRefuses,
  hasBlockingFlag,
  judgeAnswersSchema,
  MAX_BLOCK_RETRIES,
  minimumAcceptableGrade,
  normalizeVerdict,
  type PhaseGrade,
  type PhaseItem,
  type PlannedStep,
  phaseGatesSchema,
  phaseGradeSchema,
  phaseItemSchema,
  planSchema,
  refineSchema,
  type StepItem,
  shipGatesSchema,
  stepGatesSchema,
  stepItemSchema,
  verifyResultSchema,
  verifyTriageSchema,
  workerReportSchema,
} from "./contract.ts";
import {
  judgePrompt,
  phaseGatesPrompt,
  phaseGraderPrompt,
  phaseReworkPrompt,
  planPrompt,
  refinePrompt,
  shipPrompt,
  stepGatesPrompt,
  verifyTriagePrompt,
  workerPrompt,
} from "./prompts.ts";
import { currentGitRef, type PhaseDiff, phaseDiffSince, runVerification } from "./verify.ts";

type Task = Static<typeof taskInputSchema>;
type Plan = Static<typeof planSchema>;
type JudgeAnswers = Static<typeof judgeAnswersSchema>;
type WorkerReport = Static<typeof workerReportSchema>;
type StepGates = Static<typeof stepGatesSchema>;
type PhaseGates = Static<typeof phaseGatesSchema>;
type VerifyResult = Static<typeof verifyResultSchema>;
type Triage = Static<typeof verifyTriageSchema>;

/** `provider/model` for every step; the adapter pins this so subagents match the parent (spec §9.5). */
const MODEL = process.env.TB_MODEL ?? "kimchi-dev/kimi-k2.7";

// -- Budgets -----------------------------------------------------------------------------------------
//
// There is NO wall clock here, on purpose. A ferment runs until the work is done; it never divides a
// budget across its stages, never sizes a turn from what is left, and never tells a model how long it
// has. Adding any of that would be inventing scheduling policy kimchi does not have, and a first run of
// this workflow showed exactly what that costs: per-stage boxes fed on what earlier stages had spent,
// so `phase-gates` was granted 307ms and `ship` a NEGATIVE box — the two closing gate turns never ran,
// and the ship verdict was decided by arithmetic instead of by evidence.
//
// The single deadline that does exist is the run's own, and it predates this workflow: `extension.ts`
// aborts the run shortly before the harness would kill it, which cancels whatever is in flight and
// leaves the machine settled. That is the same protection kimchi gets from its harness, at the same
// level — the whole run, not the individual turn.
//
// The one budget that IS enforced per step is kimchi's own: a worker gets the `max_duration` of the
// tier the plan chose for it (`FERMENT_WORKER_BUDGETS`, ported verbatim).

/**
 * kimchi's recovery rule for a step that did not land, and the only bound in this file that limits
 * repetition: "use resume_subagent for a bounded direct continuation ... do not raise the limits and
 * retry the same broad task". A bounded continuation is one continuation, so a step gets two attempts.
 *
 * kimchi reaches the same place by a different route — a flagged gate returns a tool error and the
 * PLANNER decides whether to continue, skip the step or fail it. There is no planner turn here to make
 * that call, so the rule it would have been applying is applied directly.
 */
const STEP_MAX_ATTEMPTS = 2;

const intentOf = (ctx: RunContext): string => ctx.getInitData<Task>()?.instruction ?? "(missing)";

/**
 * A read whose absence can only mean a WIRING bug, not a step that was skipped.
 *
 * The engine's data flow has one genuinely sharp edge: a mis-addressed `getStepResult` returns
 * `undefined`, which is indistinguishable from "that step has not run yet" (spec §3.9 — only an
 * in-flight read throws). Defaulting such a read is how a bug survives a whole run: `phase-result` read
 * the F verdicts and the grade by bare name from outside the closing loop, got `undefined`, substituted
 * "(no phase summary)" / "(ungraded)", and `ship` was handed an empty table without anything failing.
 *
 * So reads that CANNOT legitimately be empty — the item a foreach handed this body, a function step
 * that has no failure mode — go through here and fail loudly instead.
 */
function mustRead<T>(ctx: RunContext, nameOrPath: string, why: string): T {
  const value = ctx.getStepResult<T>(nameOrPath);
  if (value === undefined) {
    throw new Error(`getStepResult("${nameOrPath}") is undefined, but ${why}. This is an addressing bug (spec §3.9/§8.5), not a skipped step.`);
  }
  return value;
}

// -- Names shared between a branch and its readers ---------------------------------------------------

const JUDGE_ARM = "judge-round";
const REFINE_ARM = "refine-phase";
const TRIAGE_ARM = "verify-triage";
const REWORK_ARM = "phase-rework-round";

// -- Scoping ----------------------------------------------------------------------------------------

type ScopeCheck = {
  ready: boolean;
  plan: Plan | undefined;
  asked: { id: string; question: string }[];
  answers: JudgeAnswers | undefined;
};

const scopeCheckSchema = Type.Object({
  ready: Type.Boolean(),
  plan: Type.Optional(planSchema),
  asked: Type.Array(Type.Object({ id: Type.String(), question: Type.String() })),
  answers: Type.Optional(judgeAnswersSchema),
});

/**
 * The best plan so far, carried into this round.
 *
 * It has to be carried rather than re-read: a step may not observe itself (spec §3.9), and `plan` is
 * `optional`, so a round whose planner failed would otherwise erase a usable plan an earlier round had
 * already produced.
 */
const scopeCarry = createStep({
  name: "scope-carry",
  description: "The plan carried into this scoping round",
  output: Type.Object({ plan: Type.Optional(planSchema) }),
  run: ({ ctx }) => ({ plan: ctx.getStepResult<ScopeCheck>("scoping/scope-check")?.plan }),
});

const plan = createAgentStep({
  name: "plan",
  description: "Scope the intent into a ferment plan: goal, criteria, phases, steps, gates",
  output: planSchema,
  background: true,
  // A second round is a REPLAN with the judge's answers in hand, not a fresh start — the same
  // continuity kimchi gets for free from running scoping inside one session.
  resumable: true,
  optional: true,
  retry: { maxRetry: 0 },
  prompt: ({ ctx }) => {
    const previous = ctx.getStepResult<ScopeCheck>("scope-check");
    return planPrompt({ intent: intentOf(ctx), answers: previous?.answers, questionsAsked: previous?.asked });
  },
});

/**
 * The judge standing in for the user (kimchi's `askJudgeForm`). One-shot scoping still runs the
 * interview — it just routes it to a model that decides, because there is nobody to ask.
 */
const judge = createAgentStep({
  name: "judge",
  description: "Answer the planner's decision-blocking questions as the user would",
  output: judgeAnswersSchema,
  background: true,
  optional: true,
  // kimchi loops the judge call up to ASK_USER_FORM_MAX_ATTEMPTS, re-sending it with "your previous
  // response was not valid or did not match the expected schema" appended, and only then falls back to
  // defaults. A `background` step cannot be steered in-session (spec §9.2 skips repair for subagents),
  // so the equivalent is a fresh attempt per retry — which is what kimchi's loop does anyway.
  //
  // Measured: without this, a judge that answered in prose ("I have al…") failed the step outright and
  // the planner's question went permanently unanswered.
  retry: { maxRetry: ASK_USER_FORM_MAX_ATTEMPTS - 1 },
  prompt: ({ ctx }) => judgePrompt({ intent: intentOf(ctx), plan: ctx.getStepResult<Plan>("plan") }),
});

const judgeRound = createWorkflow({ name: JUDGE_ARM }).then(judge).commit();

/** Whether the interview runs at all: exactly kimchi's rule — it runs when the planner asked something. */
const wantsJudge = (ctx: RunContext): boolean => (ctx.getStepResult<Plan>("plan")?.questions?.length ?? 0) > 0;

const scopeCheck = createStep({
  name: "scope-check",
  description: "Is the plan ready to run",
  output: scopeCheckSchema,
  run: ({ ctx, logger }) => {
    const drafted = ctx.getStepResult<Plan>("plan") ?? ctx.getStepResult<{ plan: Plan | undefined }>("scope-carry")?.plan;
    const judged = ctx.getStepResult<Record<string, JudgeAnswers | undefined>>("interview")?.[JUDGE_ARM];
    const questions = drafted?.questions ?? [];
    const asked = questions.map((question) => ({ id: question.id, question: question.question }));

    // kimchi's fallback: when the judge is unreachable after every attempt it does NOT proceed with the
    // question unanswered — it answers on the judge's behalf with conservative defaults, "rather than
    // abandoning the ferment". A question that reaches the planner unanswered is the one outcome the
    // one-shot interview is built to avoid, so the same substitution happens here.
    const answers =
      judged ??
      (questions.length > 0
        ? { answers: questions.map(defaultAnswerForQuestion), rationale: `Judge was unavailable after ${ASK_USER_FORM_MAX_ATTEMPTS} attempts; using conservative defaults.` }
        : undefined);

    // Ready means what `scope_ferment` means in kimchi: a plan with phases and nothing still being
    // asked. An unanswered question is what another round is FOR — and since the fallback above always
    // produces answers, a round that asked always gets one more round to fold them in.
    const hasPlan = (drafted?.phases?.length ?? 0) > 0;
    const ready = hasPlan && !(asked.length > 0 && answers !== undefined);
    logger.info("scoping round finished", { hasPlan, questions: asked.length, answeredBy: judged ? "judge" : answers ? "defaults" : "none", ready });
    return { ready, plan: drafted, asked, answers };
  },
});

const scopeRound = createWorkflow({ name: "scope-round" })
  .then(scopeCarry)
  .then(plan)
  .branch([[wantsJudge, judgeRound]], { name: "interview" })
  .then(scopeCheck)
  .commit();

// -- One step ---------------------------------------------------------------------------------------

const stepCtx = createStep({
  name: "step-ctx",
  description: "The step this item is about",
  input: stepItemSchema,
  output: stepItemSchema,
  run: ({ input }) => input,
});

type StepCheck = {
  done: boolean;
  attempt: number;
  index: number;
  description: string;
  summary: string;
  verdicts: string;
  verified: string;
  reason: string;
  flags: { id: string; rationale: string; evidence: string }[];
  report: WorkerReport | undefined;
};

const stepCheckSchema = Type.Object({
  done: Type.Boolean(),
  attempt: Type.Number(),
  index: Type.Number(),
  description: Type.String(),
  summary: Type.String(),
  verdicts: Type.String(),
  verified: Type.String(),
  reason: Type.String(),
  flags: Type.Array(Type.Object({ id: Type.String(), rationale: Type.String(), evidence: Type.String() })),
  // Carried rather than re-read: a step may not observe itself (spec §3.9), so the worker's prompt on a
  // second attempt cannot read `worker`'s own previous output — it reads this.
  report: Type.Optional(workerReportSchema),
});

/**
 * Which attempt at this step this is. Read at the top of the attempt, because a step may not observe
 * itself (spec §3.9) — `step-check` cannot count its own attempts.
 *
 * The read is a BARE name on purpose: an explicit path is absolute (spec §8.5), and this loop lives
 * under whichever phase and step item it is nested in, so `attempts/step-check` would address a node
 * that exists at the root and resolve to nothing at all. A bare name resolves lexically, to this item's
 * own previous iteration.
 */
const attemptClock = createStep({
  name: "attempt-clock",
  description: "Which attempt at this step this is",
  output: Type.Object({ attempt: Type.Number() }),
  run: ({ ctx }) => ({ attempt: (ctx.getStepResult<StepCheck>("step-check")?.attempt ?? 0) + 1 }),
});

const planOf = (ctx: RunContext): Plan | undefined => ctx.getStepResult<ScopeCheck>("scoping/scope-check")?.plan;

/**
 * The steps of this phase that already ran, with what they reported — kimchi's `Prior:` line.
 *
 * Addressed item by item rather than through the enclosing `.foreach`'s output, which does not exist
 * until every item has finished. Foreach item indices survive into the static key while loop iteration
 * indices do not (spec §5.4), so `phases@1/steps@0/attempts/step-check` names item 0's LAST attempt —
 * exactly the record kimchi keeps on the step.
 */
const priorStepsOf = (ctx: RunContext, phaseIndex: number, stepIndex: number): { index: number; description: string; summary: string }[] => {
  const prior: { index: number; description: string; summary: string }[] = [];
  for (let item = 0; item < stepIndex - 1; item++) {
    const result = ctx.getStepResult<StepCheck>(`phases@${phaseIndex - 1}/steps@${item}/attempts/step-check`);
    if (result?.done) prior.push({ index: result.index, description: result.description, summary: result.summary });
  }
  return prior;
};

const tierOf = (step: PlannedStep | undefined) => budgetTier(step?.budget_tier);

const worker = createAgentStep({
  name: "worker",
  description: "Do this step's work and report on it",
  output: workerReportSchema,
  background: true,
  // kimchi's recovery for a worker that did not land: `resume_subagent` for a bounded continuation
  // rather than a broader retry. A resumed session is exactly that.
  resumable: true,
  optional: true,
  retry: { maxRetry: 0 },
  // kimchi's own budget for this worker: the `max_duration` of the tier the plan chose, and nothing
  // else — no share of the run, no reading of the clock. The tier's `tokenBudget` has no counterpart,
  // because `maxTokens` is a constant on the step (spec §9.3) while the tier varies per step.
  maxDurationMs: ({ ctx }) => FERMENT_WORKER_BUDGETS[tierOf(ctx.getStepResult<StepItem>("step-ctx")?.step)].maxDuration * 1000,
  prompt: ({ ctx }) => {
    const phase = ctx.getStepResult<PhaseItem>("phase-ctx");
    const item = ctx.getStepResult<StepItem>("step-ctx");
    const attempt = ctx.getStepResult<{ attempt: number }>("attempt-clock")?.attempt ?? 1;
    const last = ctx.getStepResult<StepCheck>("step-check");
    return workerPrompt({
      plan: planOf(ctx),
      phaseIndex: phase?.index ?? 1,
      phaseCount: phase?.total ?? 1,
      phase: phase?.phase ?? { name: "(unknown)", goal: "(unknown)" },
      stepIndex: item?.index ?? 1,
      stepCount: item?.total ?? 1,
      step: item?.step ?? { description: "(missing)" },
      tier: tierOf(item?.step),
      priorSteps: priorStepsOf(ctx, phase?.index ?? 1, item?.index ?? 1),
      attempt,
      previous:
        attempt > 1 && last
          ? {
              report: last.report,
              flags: last.flags,
              verify: ctx.getStepResult<VerifyResult>("verify"),
              reason: last.reason,
            }
          : undefined,
    });
  },
});

/**
 * The step-scope gates (kimchi's `complete_ferment_step`).
 *
 * In kimchi the planner votes on these — it has the worker's report and the diff in its own context. Here
 * it is a fresh agent that has only the report, which is strictly more adversarial: S1 ("does the summary
 * describe work present in the diff?") is a real question when you have not written the summary yourself.
 */
const stepGates = createAgentStep({
  name: "step-gates",
  description: "Vote the step-scope gates on what the worker actually left behind",
  output: stepGatesSchema,
  background: true,
  optional: true,
  retry: { maxRetry: 0 },
  prompt: ({ ctx }) => {
    const phase = ctx.getStepResult<PhaseItem>("phase-ctx");
    const item = ctx.getStepResult<StepItem>("step-ctx");
    return stepGatesPrompt({
      plan: planOf(ctx),
      phase: phase?.phase ?? { name: "(unknown)", goal: "(unknown)" },
      stepIndex: item?.index ?? 1,
      step: item?.step ?? { description: "(missing)" },
      report: ctx.getStepResult<WorkerReport>("worker"),
    });
  },
});

/** kimchi runs the step's verify command itself, inside `complete_ferment_step`. So does this. */
const verify = createStep({
  name: "verify",
  description: "Run the step's verification command and record what it did",
  output: verifyResultSchema,
  optional: true,
  run: async ({ ctx, abortSignal, logger }) => {
    const command = ctx.getStepResult<StepItem>("step-ctx")?.step.verify?.trim();
    if (!command) return { ran: false, command: "", exitCode: 0, stdout: "", stderr: "" };
    const result = await runVerification(command, abortSignal);
    logger.info("verification finished", { command, exitCode: result.exitCode });
    return result;
  },
});

const verifyFailed = (ctx: RunContext): boolean => {
  const result = ctx.getStepResult<VerifyResult>("verify");
  return result?.ran === true && result.exitCode !== 0;
};

const triage = createAgentStep({
  name: "verify-judge",
  description: "Classify a non-zero verification exit as benign, transient, or a real defect",
  output: verifyTriageSchema,
  background: true,
  optional: true,
  retry: { maxRetry: 0 },
  prompt: ({ ctx }) => {
    const item = ctx.getStepResult<StepItem>("step-ctx");
    const result = ctx.getStepResult<VerifyResult>("verify");
    return verifyTriagePrompt({
      step: item?.step ?? { description: "(missing)" },
      command: result?.command ?? "",
      exitCode: result?.exitCode ?? 1,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
    });
  },
});

const triageRound = createWorkflow({ name: TRIAGE_ARM }).then(triage).commit();

/**
 * kimchi's `completeStep`, as a decision rather than a tool call — same order, same precedences:
 * a blocking gate flag refuses completion; then a worker that did not report `completed` refuses it;
 * then the verification decides, with a non-zero exit going to triage whose silence reads as `fail`.
 */
const stepCheck = createStep({
  name: "step-check",
  description: "Decide whether this step is done, or gets one bounded continuation",
  output: stepCheckSchema,
  run: ({ ctx, logger }) => {
    const item = ctx.getStepResult<StepItem>("step-ctx");
    const attempt = ctx.getStepResult<{ attempt: number }>("attempt-clock")?.attempt ?? 1;
    const gates = ctx.getStepResult<StepGates>("step-gates");
    const report = ctx.getStepResult<WorkerReport>("worker");
    const verified = ctx.getStepResult<VerifyResult>("verify");
    const verdict = ctx.getStepResult<Record<string, Triage | undefined>>("triage")?.[TRIAGE_ARM];

    const flags = (gates?.gates ?? [])
      .filter((gate) => normalizeVerdict(gate.verdict) === "flag")
      .map((gate) => ({ id: gate.id, rationale: gate.rationale, evidence: gate.evidence }));

    const verifiedLine = verified?.ran
      ? verified.exitCode === 0
        ? `exit 0 (${verified.command})`
        : `exit ${verified.exitCode} (${verified.command}) — triage: ${verdict?.verdict ?? "fail (no verdict)"}`
      : "no verification command";

    let done = true;
    let reason = "gates passed and verification held";
    if (hasBlockingFlag(gates?.gates)) {
      done = false;
      reason = `a step gate flagged: ${flags.map((flag) => flag.id).join(", ")}`;
    } else if (report === undefined) {
      done = false;
      reason = "the worker returned no report";
    } else if (report.status !== "completed") {
      done = false;
      reason = `the worker reported "${report.status}": ${report.blockers?.join("; ") || report.remaining_steps.join("; ") || report.summary}`;
    } else if (verified?.ran && verified.exitCode !== 0) {
      // kimchi's fail-safe: anything other than a clearly parsed "pass" is a failure, and a judge that
      // never answered is not a pass.
      const triaged = verdict?.verdict ?? "fail";
      if (triaged === "pass") {
        reason = `verification exited ${verified.exitCode} but triage passed it: ${verdict?.reason}`;
      } else {
        done = false;
        reason = `verification failed (exit ${verified.exitCode}): ${verdict?.reason ?? "no triage verdict — treating as failure"}`;
      }
    }

    logger.info("step attempt finished", { step: item?.index, attempt, done, reason });

    return {
      done,
      attempt,
      index: item?.index ?? 0,
      description: item?.step.description ?? "(missing)",
      summary: gates?.summary ?? report?.summary ?? "(no summary)",
      verdicts: (gates?.gates ?? []).map((gate) => `${gate.id}:${gate.verdict}`).join(" ") || "(none)",
      verified: verifiedLine,
      reason,
      flags,
      report,
    };
  },
});

const stepAttempt = createWorkflow({ name: "attempt" })
  .then(attemptClock)
  .then(worker)
  .then(stepGates)
  .then(verify)
  .branch([[verifyFailed, triageRound]], { name: "triage" })
  .then(stepCheck)
  .commit();

const stepBody = createWorkflow({ name: "step" })
  .then(stepCtx)
  .dountil(stepAttempt, (_ctx, last) => (last as StepCheck).done || (last as StepCheck).attempt >= STEP_MAX_ATTEMPTS, { name: "attempts", maxIterations: STEP_MAX_ATTEMPTS + 1 })
  .commit();

// -- One phase --------------------------------------------------------------------------------------

const phaseCtx = createStep({
  name: "phase-ctx",
  description: "The phase this item is about",
  input: phaseItemSchema,
  output: phaseItemSchema,
  run: ({ input }) => input,
});

/**
 * kimchi's `refine_ferment_phase`, reached by the same rule its engine uses (`determineNextAction`
 * case 7: an active phase with no steps). A one-shot plan normally arrives with steps, so this arm is
 * skipped — it exists because a plan that omits them would otherwise silently run an empty phase.
 */
const refineSteps = createAgentStep({
  name: "refine-steps",
  description: "Break a phase with no steps into concrete ones",
  output: refineSchema,
  background: true,
  optional: true,
  retry: { maxRetry: 0 },
  prompt: ({ ctx }) => {
    const item = ctx.getStepResult<PhaseItem>("phase-ctx");
    return refinePrompt({
      intent: intentOf(ctx),
      plan: planOf(ctx),
      phaseIndex: item?.index ?? 1,
      phaseCount: item?.total ?? 1,
      phase: item?.phase ?? { name: "(unknown)", goal: "(unknown)" },
    });
  },
});

const refineRound = createWorkflow({ name: REFINE_ARM }).then(refineSteps).commit();

const needsRefine = (ctx: RunContext): boolean => (ctx.getStepResult<PhaseItem>("phase-ctx")?.phase.steps?.length ?? 0) === 0;

const stepSelector = (ctx: RunContext): readonly StepItem[] => {
  const refined = ctx.getStepResult<Record<string, Static<typeof refineSchema> | undefined>>("refine")?.[REFINE_ARM];
  const steps = refined?.steps ?? ctx.getStepResult<PhaseItem>("phase-ctx")?.phase.steps ?? [];
  return steps.map((step, index) => ({ index: index + 1, total: steps.length, step }));
};

const phaseGates = createAgentStep({
  name: "phase-gates",
  description: "Vote the phase-scope gates on what the phase actually delivered",
  output: phaseGatesSchema,
  background: true,
  optional: true,
  retry: { maxRetry: 0 },
  prompt: ({ ctx }) => {
    const item = ctx.getStepResult<PhaseItem>("phase-ctx");
    const steps = (ctx.getStepResult<(StepCheck | undefined)[]>("steps") ?? []).filter((step): step is StepCheck => step !== undefined);
    return phaseGatesPrompt({
      plan: planOf(ctx),
      phaseIndex: item?.index ?? 1,
      phaseCount: item?.total ?? 1,
      phase: item?.phase ?? { name: "(unknown)", goal: "(unknown)" },
      steps,
    });
  },
});

/**
 * The phase grader (kimchi's `judgePhaseGradeViaSubagent`), and the thing that makes a phase's closing
 * turn a decision rather than a formality: after the F gates pass, an independent grader assigns A–F
 * and **A/B advance while C/D/F refuse**.
 *
 * kimchi spawns it as a subagent WITH tools ("verify the agent's claims independently"), unlike its two
 * plain-API judges, so a background agent step is the faithful shape here rather than a compromise. It
 * is `optional` for the same reason kimchi treats an unreachable judge as advisory: a grader that never
 * answered must not block a phase (`gradeRefuses` reads `undefined` as no refusal).
 */
const phaseGrade = createAgentStep({
  name: "phase-grade",
  description: "Grade the completed phase A-F against what the machine actually shows",
  output: phaseGradeSchema,
  background: true,
  optional: true,
  retry: { maxRetry: 0 },
  prompt: ({ ctx }) => {
    const item = ctx.getStepResult<PhaseItem>("phase-ctx");
    const gates = ctx.getStepResult<PhaseGates>("phase-gates");
    const steps = (ctx.getStepResult<(StepCheck | undefined)[]>("steps") ?? []).filter((step): step is StepCheck => step !== undefined);
    const diff = ctx.getStepResult<PhaseDiff>("phase-diff");
    return phaseGraderPrompt({
      plan: planOf(ctx),
      phase: item?.phase ?? { name: "(unknown)", goal: "(unknown)" },
      phaseSummary: gates?.summary ?? "",
      stepSummaries: steps.map((step) => `  ${step.index}. "${step.description}" — ${step.summary} [${step.verified}]`).join("\n"),
      gateVerdicts: gates?.gates ?? [],
      diff: diff ?? { available: false, filesChanged: "", diffSnippet: "" },
      cwd: process.cwd(),
    });
  },
});

/** What changed in this phase, as evidence for the grader — kimchi's phase-start ref plus its diff. */
const phaseStartRef = createStep({
  name: "phase-start-ref",
  description: "The commit this phase starts from",
  output: Type.Object({ ref: Type.String() }),
  optional: true,
  run: async ({ abortSignal }) => ({ ref: await currentGitRef(abortSignal) }),
});

const phaseDiff = createStep({
  name: "phase-diff",
  description: "What this phase changed, for the grader",
  output: Type.Object({ available: Type.Boolean(), filesChanged: Type.String(), diffSnippet: Type.String() }),
  optional: true,
  run: async ({ ctx, abortSignal }) => phaseDiffSince(ctx.getStepResult<{ ref: string }>("phase-start-ref")?.ref ?? "", abortSignal),
});

type PhaseClose = { accepted: boolean; retry: number; grade: PhaseGrade | undefined; refused: boolean; minimum: string };

const phaseCloseSchema = Type.Object({
  accepted: Type.Boolean(),
  retry: Type.Number(),
  grade: Type.Optional(phaseGradeSchema),
  refused: Type.Boolean(),
  minimum: Type.String(),
});

/**
 * kimchi's `judgeRefused` branch, as a decision: below the bar the phase does not complete and the
 * agent is handed the recommendations to address (bounded by `MAX_BLOCK_RETRIES`, after which the grade
 * is accepted and the phase advances anyway — "the agent had its retries; we don't block continuation
 * indefinitely").
 */
const phaseClose = createStep({
  name: "phase-close",
  description: "Does this phase's grade clear the bar, or does it get another rework",
  output: phaseCloseSchema,
  run: ({ ctx, logger }) => {
    const priorRetries = ctx.getStepResult<{ retry: number }>("close-clock")?.retry ?? 0;
    const grade = ctx.getStepResult<PhaseGrade>("phase-grade");
    const refused = gradeRefuses(grade?.grade, priorRetries);
    const retry = refused ? priorRetries + 1 : priorRetries;
    // Exhausting the budget accepts the grade rather than looping: kimchi advances after MAX_BLOCK_RETRIES.
    const accepted = !refused || retry > MAX_BLOCK_RETRIES;
    logger.info("phase closing turn finished", { grade: grade?.grade ?? null, minimum: minimumAcceptableGrade(priorRetries), refused, retry, accepted });
    return { accepted, retry, grade, refused, minimum: minimumAcceptableGrade(priorRetries) };
  },
});

/**
 * How many reworks this phase has already had, read at the TOP of a closing turn.
 *
 * Same reason as `attempt-clock`: `phase-close` cannot count itself (spec §3.9), and a loop body's
 * static key drops the iteration index, so its own key is exactly what a bare self-read would hit.
 */
const closeClock = createStep({
  name: "close-clock",
  description: "How many times this phase has been sent back",
  output: Type.Object({ retry: Type.Number(), refused: Type.Boolean() }),
  run: ({ ctx }) => {
    const previous = ctx.getStepResult<PhaseClose>("phase-close");
    return { retry: previous?.retry ?? 0, refused: previous?.refused === true };
  },
});

/** The rework kimchi's planner would dispatch on a refusal: address the grader's recommendations. */
const phaseRework = createAgentStep({
  name: "phase-rework",
  description: "Address the grader's recommendations before the phase is graded again",
  output: workerReportSchema,
  background: true,
  optional: true,
  retry: { maxRetry: 0 },
  maxDurationMs: FERMENT_WORKER_BUDGETS.standard.maxDuration * 1000,
  prompt: ({ ctx }) => {
    const item = ctx.getStepResult<PhaseItem>("phase-ctx");
    const close = ctx.getStepResult<PhaseClose>("phase-close");
    return phaseReworkPrompt({
      plan: planOf(ctx),
      phase: item?.phase ?? { name: "(unknown)", goal: "(unknown)" },
      grade: close?.grade ?? { grade: "F", rationale: "(no grade recorded)", recommendations: [] },
      minimum: close?.minimum ?? "A",
      retry: close?.retry ?? 1,
      maxRetries: MAX_BLOCK_RETRIES,
    });
  },
});

const reworkRound = createWorkflow({ name: REWORK_ARM }).then(phaseRework).commit();

/** A rework runs only on a closing turn that follows a refusal — the first pass through has nothing to fix. */
const needsRework = (ctx: RunContext): boolean => ctx.getStepResult<{ refused: boolean }>("close-clock")?.refused === true;

/** One row of the phase table the ship check reads. Collected here so the foreach's output is self-describing. */
const phaseResultSchema = Type.Object({
  index: Type.Number(),
  name: Type.String(),
  summary: Type.String(),
  verdicts: Type.String(),
  grade: Type.String(),
  flagged: Type.Boolean(),
  stepsDone: Type.Number(),
  stepsTotal: Type.Number(),
});
type PhaseResult = Static<typeof phaseResultSchema>;

const phaseResult = createStep({
  name: "phase-result",
  description: "Summarize the phase for the ship check",
  output: phaseResultSchema,
  run: ({ ctx }) => {
    // `phase-ctx` is the foreach item itself and cannot be absent — if it is, the path below is wrong
    // too, and silently reading phase 1's record would be worse than stopping.
    const item = mustRead<PhaseItem>(ctx, "phase-ctx", "it is the item this phase body was handed");
    // Explicit paths, because this step sits OUTSIDE the closing loop while the gates and the grade sit
    // inside it: a bare read resolves to `phases@N/phase-gates`, which does not exist. Loop iteration
    // indices are dropped from the static key (spec §5.4), so `close/…` names the LAST closing turn —
    // the accepted one. `phase-close` is a function step with no failure mode, so its absence is an
    // addressing bug; the gates are an `optional` agent step, so theirs is not.
    const close = mustRead<PhaseClose>(ctx, `phases@${item.index - 1}/close/phase-close`, "every closing turn records one");
    const gates = ctx.getStepResult<PhaseGates>(`phases@${item.index - 1}/close/phase-gates`);
    const steps = (ctx.getStepResult<(StepCheck | undefined)[]>("steps") ?? []).filter((step): step is StepCheck => step !== undefined);
    return {
      index: item.index,
      name: item.phase.name,
      summary: gates?.summary ?? "(no phase summary)",
      verdicts: (gates?.gates ?? []).map((gate) => `${gate.id}:${gate.verdict}`).join(" ") || "(none)",
      grade: close.grade?.grade ?? "(ungraded — the grader returned nothing)",
      flagged: hasBlockingFlag(gates?.gates),
      stepsDone: steps.filter((step) => step.done).length,
      stepsTotal: steps.length,
    };
  },
});

/**
 * The phase's closing turn, and it can repeat: gates → grade → decide, with a rework in front of every
 * attempt after the first. This is kimchi's `complete_ferment_phase` loop — a refused grade sends the
 * agent back with the grader's recommendations and the phase is completed again, up to
 * `MAX_BLOCK_RETRIES` times.
 */
const phaseClosing = createWorkflow({ name: "closing" })
  .then(closeClock)
  .branch([[needsRework, reworkRound]], { name: "rework" })
  .then(phaseDiff)
  .then(phaseGates)
  .then(phaseGrade)
  .then(phaseClose)
  .commit();

const phaseBody = createWorkflow({ name: "phase" })
  .then(phaseCtx)
  .then(phaseStartRef)
  .branch([[needsRefine, refineRound]], { name: "refine" })
  .foreach(stepBody, stepSelector, { name: "steps" })
  .dountil(phaseClosing, (_ctx, last) => (last as PhaseClose).accepted, { name: "close", maxIterations: MAX_BLOCK_RETRIES + 2 })
  .then(phaseResult)
  .commit();

const phaseSelector = (ctx: RunContext): readonly PhaseItem[] => {
  const phases = planOf(ctx)?.phases ?? [];
  return phases.map((phase, index) => ({ index: index + 1, total: phases.length, phase }));
};

// -- Ship -------------------------------------------------------------------------------------------

const ship = createAgentStep({
  name: "ship",
  description: "Walk the P3 checklist and vote the ferment-scope gates",
  output: shipGatesSchema,
  background: true,
  optional: true,
  retry: { maxRetry: 0 },
  prompt: ({ ctx }) => {
    const phases = (ctx.getStepResult<(PhaseResult | undefined)[]>("phases") ?? []).filter((phase): phase is PhaseResult => phase !== undefined);
    return shipPrompt({ intent: intentOf(ctx), plan: planOf(ctx), phases });
  },
});

const report = createStep({
  name: "report",
  description: "Summarize the run for the log",
  output: Type.Object({
    shipped: Type.Boolean(),
    phases: Type.Number(),
    steps: Type.Number(),
    stepsDone: Type.Number(),
  }),
  run: ({ ctx }) => {
    const phases = (ctx.getStepResult<(PhaseResult | undefined)[]>("phases") ?? []).filter((phase): phase is PhaseResult => phase !== undefined);
    const gates = ctx.getStepResult<Static<typeof shipGatesSchema>>("ship");
    return {
      // Shipped means what `complete_ferment` means: the C gates were voted and none of them flagged.
      shipped: gates !== undefined && !hasBlockingFlag(gates.gates),
      phases: phases.length,
      steps: phases.reduce((total, phase) => total + phase.stepsTotal, 0),
      stepsDone: phases.reduce((total, phase) => total + phase.stepsDone, 0),
    };
  },
});

export default createWorkflow({
  name: "ferment-oneshot",
  description: "Run a terminal-bench task as kimchi's one-shot ferment: scope it into phases and steps, run each step through a worker, gate every completion",
  input: taskInputSchema,
  defaultModel: MODEL,
})
  // Scoping repeats while the planner is still asking, exactly as kimchi's interview does: ask, hear the
  // judge, replan. No round cap — the loop's `maxIterations` default is a runaway guard the builder
  // requires, and the run's own deadline is what actually ends a planner that never converges.
  .dountil(scopeRound, (_ctx, last) => (last as ScopeCheck).ready, { name: "scoping" })
  // Phases run in the order the plan gives them, one at a time. Sequential is not a simplification here:
  // concurrent items must have non-overlapping side effects (spec §3.4/§8.3), which two agents editing
  // the same container cannot promise.
  .foreach(phaseBody, phaseSelector, { name: "phases" })
  .then(ship)
  .then(report)
  .commit();
