/**
 * What each step is told — ported from kimchi's one-shot ferment, as literally as the medium allows.
 *
 * The rule applied throughout: **instruction text is kept, orchestration text is dropped.** A sentence
 * that tells the model what good work looks like is prompt; a sentence that tells it which tool to call
 * next, or that it must not stall between turns, is the ferment's continuation machinery — the nudges
 * (`nudge.ts`, `scheduler.ts`, `lifecycle-obligation-guard.ts`) whose entire job is to make one long
 * session behave like a state machine. Here the state machine IS the engine, so that half is deleted
 * rather than translated: no "call X now", no "Next action:" lines, no turn discipline, no stop nudges.
 *
 * Provenance, file by file in the kimchi checkout:
 *  - `SHARED_PLANNING_PROCESS` — src/shared/planning/shared-planning-process.ts, verbatim.
 *  - `planPrompt` — src/extensions/ferment/oneshot.ts (`buildOneshotNudge`), minus its tool-call
 *    choreography and its "## Turn discipline" section.
 *  - `judgeSystemPrompt` / `judgePrompt` — src/extensions/ferment/ask-user.ts (`ASK_USER_FORM_SYSTEM`,
 *    `buildAskJudgeFormUserMsg`).
 *  - `refinePrompt` — engine.ts's `refine` action prose + `RefineParams`.
 *  - `workerPrompt` — src/extensions/ferment/tools/steps.ts (`planFirstPreamble`, the limits hint) and
 *    worker-prompt.ts (`buildWorkerContext`).
 *  - `stepGatesPrompt` / `phaseGatesPrompt` / `shipPrompt` — the three completion tools' descriptions,
 *    plus the gate registry's own question/guidance text (see contract.ts).
 *  - `verifyTriagePrompt` — judge.ts (`STEP_VERIFICATION_SYSTEM`), verbatim.
 */
import type { Static } from "typebox";
import {
  type BudgetTier,
  FERMENT_WORKER_BUDGETS,
  type judgeAnswersSchema,
  PHASE_GATES,
  type PhaseGrade,
  PLAN_GATES,
  type PlannedStep,
  type planSchema,
  renderGateGuidance,
  SHIP_GATES,
  STEP_GATES,
  type workerReportSchema,
} from "./contract.ts";

type Plan = Static<typeof planSchema>;
type JudgeAnswers = Static<typeof judgeAnswersSchema>;
type WorkerReport = Static<typeof workerReportSchema>;

