/**
 * A terminal-bench solver, as a workflow (spec §3): (survey)* → (implement → verify)* .
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
import { planSchema, taskInputSchema, verifySchema } from "./contract.ts";
import { implementPrompt, surveyLandingPrompt, surveyPrompt, verifyPrompt } from "./prompts.ts";
import { IMPLEMENT_FLOOR_MS, implementBoxMs, RECON_MAX_PASSES, ROUND_MARGIN_SEC, ROUND_SAFETY_VALVE, SURVEY_CAP_MS, SURVEY_LANDING_MS, VERIFY_CAP_MS } from "./schedule.ts";

/** `provider/model` for every step; the adapter pins this so subagents match the parent (spec §9.5). */
const MODEL = process.env.TB_MODEL ?? "kimchi-dev/kimi-k2.7";

// -- Steps ------------------------------------------------------------------------------------------

/** Clock and pass number at the top of a recon pass, so `survey` knows whether it is looking or landing. */
const reconClock = createStep({
  name: "recon-clock",
  description: "How much time is left, and which recon pass this is",
  output: Type.Object({ remainingSec: Type.Number(), pass: Type.Number() }),
  run: ({ ctx }) => {
    const task = ctx.getInitData<{ deadlineIso: string }>();
    const previous = ctx.getStepResult<{ pass: number }>("recon/recon-check");
    const remainingSec = (new Date(task?.deadlineIso ?? Date.now()).getTime() - Date.now()) / 1000;
    return { remainingSec, pass: (previous?.pass ?? 0) + 1 };
  },
});

/**
 * Did recon produce a contract, and can we afford to try again?
 *
 * `survey` is the only step whose output TWO others consume — `implement` works against its criteria and
 * `verify` checks against them — so losing it degrades the work and blinds the check at once. It was
 * nonetheless the least protected step in the workflow: hard cap, no repeat, and `optional`, so a
 * timeout simply deleted the contract (measured: four surveys in six died at their cap, leaving those
 * runs with nothing). Looping until it has actually produced criteria inverts that, and costs nothing
 * in the common case where the first pass succeeds.
 */
