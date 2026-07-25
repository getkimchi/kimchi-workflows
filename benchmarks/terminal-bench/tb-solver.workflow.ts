/**
 * A terminal-bench solver, as a workflow (spec §3): survey → (implement → verify)* .
 *
 * The bet this workflow makes is narrow and, I think, the only one worth making at the workflow level:
 * a benchmark task is graded on the machine's FINAL STATE by tests the agent never sees, and the
 * dominant failure mode is not "couldn't figure it out" — it is stopping while something is still
 * broken. So the structure exists to make stopping expensive:
 *
 *  - `plan` does not produce prose. It produces ACCEPTANCE CRITERIA, each with a shell command that
 *    checks it and the result that command must show. That list is the contract everything downstream
 *    is measured against, and it is frozen once written (a later step may not redefine its own goal).
 *  - `verify` is a FRESH agent (its own context window, spec §2.2's isolation) that receives the
 *    criteria and the task — never the implementer's story about what it did. It re-derives the truth
 *    by running the checks. An implementer reviewing its own transcript agrees with itself; one that
 *    has to produce failing command output does not.
 *  - the loop is what turns a failed check back into work, bounded by `maxIterations` and by the wall
 *    clock (`checkpoint` below), so the run always leaves time to finish rather than being killed
 *    mid-edit by the harness timeout.
 *
 * Every step is `background: true` — an isolated subagent (spec §2.2), which in the PI host means a
 * fresh subprocess of the harness binary that is actually running (src/host/pi-agent.ts). The
 * orchestrating session therefore spends no tokens of its own and holds no conversation: all state
 * moves through the engine's data flow, which is exactly what lets `verify` be honest.
 *
 * That shape is also, unexpectedly, the cheap one. Measured against the stock single-session agent over
 * four terminal-bench tasks (kimi-k2.7, equal reward 4/4): 384k tokens vs 2.17M, a 5.6x reduction. One
 * long session re-sends its entire accumulated history every turn, so cost grows with the square of the
 * work; a chain of short sessions each pays for its own small context and then exits.
 *
 * What that measurement made expensive instead is WALL TIME — and wall time is what a benchmark
 * actually rations (one task came within half a minute of its 900s timeout). Every step costs a process
 * spawn plus a fresh system prompt (~14k tokens before it does anything), so step count, not prompt
 * size, is the lever. Hence the shape above: `orient` folded into `survey` (the planner reads the
 * machine itself rather than a summary of it), and `sweep` folded into `verify` (which re-checks from a
 * clean shell anyway) and into `implement` (which cleans up after itself). Five subagents became three.
 */
import { type Static, Type } from "typebox";
import { createAgentStep, createStep, createWorkflow } from "../../src/flow/index.ts";

/** `provider/model` for every step; the adapter pins this so subagents match the parent (spec §9.5). */
const MODEL = process.env.TB_MODEL ?? "kimchi-dev/kimi-k2.7";

/** Fraction of the remaining budget at which the loop stops opening a new round and goes to `sweep`. */
const RESERVE_FRACTION = 0.2;
/** Never start another implement→verify round with less than this, whatever the fraction says. */
const MIN_ROUND_SECONDS = 90;
/**
 * How many implement→verify rounds to spend before settling for what we have. This is a POLICY, applied
 * by `checkpoint` below, deliberately lower than the loop's own `maxIterations` guard: hitting the guard
 * crashes the run (spec §3.3) and would skip the final sweep, leaving the machine unchecked and littered
 * with scratch files — the guard is there for a runaway, not as the way rounds normally end.
 */
const MAX_ROUNDS = 3;

export const taskInputSchema = Type.Object({
  /** The verbatim terminal-bench instruction. */
  instruction: Type.String(),
  /** When the harness will kill the agent phase — ISO 8601. */
  deadlineIso: Type.String(),
});

const criterionSchema = Type.Object({
  id: Type.String({ description: "Short stable id, e.g. `c1`." }),
  statement: Type.String({ description: "What must be true, in one sentence." }),
  check: Type.String({ description: "A single shell command that tests it, non-interactive, exits 0 on success." }),
  expect: Type.String({ description: "What the command's output/exit status must show for this to pass." }),
});