/** Verbatim from kimchi's src/shared/planning/shared-planning-process.ts. */
export const SHARED_PLANNING_PROCESS = `Follow five steps IN ORDER. Do NOT get stuck on any step.
Your goal is to reach a complete, well-scoped plan, not to understand every file in the project.

STEP 1 — ORIENT (lightweight research, MAX 2 TURNS)
Read the user's intent. Before asking anything, build MINIMAL context:
- Do a quick project scan: file listing, README, package/config files (1-2 tool calls).
- Form an initial mental model: what kind of task is this? What technology and patterns?
- Identify your unknowns: what assumptions are you making? What decisions can only the user make?
- If the project is greenfield (no existing codebase) or the task is non-code (writing, strategy, general planning), note that and move on immediately.

Default budget: spend about 1-2 turns on Orient and aim for 3-5 targeted files. Exceed this only
for a specific unknown that would materially change the interview questions or plan. Do NOT read
implementation files line by line — save that for Step 4 (Deep Exploration) which happens AFTER
the interview and criteria confirmation.

This step is about YOUR understanding, not the user's. Do not ask questions yet.

STEP 2 — INTERVIEW (iterative rounds)
Ask the user about the unknowns you identified in Step 1. Run in rounds:

Round structure:
  a. Ask 1-3 focused questions using your mode's structured Q&A tool.
     When presenting options, allow free-form alternatives and include "None of the above"
     for predefined choices.
  b. When answers come back, REFLECT before continuing:
     - How do these answers change your understanding of the task?
     - Do you need to check anything in the codebase to validate or act on an answer?
       If so, do a quick targeted lookup (grep, short read) — keep it narrow.
     - Does this introduce new assumptions or new questions?
  c. If new questions emerged, ask them in the next round.
  d. If scope is clear and no question would change the approach, exit the loop.

When to ask:
- You are making an assumption that could be wrong and would change the approach.
  Surface it explicitly: "I'm assuming X — is that right, or should I do Y instead?"
- The intent is ambiguous between 2+ interpretations you genuinely can't resolve.
- There is a decision only the user can make (auth provider, DB choice, public vs internal, etc.).

When NOT to ask:
- The intent is already clear and specific — don't make the user repeat themselves.
- There is a safe, reversible default. Pick it, note it in assumptions, move on.
- The question is generic ("Any edge cases?", "What about error handling?").
  If you suspect a specific edge case, name it and ask about THAT.

Exit criteria: you can explain in one sentence what you're building, why, and how
you'll know it's done — and no remaining question would change the approach.
If the intent was unambiguous from Step 1 and you have no genuine uncertainties,
skip this step entirely — don't manufacture questions.

STEP 3 — COMPLETION CRITERIA
Draft concrete completion criteria and validation steps, then confirm with the user.
- State what "done" looks like in specific, testable terms.
- Include the verification method for each criterion (test command, manual check, linter, etc.).
- Use your mode's confirmation mechanism to present the criteria.
- Proceed only when user confirms criteria are correct.
- If the user already stated clear acceptance criteria in their intent, confirm them
  rather than rephrasing. Don't over-formalize obvious criteria.
- Confirm criteria with the user BEFORE proceeding to exploration.

STEP 4 — DEEP EXPLORATION (targeted, not broad, MAX 2 TURNS of direct reads)
Now investigate the codebase for implementation-specific details.
- Focus ONLY on unknowns that remain after the interview — don't re-explore what you
  already learned in Step 1.
- Prefer targeted search over reading entire files line by line. Find the specific
  lines you need.
- If you read files directly, limit to at most 2 turns of reads.
- Skip this step for greenfield tasks with no existing codebase; record why in assumptions.
- Skip entirely if you have enough context from Steps 1-3 to write a plan.
- After exploration, verify your understanding and look for gaps.

STEP 5 — PLAN
Synthesize everything — orient findings, interview answers, confirmed criteria,
and exploration results — into a structured plan.
- Ensure completion criteria were confirmed with the user before finalizing.
- Do NOT finalize the plan while any open question remains unresolved.
- Use your mode's completion mechanism to submit the plan for user review.

Every plan must use this structure:

## Goal
One-sentence statement of what the plan achieves.

## Constraints
List non-negotiable requirements (e.g., "no new dependencies", "preserve existing API").

## Chunks
Ordered, independently-verifiable units of work. Each chunk has:
- **Scope**: what it covers (file paths, components)
- **Files Changed**: every file created, modified, or deleted — use concrete paths, not globs
- **Depends On**: which prior chunk(s) it requires
- **Accept When**: 2-3 concrete, verifiable criteria
- **Test Coverage**: which test files need creation or update for this chunk
- **Open Questions**: explicitly list any unknowns or assumptions (never leave implicit)

Step sizing rule: every step should fit within ~25% of the active model's context window when implemented, including its tool output. If you cannot see how to fit a step within that budget, split it into smaller steps.

## Verification Strategy
How to confirm each chunk is correct (test command, manual check, etc.).

## Decision Log
Tracked choices with rationale and rejected alternatives noted.

## Risks
Named risks with likelihood and mitigation approach.

Assumption rule: you are encouraged to make assumptions when planning — exploration often requires
educated guesses. However, every assumption must be surfaced explicitly and resolved with the user
before the plan is finalized. Add unresolved assumptions to the relevant chunk's Open Questions,
use your mode's Q&A tool to confirm them, then move confirmed ones to the Decision Log.
Do not present the plan as final while any Open Question remains unresolved.

Self-validation: after writing the plan, re-read it and cross-check against the completion criteria.
For each chunk, verify: (1) Files Changed lists concrete paths, not vague descriptions, (2) Accept
When criteria are testable and specific, (3) no implicit assumptions remain unrecorded. Flag and
fix any gaps before submitting the plan for review.

Common plan anti-patterns to avoid:
- Chunks that say "refactor X" without listing which files change and how
- Accept When criteria that are just "it works" or "tests pass" without naming the specific test
- Every chunk depending on the previous one when some could be parallel
- Exploration or discovery as an implementation chunk — that belongs in Steps 1/4, not in the plan
- Verification Strategy that is identical for every chunk instead of chunk-specific`;