const reconCheck = createStep({
  name: "recon-check",
  description: "Decide whether another recon pass is needed and affordable",
  output: Type.Object({ hasCriteria: Type.Boolean(), mustStop: Type.Boolean(), pass: Type.Number() }),
  run: ({ ctx, logger }) => {
    const task = ctx.getInitData<{ deadlineIso: string }>();
    const design = ctx.getStepResult<Static<typeof planSchema>>("survey");
    const opened = ctx.getStepResult<{ pass: number }>("recon-clock");
    const pass = opened?.pass ?? 1;
    const remainingSec = (new Date(task?.deadlineIso ?? Date.now()).getTime() - Date.now()) / 1000;
    const hasCriteria = (design?.criteria?.length ?? 0) > 0;
    // Recon must never starve the work. Stop the moment another pass would eat the smallest round that
    // could still land something — an unverified implementation beats a perfect contract and no time.
    const reserveSec = (SURVEY_LANDING_MS + IMPLEMENT_FLOOR_MS + VERIFY_CAP_MS) / 1000 + ROUND_MARGIN_SEC;
    const mustStop = remainingSec < reserveSec || pass >= RECON_MAX_PASSES;
    logger.info("recon pass finished", { pass, hasCriteria, remainingSec: Math.round(remainingSec), mustStop });
    return { hasCriteria, mustStop, pass };
  },
});

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
  // A first pass explores; a later one only writes down what that pass already found, so it gets a much
  // smaller box (see SURVEY_LANDING_MS). Sizing this from run state is what makes the recon loop cheap
  // enough to be worth having.
  maxDurationMs: ({ ctx }) => {
    const recon = ctx.getStepResult<{ pass: number; remainingSec: number }>("recon-clock");
    const box = (recon?.pass ?? 1) > 1 ? SURVEY_LANDING_MS : SURVEY_CAP_MS;
    return Math.max(30_000, Math.min(box, (recon?.remainingSec ?? 0) * 1000 - ROUND_MARGIN_SEC * 1000));
  },
  optional: true,
  // Still no in-place repeat: a COLD restart would redo the exploration and die at the same wall (two
  // tasks lost 216s and 270s of an 855s run to exactly that). The recon loop around this step is the
  // replacement — it comes back with the session intact, so the next pass continues instead of redoing.
  retry: { maxRetry: 0 },
  // The one reason the loop works: pass two reopens pass one's conversation and still holds everything
  // it read, so it only has to write the answer down.
  resumable: true,
  prompt: ({ ctx }) => {
    const task = ctx.getInitData<{ instruction: string }>();
    const recon = ctx.getStepResult<{ remainingSec: number; pass: number }>("recon-clock");
    const remainingSec = recon?.remainingSec ?? 0;
    // A later pass has already looked; sending it back to explore is how a recon loop becomes a budget
    // leak. It gets the landing prompt and a much smaller box instead.
    return (recon?.pass ?? 1) > 1
      ? surveyLandingPrompt(SURVEY_LANDING_MS / 1000, remainingSec)
      : surveyPrompt(task?.instruction ?? "(missing)", SURVEY_CAP_MS / 1000, remainingSec);
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
  // No output schema on purpose. This step's product is the machine, and `verify` reads the machine —
  // so nothing downstream needs it to say anything, and demanding a shape it must hit adds only a way
  // to fail at work that already landed. It used to report {changes, ranChecks, incomplete}; that
  // summary was redundant with the session the next round resumes, empty in most runs (the step
  // usually spends its whole box), and twice fatal: replies beginning `/auto` and `/perm` failed the
  // step and discarded the round with the edits already on disk.
  background: true,
  // A share of what is left when THIS round opens (see IMPLEMENT_SHARE_OF_REMAINING), so the first
  // round is long and each later one is smaller. `optional` so hitting the box costs the round rather
  // than the run: the work it did land stays on disk, `verify` still gets to say what is actually true,
  // and the loop can spend what remains repairing it.
  maxDurationMs: ({ ctx }) => implementBoxMs(ctx.getStepResult<{ remainingSec: number }>("budget")?.remainingSec ?? 0),
  optional: true,
  retry: { maxRetry: 0 },
  // The one step that continues across rounds (spec §2.2). Being time-boxed, it is the step most likely
  // to be cut off mid-job, and a cold restart made it re-read and re-derive what the last round already
  // had — measured as the reason tasks needing sustained work never converged. `survey` and `verify`
  // stay cold on purpose: one is cheap, and the other's whole value is looking with fresh eyes.
  resumable: true,
  prompt: ({ ctx }) => {
    const task = ctx.getInitData<{ instruction: string }>();
    const design = ctx.getStepResult<Static<typeof planSchema>>("recon/survey");
    const round = ctx.getStepResult<{ remainingSec: number; round: number }>("budget");
    const lastVerify = ctx.getStepResult<Static<typeof verifySchema>>("verify");
    const remainingSec = round?.remainingSec ?? 0;
    return implementPrompt({
      instruction: task?.instruction ?? "(missing)",
      design,
      failures: lastVerify?.failures ?? [],
      continuing: (round?.round ?? 1) > 1,
      stepSec: implementBoxMs(remainingSec) / 1000,
      remainingSec,
    });
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
  maxDurationMs: VERIFY_CAP_MS,
  // A verifier that overran tells us nothing, but it must not be the thing that ends the run either:
  // `checkpoint` below reads a missing verdict as "not passed", which is the safe reading.
  optional: true,
  retry: { maxRetry: 0 },
  prompt: ({ ctx }) => {
    const task = ctx.getInitData<{ instruction: string }>();
    const design = ctx.getStepResult<Static<typeof planSchema>>("recon/survey");
    const round = ctx.getStepResult<{ remainingSec: number }>("budget");
    return verifyPrompt({
      instruction: task?.instruction ?? "(missing)",
      design,
      stepSec: VERIFY_CAP_MS / 1000,
      remainingSec: round?.remainingSec ?? 0,
    });
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
  }),
  run: ({ ctx, logger }) => {
    const task = ctx.getInitData<{ deadlineIso: string }>();
    // `undefined` when `verify` itself failed or was time-boxed out (it is `optional`): the safe
    // reading is "not passed", so the loop spends another round rather than declaring victory blind.
    const result = ctx.getStepResult<Static<typeof verifySchema>>("verify");
    const opened = ctx.getStepResult<{ round: number; remainingSec: number }>("budget");
    const round = opened?.round ?? 0;
    const remainingSec = (new Date(task?.deadlineIso ?? Date.now()).getTime() - Date.now()) / 1000;
    // Stop when the NEXT round — whose size is now known exactly, because `implement` takes a fixed
    // share of whatever is left — would not fit in what remains.
    //
    // This is computable rather than estimated, which the previous two rules were not. Deciding from a
    // fixed round COUNT ended runs holding most of their budget (`build-pov-ray` finished with 11170s of
    // 12000s unspent). Deciding from the round that just happened fixed the idling but admitted rounds
    // that could not finish, and 15 runs were killed by the deadline mid-edit. Since the box is
    // `share * remaining`, the condition below is just `remaining * (1 - share) < verify + margin`: the
    // point at which the part of the clock a round does NOT consume no longer covers checking and
    // settling. It cannot admit a round it knows will overrun.
    const spendableSec = remainingSec - VERIFY_CAP_MS / 1000 - ROUND_MARGIN_SEC;
    const mustStop = spendableSec < IMPLEMENT_FLOOR_MS / 1000 || round >= ROUND_SAFETY_VALVE;
    logger.info("round finished", { round, allPass: result?.allPass ?? false, remainingSec: Math.round(remainingSec), spendableSec: Math.round(spendableSec), mustStop });
    return {
      allPass: result?.allPass === true,
      mustStop,
      remainingSec,
      round,
    };
  },
});

const reconRound = createWorkflow({ name: "recon-round" }).then(reconClock).then(survey).then(reconCheck).commit();

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
  // Recon repeats until it has actually produced a contract. `survey` is the only step TWO others
  // consume, so an empty result degrades the work and blinds the check at once — yet it used to be the
  // least protected step here, and four surveys in six once died at their cap leaving nothing behind.
  // A later pass reopens the same session and only writes down what the first already found.
  .dountil(reconRound, (_ctx, last) => (last as { hasCriteria: boolean }).hasCriteria || (last as { mustStop: boolean }).mustStop, {
    name: "recon",
    maxIterations: RECON_MAX_PASSES + 1, // a guard; `recon-check` stops on the clock and the pass count
  })
  // Rounds continue until an independent check passes everything, the clock runs low, or we run out
  // of rounds — `maxIterations` is a guard, not the intended exit (spec §3.3).
  .dountil(solveRound, (_ctx, last) => (last as { allPass: boolean; mustStop: boolean }).allPass || (last as { mustStop: boolean }).mustStop, {
    name: "solve",
    // A runaway guard, not the exit: `checkpoint` ends rounds on the clock, so reaching this means that
    // logic is broken and the run should fail loudly rather than spin.
    maxIterations: 20,
  })
  .then(report)
  .commit();