const planSchema = Type.Object({
  approach: Type.String({ description: "The intended change, in a few sentences." }),
  criteria: Type.Array(criterionSchema, { description: "Acceptance criteria, each independently checkable." }),
});

const implementSchema = Type.Object({
  changes: Type.String({ description: "What you actually changed, as paths and one-line reasons." }),
  ranChecks: Type.String({ description: "Which acceptance checks you ran yourself, and their real output." }),
  incomplete: Type.String({ description: "Anything you could NOT finish. Empty string if nothing." }),
});

const verifySchema = Type.Object({
  allPass: Type.Boolean({ description: "True only if every criterion's check actually passed when you ran it." }),
  failures: Type.Array(
    Type.Object({
      id: Type.String(),
      actual: Type.String({ description: "The real command output/exit status you observed." }),
      diagnosis: Type.String({ description: "Why it failed, concretely." }),
    }),
    { description: "Empty when everything passes." },
  ),
});

/**
 * The framing every step gets. It says what is graded and what the clock is — deliberately NOT "this is
 * a benchmark, passing is extremely important". Naming the benchmark and raising the stakes is what
 * invites test-hunting and hardcoded outputs, and since the tests are not in the container during the
 * agent phase, those attempts burn the clock and then fail anyway.
 */
const GRADING_CONTRACT = [
  "HOW THIS IS GRADED",
  "- The FINAL STATE of this machine is what counts. It is checked by automated tests that are not",
  "  present here and that you will never see.",
  "- Only genuinely working behaviour scores. Do not go looking for test files, do not write or edit",
  "  tests, and never hardcode a value to satisfy a checker — a stub that returns the expected answer",
  "  scores zero, and so does a passing check over functionality that does not really work.",
  "- Everything must survive your shell exiting: write to disk, install properly, restart services so",
  "  they are actually running. Never rely on session state (exported vars, cwd, an activated venv).",
  "- Follow the task's stated requirements exactly — paths, filenames, formats and exit codes are",
  "  usually what is being checked.",
].join("\n");

/**
 * Steps that think, rather than act, say so in the same words. Observed live: without this, the
 * planner solved a `fix-git` task itself and the implementer then reported "no changes needed" — the
 * run passed, but the division of labour that makes `verify` meaningful had quietly collapsed.
 */
const READ_ONLY = [
  "THIS STEP DOES NOT CHANGE ANYTHING.",
  "Inspect all you like with read-only commands, but do not edit, create, delete, move, install, or",
  "run anything that mutates this machine (no writes, no git commit/merge/checkout, no package",
  "installs). A later step does the work; doing it here would leave it unverified.",
].join("\n");

function timeLine(remainingSec: number): string {
  return `TIME: about ${Math.max(0, Math.round(remainingSec))}s remain before this machine is taken away and graded. A correct, verified partial result beats an elaborate unfinished one — do not start work you cannot land in the time left.`;
}

function criteriaBlock(criteria: readonly { id: string; statement: string; check: string; expect: string }[]): string {
  return criteria.map((c) => `  [${c.id}] ${c.statement}\n        check:  ${c.check}\n        expect: ${c.expect}`).join("\n");
}

// -- Steps ------------------------------------------------------------------------------------------

/**
 * Look at the machine and turn the task into a checkable contract, in one step. Reconnaissance and
 * planning were separate until measurement showed what a step really costs (a spawn plus a fresh system
 * prompt); merging them also removes a lossy hand-off, since the planner now reads the evidence itself
 * instead of another agent's summary of it.
 */