/**
 * The planner, i.e. kimchi's one-shot envelope.
 *
 * Two things it no longer says, both deliberate. The tool-call sequence ("call scope_ferment", "for each
 * phase call activate_ferment_phase, then for each step call start_ferment_step...") is replaced by a
 * description of what the ENGINE will do with the plan — same execution model, but it is not this step's
 * job to drive it. And the whole "## Turn discipline" section is gone: it exists to stop a single session
 * from halting between lifecycle calls, which cannot happen when each stage is its own step.
 */
export function planPrompt(args: { intent: string; answers?: JudgeAnswers; questionsAsked?: readonly { id: string; question: string }[] }): string {
  const { intent, answers, questionsAsked } = args;

  const answered =
    answers && answers.answers.length > 0
      ? [
          "",
          "## Answers from the judge",
          "",
          "You asked for a decision and it has been made — these answers are final; do not ask them again.",
          ...answers.answers.map((answer) => {
            const asked = questionsAsked?.find((question) => question.id === answer.id);
            return `- ${asked ? asked.question : answer.id}: ${answer.value}`;
          }),
          `Rationale: ${answers.rationale}`,
          "",
          "Fold them into the plan and return it now. Ask only NEW decision-blocking questions; never repeat answered ones.",
        ].join("\n")
      : "";

  return `You are running a one-shot ferment.

User intent: "${intent}"

## Your job

Follow the shared planning process below. The only differences from interactive ferment scoping are:
- **Interview**: put anything decision-blocking in \`questions\` — they are automatically routed to a judge that stands in for the user. You do not need to do anything special.
- **Completion Criteria**: there is no confirmation turn in one-shot mode. Draft criteria from the intent and include them directly in \`success_criteria\`.
- Then return the complete plan.

${SHARED_PLANNING_PROCESS}

## One-shot execution

1. **Return the plan** with:
   - title: concise 3-5 word name derived from the task
   - goal: what the task asks for, in one sentence
   - success_criteria: observable, verifiable outcomes
   - constraints: technical constraints implied by the intent
   - phases: the smallest useful ordered plan — usually 1–3 phases with 1–4 steps each; every step must have a description and, where possible, a verify bash command
   - gates: exactly ${PLAN_GATES.join(", ")} — each with id, verdict, rationale, evidence

2. **For each phase**, each step is handed to its own worker with an explicit budget_tier chosen from
   the scoped work shape: narrow for verification or one small edit; standard (normal implementation
   default); complex for multi-file builds or iterative debugging. The worker submits a structured
   report, the step-scope gates are voted on what it left behind, and the step's verify command is run.
   A flagged gate or a failed verification does not advance the step.

3. **When all phases are done**, the ferment-scope gates decide whether it ships, against the ${PLAN_GATES[2]}
   checklist you declare here.

## Plan-scope gates

You must produce verdicts for the three plan-scope gates below.

${renderGateGuidance(PLAN_GATES)}

## Toolset

This step PLANS; it does not implement. Use read-only research tools only — read, grep, find, ls, and
non-mutating shell commands. Do not edit, create, delete, move, or install anything: the work belongs to
the workers, and anything done here is work nobody verifies.${answered}`;
}

