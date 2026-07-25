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
import { criteriaBlock, GRADING_CONTRACT, implementSchema, planSchema, READ_ONLY, taskInputSchema, timeLine, verifySchema } from "./contract.ts";

/** `provider/model` for every step; the adapter pins this so subagents match the parent (spec §9.5). */
const MODEL = process.env.TB_MODEL ?? "kimchi-dev/kimi-k2.7";

/**
 * The agent phase's total budget. Every per-step wall-time cap below is a FRACTION of it, because a cap
 * expressed in absolute milliseconds is meaningless against a clock it does not know: v2 gave
 * `implement` 900s inside an 855s run, so the cap could never fire, and two tasks the baseline solved
 * were lost to a single step that ran until the harness killed the run mid-edit — no verify, no repair
 * round, no settle.
 */
const BUDGET_SEC = Math.max(60, Number(process.env.TB_AGENT_TIMEOUT_SEC ?? 900));
const share = (fraction: number, capSec: number) => Math.round(Math.min(BUDGET_SEC * fraction, capSec) * 1000);

/** Fraction of the remaining budget at which the loop stops opening a new round. */
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
  // Reconnaissance must not eat the hour — but nor may it end the run. Measured: a 12% cap made a slow
  // survey blow its budget twice and crash the whole run at the 216s mark with NOTHING attempted and
  // 640s left on the clock. It is `optional` now, and the steps below fall back to working straight
  // from the task statement, which is roughly what a plain agent would have done anyway.
  maxDurationMs: share(0.15, 180_000),
  optional: true,
  // No repeat. A step that blew its WALL-TIME budget will blow it again — the work was too big for the
  // box, and nothing about that changed — so the repeat just burns the budget twice for no output.
  // Measured: two tasks lost 216s and 270s of a 855s run to exactly this. The engine cannot know that
  // in general (a repeat is right for a thrown error), but here it is: `optional` above already means a
  // failed survey costs the criteria, not the run.
  retry: { maxRetry: 0 },
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
      "know what is actually here — do not plan against a machine you have imagined. Be quick about it:",
      "a few commands, not an audit. You are not solving the task in this step, and every second here is",
      "one the work itself does not get.",
      "",
      "Then write the acceptance criteria: every requirement the task states, plus the ones it clearly",
      "implies (a program that must run has to exist AND be executable AND produce the stated output).",
      "Rules for criteria:",
      "  - each is checkable by ONE non-interactive shell command that exits 0 exactly when it holds;",
      "  - prefer a check that costs seconds over one that costs minutes: it is run more than once, by",
      "    more than one step. Where the honest check is expensive (cracking a hash, a full test suite),",
      "    checking the ARTIFACT it should have produced is usually just as decisive;",
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
  // Time-boxed to a share of the run so a round always ends with the clock intact, and `optional` so
  // hitting that box costs the round rather than the run: the work it did land stays on disk, `verify`
  // still gets to say what is actually true, and the loop can spend what remains repairing it.
  maxDurationMs: share(0.45, 420_000),
  optional: true,
  retry: { maxRetry: 0 },
  // The one step that continues across rounds (spec §2.2). Being time-boxed, it is the step most likely
  // to be cut off mid-job, and a cold restart made it re-read and re-derive what the last round already
  // had — measured as the reason tasks needing sustained work never converged. `survey` and `verify`
  // stay cold on purpose: one is cheap, and the other's whole value is looking with fresh eyes.
  resumable: true,
  prompt: ({ ctx }) => {
    const task = ctx.getInitData<{ instruction: string }>();
    const design = ctx.getStepResult<Static<typeof planSchema>>("survey");
    const round = ctx.getStepResult<{ remainingSec: number; round: number }>("budget");
    const lastVerify = ctx.getStepResult<Static<typeof verifySchema>>("verify");
    const failures = lastVerify?.failures ?? [];
    // The previous round's report, carried by `checkpoint` — NOT read from "implement" directly, which
    // is this very step and is in flight while its prompt is built (spec §3.9: a step cannot observe
    // itself, and the engine throws rather than pretend). Each round is a fresh subagent with no
    // memory, so without this a time-boxed implementer restarts cold and re-derives what the last one
    // already knew — measured as the reason a task needing sustained work never converged.
    const previous = ctx.getStepResult<{ lastChanges: string; lastIncomplete: string }>("solve/checkpoint");

    const priorWork = previous?.lastChanges
      ? [
          "",
          "WHAT THE PREVIOUS ROUND DID (it ran out of time, or its work was judged incomplete — you are",
          "continuing it, not starting over; re-read the files before you change them):",
          `  changed: ${previous.lastChanges || "(nothing reported)"}`,
          `  unfinished: ${previous.lastIncomplete || "(nothing reported)"}`,
        ].join("\n")
      : "";

    const retryBlock =
      failures.length > 0
        ? [
            "",
            "AN INDEPENDENT CHECK FOUND THE WORK INCOMPLETE.",
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
      (design?.criteria?.length ?? 0) > 0 ? criteriaBlock(design?.criteria ?? []) : "  (none were derived — satisfy the task statement above, in full)",
      "",
      `PLANNED APPROACH: ${design?.approach ?? "(none derived — work from the task statement above)"}`,
      priorWork,
      retryBlock,
      "",
      GRADING_CONTRACT,
      "",
      timeLine(round?.remainingSec ?? 0),
      "",
      "You are time-boxed. If you cannot finish everything, land the most important criteria FIRST and",
      "leave the machine in a working state — a partial result that runs beats a half-applied edit that",
      "does not, and another round may follow this one.",
      "",
      "Do the work now, then RUN EACH CHECK COMMAND ABOVE YOURSELF and fix what fails — catching your",
      "own mistakes here is worth more than any later step can be, because you still have the context to",
      "fix them. (Measured: an implementer told to leave checking to the verifier lands broken work and",
      "the run rarely has time to repair it.)",
      "",
      "Delete any scratch files, probe scripts or sample outputs YOU created that the task did not ask",
      "for — they can only confuse whatever grades this machine. Report what you actually observed: if",
      "something is still broken or unfinished, say so plainly in `incomplete`, since that is what the",
      "next round starts from.",
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
  maxDurationMs: share(0.18, 200_000),
  // A verifier that overran tells us nothing, but it must not be the thing that ends the run either:
  // `checkpoint` below reads a missing verdict as "not passed", which is the safe reading.
  optional: true,
  retry: { maxRetry: 0 },
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
      (design?.criteria?.length ?? 0) > 0 ? criteriaBlock(design?.criteria ?? []) : "  (none were derived — judge the task statement above on its own terms, end to end)",
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
  output: Type.Object({
    allPass: Type.Boolean(),
    mustStop: Type.Boolean(),
    remainingSec: Type.Number(),
    round: Type.Number(),
    // Carried so the NEXT round's implementer can pick up where this one left off (see `implement`).
    lastChanges: Type.String(),
    lastIncomplete: Type.String(),
  }),
  run: ({ ctx, logger }) => {
    const task = ctx.getInitData<{ deadlineIso: string }>();
    // `undefined` when `verify` itself failed or was time-boxed out (it is `optional`): the safe
    // reading is "not passed", so the loop spends another round rather than declaring victory blind.
    const result = ctx.getStepResult<Static<typeof verifySchema>>("verify");
    const round = ctx.getStepResult<{ round: number }>("budget")?.round ?? 0;
    const work = ctx.getStepResult<Static<typeof implementSchema>>("implement"); // settled by now
    const remainingSec = (new Date(task?.deadlineIso ?? Date.now()).getTime() - Date.now()) / 1000;
    const reserve = Math.max(MIN_ROUND_SECONDS, remainingSec * RESERVE_FRACTION);
    const mustStop = remainingSec <= reserve || round >= MAX_ROUNDS;
    logger.info("round finished", { round, allPass: result?.allPass ?? false, remainingSec: Math.round(remainingSec), mustStop });
    return {
      allPass: result?.allPass === true,
      mustStop,
      remainingSec,
      round,
      lastChanges: work?.changes ?? "",
      lastIncomplete: work?.incomplete ?? "",
    };
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