const survey = createAgentStep({
  name: "survey",
  description: "Inspect the machine and derive acceptance criteria",
  output: planSchema,
  background: true,
  maxDurationMs: 300_000,
  retry: { maxRetry: 1 },
  prompt: ({ ctx }) => {
    const task = ctx.getInitData<{ instruction: string }>();
    const budget = ctx.getStepResult<{ remainingSec: number }>("budget");
    return [
      "Inspect this machine and turn the task below into an acceptance contract that can be checked by",
      "running commands.",
      "",
      "TASK:",
      task?.instruction ?? "(missing)",
      "",
      READ_ONLY,
      "",
      GRADING_CONTRACT,
      "",
      timeLine(budget?.remainingSec ?? 0),
      "",
      "First look around (ls, cat, find, git status/log, running processes, installed tooling) until you",
      "know what is actually here — do not plan against a machine you have imagined.",
      "",
      "Then write the acceptance criteria: every requirement the task states, plus the ones it clearly",
      "implies (a program that must run has to exist AND be executable AND produce the stated output).",
      "Rules for criteria:",
      "  - each is checkable by ONE non-interactive shell command that exits 0 exactly when it holds;",
      "  - the command must test real behaviour (run the program, query the service, parse the output),",
      "    not merely that a file exists — unless existence is genuinely all that is required;",
      "  - no command may reference tests you have not seen, or write to the paths under test;",
      "  - keep it to the handful that actually decide the outcome, ordered most important first.",
      "Also give the approach you would take, briefly.",
    ].join("\n");
  },
});

/** Wall-clock reading at the top of a round, so the prompts can talk about time honestly. */
const budget = createStep({
  name: "budget",
  description: "How much time is left",
  output: Type.Object({ remainingSec: Type.Number(), round: Type.Number() }),
  run: ({ ctx }) => {
    const task = ctx.getInitData<{ deadlineIso: string }>();
    // The PREVIOUS round's checkpoint — never this step's own key, which is in flight right now
    // (spec §3.9: a step cannot observe itself, and the engine throws rather than lie about it).
    const previous = ctx.getStepResult<{ round: number }>("solve/checkpoint");
    const remainingSec = (new Date(task?.deadlineIso ?? Date.now()).getTime() - Date.now()) / 1000;
    return { remainingSec, round: (previous?.round ?? 0) + 1 };
  },
});

const implement = createAgentStep({
  name: "implement",
  description: "Do the work",
  output: implementSchema,
  background: true,
  maxDurationMs: 900_000,
  retry: { maxRetry: 1 },
  prompt: ({ ctx }) => {
    const task = ctx.getInitData<{ instruction: string }>();
    const design = ctx.getStepResult<Static<typeof planSchema>>("survey");
    const round = ctx.getStepResult<{ remainingSec: number; round: number }>("budget");
    const lastVerify = ctx.getStepResult<Static<typeof verifySchema>>("verify");
    const failures = lastVerify?.failures ?? [];

    const retryBlock =
      failures.length > 0
        ? [
            "",
            "A PREVIOUS ATTEMPT WAS ALREADY MADE AND AN INDEPENDENT CHECK FOUND IT INCOMPLETE.",
            "These criteria did NOT pass — fix the underlying cause, do not paper over them:",
            ...failures.map((f) => `  [${f.id}] observed: ${f.actual}\n        diagnosis: ${f.diagnosis}`),
          ].join("\n")
        : "";

    return [
      "Complete this task on the machine you are on.",
      "",
      "TASK:",
      task?.instruction ?? "(missing)",
      "",
      "ACCEPTANCE CRITERIA — these are what your work is measured against:",
      criteriaBlock(design?.criteria ?? []),
      "",
      `PLANNED APPROACH: ${design?.approach ?? "(none)"}`,
      retryBlock,
      "",
      GRADING_CONTRACT,
      "",
      timeLine(round?.remainingSec ?? 0),
      "",
      "Do the work now, then RUN EACH CHECK COMMAND ABOVE YOURSELF and fix what fails. Delete any",
      "scratch files, probe scripts or sample outputs YOU created that the task did not ask for — they",
      "can only confuse whatever grades this machine. Report only",
      "what you actually observed — if something is still broken or unfinished, say so plainly in",
      "`incomplete`; an honest gap is worth more here than a claim that does not hold up, because it",
      "is the input to the next round.",
    ].join("\n");
  },
});

/**
 * The adversarial half. It gets the task and the criteria and NOTHING the implementer said, so it
 * cannot inherit a false belief — it has to go and look.
 */