/** Verbatim from kimchi's `ASK_USER_FORM_SYSTEM` (src/extensions/ferment/ask-user.ts). */
export const judgeSystemPrompt = `You are standing in for the user during an autonomous ferment run. A planner agent has reached decision points it cannot resolve from context alone and is asking a structured form. There is no human available — you decide.

Your bias:
- Choose answers that best serve the ferment's stated goal and success criteria, NOT whatever moves work forward fastest.
- When two answers seem equivalent, prefer the more conservative one (less destructive, more revertible).
- When you genuinely cannot tell, choose or write the answer that preserves optionality.

For single questions, "value" MUST be one provided option id unless allowOther is true.
For confirm questions, "value" MUST be "yes" or "no".
For multi questions, "value" MUST be a comma-separated list of provided option ids unless allowOther is true.
For text questions, "value" MUST be a concise directly usable string.
Every question must be answered.

Decide from what you are shown. In kimchi this judge is a single model call with no tools at all, so do not run commands or read files — answer the form.`;

/** kimchi's `buildAskJudgeFormUserMsg`, with the ferment record replaced by the plan draft. */
export function judgePrompt(args: { intent: string; plan: Plan | undefined }): string {
  const { intent, plan } = args;
  const questions = plan?.questions ?? [];
  return [
    judgeSystemPrompt,
    "",
    `Ferment: "${plan?.title ?? "(untitled)"}"`,
    `Goal: ${plan?.goal ?? "(none specified)"}`,
    `Success criteria: ${plan?.success_criteria?.join("; ") || "(none specified)"}`,
    `User intent: "${intent}"`,
    "",
    "Questions:",
    JSON.stringify(questions, null, 2),
    "",
    "Answer every question with the id it was asked under.",
  ].join("\n");
}

/** engine.ts's `refine` action prose, plus the step-shape rules from `RefineParams`. */
export function refinePrompt(args: { intent: string; plan: Plan | undefined; phaseIndex: number; phaseCount: number; phase: { name: string; goal: string } }): string {
  const { intent, plan, phaseIndex, phaseCount, phase } = args;
  return [
    `Break phase ${phaseIndex} "${phase.name}" into 3–6 concrete steps.`,
    "",
    `Phase ${phaseIndex}/${phaseCount}: ${phase.name} — ${phase.goal}`,
    `Ferment: ${plan?.title ?? "(untitled)"}`,
    `Goal: ${plan?.goal ?? intent}`,
    plan?.success_criteria?.length ? `Criteria: ${plan.success_criteria.join("; ")}` : "",
    "",
    "Each step needs a description a worker can act on having seen nothing else, and a verify bash",
    "command that exits 0 on success wherever one is possible. Steps run in the order you give them; a",
    "step's budget_tier selects the worker limits it gets.",
    "",
    "This step PLANS; it does not implement. Read-only commands only.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The worker, i.e. what `start_ferment_step` hands the subagent.
 *
 * kimchi assembles this from three pieces and tells the planner to paste them into the `Agent` call: the
 * "plan first" preamble, the worker-context block (`buildWorkerContext`), and the selected limits. All
 * three are here; what is dropped is the part addressed to the planner (task_ref, "set all three limits
 * exactly on the Agent call", "call submit_agent_report before its final answer" — the report is this
 * step's declared output, so the engine collects it either way).
 */
export function workerPrompt(args: {
  plan: Plan | undefined;
  phaseIndex: number;
  phaseCount: number;
  phase: { name: string; goal: string; constraints?: readonly string[] };
  stepIndex: number;
  stepCount: number;
  step: PlannedStep;
  tier: BudgetTier;
  priorSteps: readonly { index: number; description: string; summary: string }[];
  attempt: number;
  previous?: {
    report: WorkerReport | undefined;
    flags: readonly { id: string; rationale: string; evidence: string }[];
    verify?: { exitCode: number; stdout: string; stderr: string };
    reason: string;
  };
}): string {
  const { plan, phaseIndex, phaseCount, phase, stepIndex, stepCount, step, tier, priorSteps, attempt, previous } = args;
  const limits = FERMENT_WORKER_BUDGETS[tier];

  const prior =
    priorSteps.length > 0 ? `Prior: ${priorSteps.map((s) => (s.summary ? `✓${s.index} "${s.description}" — ${s.summary}` : `✓${s.index} "${s.description}"`)).join("; ")}` : "";

  const context = [
    "## Worker Context",
    `Ferment: ${plan?.title ?? "(untitled)"}`,
    `Phase ${phaseIndex}/${phaseCount}: ${phase.name} — ${phase.goal}`,
    `Step ${stepIndex}/${stepCount}: ${step.description}`,
    step.verify ? `verify: ${step.verify}` : "",
    "",
    "Write no reports, notes, or scratch files: return decision-ready findings in your report instead. Do NOT create ad-hoc project-root scratch folders unless the task explicitly asked for a product artifact.",
    plan?.goal ? `\nGoal: ${plan.goal}` : "",
    plan?.success_criteria?.length ? `Criteria: ${plan.success_criteria.join("; ")}` : "",
    phase.constraints?.length ? `Constraints: ${phase.constraints.join("; ")}` : "",
    prior,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const planFirst = [
    "📋 Plan first (every start of this step):",
    "• Write a brief 2-4 bullet inline plan for this step's work.",
    "• Include a verification sub-task that checks exact expected output, not just substring grep. Match the verify command's precision.",
    "• If the step compiles or builds artifacts, include a cleanup sub-task to remove intermediate files from output directories.",
    priorSteps.length > 0 ? `• Prior steps: ${priorSteps.map((s) => `✓${s.index} "${s.description}"`).join("; ")}. Build on their output.` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  // kimchi's recovery rule for an exhausted worker, applied to this step's second attempt: continue the
  // same bounded work, do not restart it broader. The session is resumed, so the conversation above is
  // this worker's own.
  const retry =
    attempt > 1 && previous
      ? [
          "",
          "THIS STEP WAS NOT ACCEPTED, AND THIS IS A BOUNDED CONTINUATION OF YOUR OWN EARLIER ATTEMPT.",
          `Reason: ${previous.reason}`,
          ...previous.flags.map((flag) => `  [${flag.id}] ${flag.rationale} — evidence: ${flag.evidence}`),
          previous.verify ? `  verify exited ${previous.verify.exitCode}\n  stdout: ${clip(previous.verify.stdout)}\n  stderr: ${clip(previous.verify.stderr)}` : "",
          previous.report?.remaining_steps?.length ? `  you reported still outstanding: ${previous.report.remaining_steps.join("; ")}` : "",
          "Fix the underlying cause and finish the remaining work — do not widen the task, and do not start over.",
        ]
          .filter((line) => line !== "")
          .join("\n")
      : "";

  return `${planFirst}

${context}

Selected worker budget: budget_tier=${tier}, max_turns=${limits.maxTurns}, max_duration=${limits.maxDuration}s, token_budget=${limits.tokenBudget}.

Do this step's work, then run its verification yourself and fix what fails. A "completed" report must use remaining_steps: []; use "partial" if work remains, and "blocked" if something stopped you, naming at least one blocker.${retry}`;
}

/** kimchi's `complete_ferment_step` description + the step-scope gate guidance. */
export function stepGatesPrompt(args: {
  plan: Plan | undefined;
  phase: { name: string; goal: string };
  stepIndex: number;
  step: PlannedStep;
  report: WorkerReport | undefined;
  /** The verdicts THIS session flagged last time, when the step was sent back — kimchi's re-call. */
  previousFlags?: readonly { id: string; rationale: string; evidence: string }[];
}): string {
  const { plan, phase, stepIndex, step, report, previousFlags } = args;

  // A re-call, not a fresh vote: this session already flagged and the step was refused. kimchi's
  // planner sees exactly this text and re-votes — usually passing, or omitting a gate that does not
  // apply — which is why its steps converge and an earlier version of this port's never did.
  if (previousFlags && previousFlags.length > 0) {
    return [
      gateRefusalText({
        what: `Step ${stepIndex}: "${step.description}"`,
        flags: previousFlags,
        recall: "vote again",
      }),
      "",
      "The worker has since had another attempt at this step. Its report now:",
      report ? JSON.stringify(report, null, 2) : "(none — the worker returned nothing usable)",
      "",
      "Look at the machine again before you vote. If the underlying issue is resolved, vote 'pass'. If a",
      "gate does not genuinely apply to this step, vote 'omitted' with the rationale that says why —",
      "flagging a gate that does not apply keeps a finished step from ever completing.",
      "",
      renderGateGuidance(STEP_GATES),
    ].join("\n");
  }

  return [
    "A worker has just finished a ferment step. Decide whether it may be marked done.",
    "",
    `Ferment: ${plan?.title ?? "(untitled)"}`,
    `Goal: ${plan?.goal ?? "(none specified)"}`,
    `Phase: ${phase.name} — ${phase.goal}`,
    `Step ${stepIndex}: "${step.description}"`,
    step.verify ? `Verification command (it will be run for real after this): ${step.verify}` : "Verification command: none",
    "",
    "The worker's own report:",
    report ? JSON.stringify(report, null, 2) : "(none — the worker returned nothing usable)",
    "",
    // Forced by the medium, not editorial: in kimchi this turn is the planner, which already holds the
    // diff and the worker's transcript. A fresh agent holds neither, and S1 ("does the summary describe
    // work present in the diff?") is unanswerable without looking.
    "The diff and the machine are not in your context — read them before voting. Do not fix anything.",
    "",
    'You must produce verdicts for the three step-scope gates below. A "flag" verdict blocks step completion.',
    "",
    renderGateGuidance(STEP_GATES),
    "",
    "Then write the summary the following steps in this phase will read: what was actually accomplished,",
    "in one or two sentences.",
  ].join("\n");
}

/**
 * kimchi's refusal text when a completion turn self-flags, ported from `gate-validation.ts`'s
 * `flagLines` plus each turn's `renderFlagError`.
 *
 * The wording matters more than it looks. kimchi's voter is the PLANNER — the same agent that wants to
 * advance — so "agent self-flagged" is literal, and the message tells it the two ways out: fix the
 * underlying issue, or vote `omitted` when the gate genuinely does not apply. Sending this back into the
 * SAME gate session (the step is `resumable`) is what makes the port's gate turn behave like kimchi's
 * re-call rather than like a fresh sceptic who has never seen its own verdict.
 */
export function gateRefusalText(args: { what: string; flags: readonly { id: string; rationale: string; evidence: string }[]; recall: string }): string {
  const { what, flags, recall } = args;
  const flagLines = flags.map((flag) => `  ⛔ Gate ${flag.id}: ${flag.rationale}\n     evidence: ${flag.evidence}`).join("\n");
  return [
    `${what} cannot complete - agent self-flagged on ${flags.length} step gate(s):`,
    "",
    flagLines,
    "",
    `Resolve the underlying issue and ${recall} with verdicts of 'pass' (or 'omitted' with rationale if a gate truly does not apply).`,
  ].join("\n");
}

/** kimchi's `complete_ferment_phase` description + the phase-scope gate guidance. */
export function phaseGatesPrompt(args: {
  plan: Plan | undefined;
  phaseIndex: number;
  phaseCount: number;
  phase: { name: string; goal: string };
  steps: readonly { index: number; description: string; summary: string; verdicts: string; verified: string }[];
}): string {
  const { plan, phaseIndex, phaseCount, phase, steps } = args;
  return [
    `Phase ${phaseIndex}/${phaseCount} "${phase.name}" has finished its steps. Decide whether it may be marked completed.`,
    "",
    `Ferment: ${plan?.title ?? "(untitled)"}`,
    `Goal: ${plan?.goal ?? "(none specified)"}`,
    plan?.success_criteria?.length ? `Success criteria: ${plan.success_criteria.join("; ")}` : "",
    `Phase goal: ${phase.goal}`,
    "",
    "What its steps did:",
    ...steps.map((step) => `  ${step.index}. "${step.description}"\n     summary: ${step.summary}\n     step gates: ${step.verdicts}\n     verification: ${step.verified}`),
    "",
    "The machine is not in your context — read it where the record above is thin. Do not fix anything.",
    "",
    'You must produce verdicts for the three phase-scope gates below. A "flag" verdict refuses advancement.',
    "",
    renderGateGuidance(PHASE_GATES),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** kimchi's `complete_ferment` description + the ferment-scope gate guidance. */
export function shipPrompt(args: { intent: string; plan: Plan | undefined; phases: readonly { index: number; name: string; summary: string; verdicts: string }[] }): string {
  const { intent, plan, phases } = args;
  return [
    "All phases of this ferment are terminal. Decide whether it ships.",
    "",
    `User intent: "${intent}"`,
    `Ferment: ${plan?.title ?? "(untitled)"}`,
    `Goal: ${plan?.goal ?? "(none specified)"}`,
    plan?.success_criteria?.length ? `Success criteria (the P3 checklist):\n${plan.success_criteria.map((criterion) => `  - ${criterion}`).join("\n")}` : "",
    "",
    "What each phase reported:",
    ...phases.map((phase) => `  ${phase.index}. ${phase.name}\n     summary: ${phase.summary}\n     phase gates: ${phase.verdicts}`),
    "",
    "The machine is not in your context — C1 and C3 both ask for evidence, so go and look. Do not fix anything.",
    "",
    'You must produce verdicts for the three ferment-scope gates below. A "flag" verdict refuses ship.',
    "",
    renderGateGuidance(SHIP_GATES),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The phase grader, ported from kimchi's `buildPhaseGraderPrompt`.
 *
 * kimchi spawns this one as a SUBAGENT with tools ("Verify the agent's claims independently using your
 * tools"), unlike its other two judges — so a background agent step is the faithful rendering here, not
 * a concession. Its grade drives advancement: A/B advance, C/D/F refuse.
 */
export function phaseGraderPrompt(args: {
  plan: Plan | undefined;
  phase: { name: string; goal: string };
  phaseSummary: string;
  stepSummaries: string;
  gateVerdicts: readonly { id: string; verdict: string; rationale: string }[];
  diff: { available: boolean; filesChanged: string; diffSnippet: string };
  cwd: string;
}): string {
  const { plan, phase, phaseSummary, stepSummaries, gateVerdicts, diff, cwd } = args;
  const parts: string[] = [];
  parts.push("You are grading a completed phase of an autonomous coding ferment.");
  parts.push("Verify the agent's claims independently using your tools, then produce a grade as JSON.");
  parts.push("");
  parts.push(`Ferment: "${plan?.title ?? "(untitled)"}"`);
  parts.push(`Phase: "${phase.name}"`);
  parts.push(`Phase goal: ${phase.goal || "(none specified)"}`);
  parts.push(`Phase summary: ${phaseSummary || "(none)"}`);
  if (stepSummaries.trim().length > 0) {
    parts.push("");
    parts.push("Step summaries:");
    parts.push(stepSummaries);
  }
  parts.push("");
  parts.push("Phase-scope gate verdicts (agent self-reported — verify independently):");
  for (const verdict of gateVerdicts) parts.push(`  ${verdict.id} (${verdict.verdict}): ${verdict.rationale}`);
  if (diff.available) {
    parts.push("");
    parts.push("--- PHASE DIFF ---");
    parts.push(`Files changed:\n${diff.filesChanged || "(none recorded)"}`);
    if (diff.diffSnippet) parts.push(`\nDiff snippet:\n\`\`\`diff\n${diff.diffSnippet}\n\`\`\``);
  } else {
    parts.push("");
    parts.push("(No diff available — use your tools to inspect files directly.)");
  }
  parts.push("");
  parts.push(`Working directory: ${cwd}`);
  return parts.join("\n");
}

/**
 * What kimchi tells the agent when the grader refuses the phase: the recommendations, and to address
 * them before completing the phase again. In kimchi this arrives as a tool error to the planner, which
 * then dispatches the rework; here it is the rework worker's own prompt.
 */
export function phaseReworkPrompt(args: {
  plan: Plan | undefined;
  phase: { name: string; goal: string };
  grade: PhaseGrade | undefined;
  flags: readonly { id: string; rationale: string; evidence: string }[];
  minimum: string;
  retry: number;
  maxRetries: number;
}): string {
  const { plan, phase, grade, flags, minimum, retry, maxRetries } = args;

  // A phase is refused for either reason, and kimchi checks them in this order: a flagged F gate feeds
  // the retry pipeline before the grader is ever consulted, so a flagged phase has no grade to report.
  if (flags.length > 0) {
    return [
      gateRefusalText({ what: `Phase "${phase.name}"`, flags, recall: "complete the phase again" }),
      "",
      `Ferment: ${plan?.title ?? "(untitled)"}`,
      `Phase goal: ${phase.goal}`,
      `Retry ${retry}/${maxRetries}.`,
      "",
      "Change the machine so the flagged gates hold — the phase is judged again on what it finds.",
    ].join("\n");
  }

  return [
    `**Phase "${phase.name}"** cannot complete — the grader assigned grade ${grade?.grade ?? "?"}, minimum required is ${minimum} (retry ${retry}/${maxRetries}).`,
    "",
    `Ferment: ${plan?.title ?? "(untitled)"}`,
    `Phase goal: ${phase.goal}`,
    `Grader's rationale: ${grade?.rationale ?? "(none)"}`,
    "",
    "Recommendations:",
    ...(grade?.recommendations ?? []).map((rec, index) => `  ${index + 1}. ${rec}`),
    "",
    "Address the recommendations above. Change the machine — the phase is graded again on what it finds,",
    "not on what you say you did.",
  ].join("\n");
}

/** Verbatim from kimchi's `STEP_VERIFICATION_SYSTEM`, plus its user message (`judgeStepVerification`). */
export function verifyTriagePrompt(args: { step: PlannedStep; command: string; exitCode: number; stdout: string; stderr: string }): string {
  const { step, command, exitCode, stdout, stderr } = args;
  return `You are a strict verification triage judge. A step's verification command exited non-zero. You will decide:
- "pass":  the non-zero exit is benign (grep matched nothing as expected, linter warnings only, etc.). The work is acceptable.
- "retry": the failure looks transient (network blip, race, missing setup file that should exist next try).
- "fail":  the failure is a real implementation defect that must be fixed.

Be skeptical. When in doubt between pass/retry/fail, prefer "fail" — false-pass is the worst outcome.

Judge from the output below and nothing else. In kimchi this triage is a single model call with no tools, so do not re-run the command or inspect the machine — classify what you are shown.

Step: "${step.description}"
Verification: \`${command}\`
Exit: ${exitCode}
stdout:
${stdout.slice(0, 1200)}
stderr:
${stderr.slice(0, 1200)}`;
}

/** kimchi truncates judge inputs at 1200 chars; the same cap applies to what a retry is shown. */
function clip(text: string, max = 1200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