const verify = createAgentStep({
  name: "verify",
  description: "Independently check every criterion by running it",
  output: verifySchema,
  background: true,
  maxDurationMs: 300_000,
  retry: { maxRetry: 1 },
  prompt: ({ ctx }) => {
    const task = ctx.getInitData<{ instruction: string }>();
    const design = ctx.getStepResult<Static<typeof planSchema>>("survey");
    const round = ctx.getStepResult<{ remainingSec: number }>("budget");
    return [
      "You are auditing a machine that someone else has just worked on. Assume nothing they may have",
      "claimed is true: your job is to find out what is actually the case, by running commands.",
      "",
      "THE TASK THEY WERE GIVEN:",
      task?.instruction ?? "(missing)",
      "",
      "CRITERIA TO CHECK — run each command and observe the real result:",
      criteriaBlock(design?.criteria ?? []),
      "",
      timeLine(round?.remainingSec ?? 0),
      "",
      "Rules:",
      "  - run every check FROM A CLEAN SHELL (`bash -lc '<check>'`, starting from /), never from state",
      "    you have set up yourself: the machine is graded after everyone has left, so anything that",
      "    depends on an exported variable, a cwd or an activated venv is already broken;",
      "  - run every check; never mark one passed because it looks like it should pass;",
      "  - if a check command is itself broken, judge the underlying criterion by other means and say so;",
      "  - go one step further where it is cheap: an end-to-end run of what the task asks for often",
      "    fails where a narrow check passes;",
      "  - DO NOT FIX ANYTHING. Report only. Someone else gets one more round to repair what you find.",
      "  - set allPass true only if you personally saw every criterion hold.",
    ].join("\n");
  },
});

/** Fresh clock reading AFTER the round, so the loop decides on current time rather than a stale one. */
const checkpoint = createStep({
  name: "checkpoint",
  description: "Decide whether another round is affordable",
  output: Type.Object({ allPass: Type.Boolean(), mustStop: Type.Boolean(), remainingSec: Type.Number(), round: Type.Number() }),
  run: ({ ctx, logger }) => {
    const task = ctx.getInitData<{ deadlineIso: string }>();
    const result = ctx.getStepResult<Static<typeof verifySchema>>("verify");
    const round = ctx.getStepResult<{ round: number }>("budget")?.round ?? 0;
    const remainingSec = (new Date(task?.deadlineIso ?? Date.now()).getTime() - Date.now()) / 1000;
    const reserve = Math.max(MIN_ROUND_SECONDS, remainingSec * RESERVE_FRACTION);
    const mustStop = remainingSec <= reserve || round >= MAX_ROUNDS;
    logger.info("round finished", { round, allPass: result?.allPass ?? false, remainingSec: Math.round(remainingSec), mustStop });
    return { allPass: result?.allPass === true, mustStop, remainingSec, round };
  },
});

const solveRound = createWorkflow({ name: "solve-round" }).then(budget).then(implement).then(verify).then(checkpoint).commit();

const report = createStep({
  name: "report",
  description: "Summarize the run for the log",
  output: Type.Object({ allPass: Type.Boolean(), rounds: Type.Number(), remainingSec: Type.Number() }),
  run: ({ ctx }) => {
    const final = ctx.getStepResult<{ allPass: boolean; remainingSec: number; round: number }>("solve/checkpoint");
    return { allPass: final?.allPass === true, rounds: final?.round ?? 0, remainingSec: Math.round(final?.remainingSec ?? 0) };
  },
});

export default createWorkflow({
  name: "tb-solver",
  description: "Solve a terminal-bench task: survey it into acceptance criteria, then implement/verify in rounds until they hold",
  input: taskInputSchema,
  defaultModel: MODEL,
})
  .then(budget)
  .then(survey)
  // Rounds continue until an independent check passes everything, the clock runs low, or we run out
  // of rounds — `maxIterations` is a guard, not the intended exit (spec §3.3).
  .dountil(solveRound, (_ctx, last) => (last as { allPass: boolean; mustStop: boolean }).allPass || (last as { mustStop: boolean }).mustStop, {
    name: "solve",
    // One above MAX_ROUNDS: `checkpoint` is what ends the rounds, so this only ever fires if that logic
    // itself is broken — which should crash loudly rather than spin.
    maxIterations: MAX_ROUNDS + 1,
  })
  .then(report)
  .commit();
