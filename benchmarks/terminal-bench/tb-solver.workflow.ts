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
import { criteriaBlock, GRADING_CONTRACT, planSchema, READ_ONLY, taskInputSchema, timeLine, verifySchema } from "./contract.ts";

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

/**
 * Per-step wall-time caps, as a share of THIS run's budget.
 *
 * `implement` and `verify` have no absolute ceiling on purpose. An earlier version capped them at 420s
 * and 200s, which is sensible at 900s and absurd at 12000s — it handed every task the same seven-minute
 * implementation window however long it actually had. A full-benchmark run then spent a mean of 50% of
 * the budget on long tasks (`build-pov-ray`: 7% of 12000s, then stopped). Only `survey` keeps a ceiling:
 * reconnaissance does not get better for taking twenty minutes.
 *
 * The sizes come from what the steps actually cost, measured over a run: implement median 141s, verify
 * median 33s, survey median 135s. Two things follow.
 *
 * `implement` is 20%, not the 45% it was, because a box stopped being a deadline the moment the step
 * became `optional` (running out costs the round, not the run) and `resumable` (the next round continues
 * the same session). It is now a CHECKPOINT INTERVAL, and the right interval is the shortest one that
 * still gets work done between verifications — every checkpoint buys a calibrated list of what is still
 * broken. At 20% the median implement finishes inside its box, and three to four rounds fit where one
 * did before.
 *
 * `verify` is 12% because it is cheap (median 33s, max 107s), so more rounds cost little overhead.
 *
 * `survey` gets 25% (ceiling 400s) rather than 15%, because at 15% FOUR IN TEN surveys hit the cap — and
 * a survey that times out leaves the run with no acceptance criteria at all, which is the one thing
 * everything downstream is built on. The cap is only half the fix: every step is now told ITS OWN box
 * (see `timeLine`), so it paces itself instead of exploring as though it owned the whole run.
 */
/**
 * Recon and checking are sized from what they MEASURABLY COST, with a floor, not from a percentage.
 *
 * A pure fraction has been wrong in both directions. At 25% of the budget survey was a quarter of the
 * run before any work started; cutting it to 8% put the cap (72s at a 900s budget) BELOW the observed
 * median, and four of six surveys then died at their limit — leaving those runs with no acceptance
 * criteria at all, which is the one thing everything downstream is built on. Observed survey durations
 * across runs: 16, 25, 38, 100, 108, 221, 231s. Observed verify: 12, 33, 38, 66, 97, 121, 180s.
 *
 * The floor is what makes these steps survive on short tasks, where a percentage is simply too small to
 * finish the job; the ceiling is what stops them eating a long one.
 */
const SURVEY_CAP_MS = Math.round(Math.min(Math.max(BUDGET_SEC * 0.15, 150), 240) * 1000);
const VERIFY_CAP_MS = Math.round(Math.min(Math.max(BUDGET_SEC * 0.12, 120), 300) * 1000);

/**
 * `implement` takes a share of the time ACTUALLY LEFT, resolved fresh on every round (spec §9.3's
 * function form) — not a fixed fraction of the whole budget.
 *
 * A fixed fraction is the same on every round, which forces a choice between two bad schedules. Small
 * (20%, what this was) fragments the work: a full-benchmark run had 53 of 89 implementations cut off
 * mid-job, each restart re-establishing footing the last one already had. Large enough to be useful
 * overruns instead — 15 runs were killed by the deadline mid-edit, because the last round was granted
 * the same slice as the first when a fraction of it remained.
 *
 * Taking 70% of what is left is self-correcting: round one gets the long coherent stretch that is the
 * agent's actual strength, each later round is necessarily smaller, and the 30% held back always covers
 * `verify` plus the margin — so the loop shrinks toward its deadline instead of colliding with it.
 */
const IMPLEMENT_SHARE_OF_REMAINING = 0.5;
/** Never hand a round less than this; below it a subagent cannot finish a single useful edit. */
const IMPLEMENT_FLOOR_MS = 90_000;

/**
 * What a round may spend on implementation, given the seconds left when it opened. This is the ONE
 * definition — used both as the enforced budget and as the number the prompt quotes, so the agent is
 * never told a deadline the engine will not honour.
 *
 * Two bounds, and the tighter one wins. The share keeps early rounds from eating the clock, so there is
 * always something left to repair with. `spendableMs` is what physically remains once checking and
 * settling are paid for — it binds on the LAST round, letting it fill the tail exactly instead of
 * taking half of it and idling the rest (a 750s task otherwise finished with 38% of its budget unused,
 * because half of a small remainder is never worth starting).
 */
const implementBoxMs = (remainingSec: number): number => {
  const remainingMs = remainingSec * 1000;
  // Everything physically available once this round's check and the settle margin are paid for.
  const spendableMs = remainingMs - VERIFY_CAP_MS - ROUND_MARGIN_SEC * 1000;
  const shareMs = remainingMs * IMPLEMENT_SHARE_OF_REMAINING;
  // Holding back half only makes sense if a further round can actually use it. Ask whether one would
  // still fit after this round took its share; when it would not, this IS the last round, so it takes
  // everything instead of leaving a remainder too small to start anything with. Without this a 900s
  // task stopped with 233 of 855 seconds unspent — a reserve kept for a round that could never happen.
  const anotherRoundFits = remainingMs - shareMs - VERIFY_CAP_MS - VERIFY_CAP_MS - ROUND_MARGIN_SEC * 1000 >= IMPLEMENT_FLOOR_MS;
  return Math.max(IMPLEMENT_FLOOR_MS, Math.round(anotherRoundFits ? Math.min(shareMs, spendableMs) : spendableMs));
};

/** Slack kept back so the last round settles instead of being cut off mid-write. */
const ROUND_MARGIN_SEC = 60;
/**
 * A safety valve, NOT the policy — the clock decides when rounds end. This exists for the pathological
 * case the clock cannot catch: rounds so cheap they never consume the budget (every attempt failing in
 * seconds), which would otherwise spin until the loop's `maxIterations` guard CRASHED the run and
 * skipped the final report. Set far above any round count a real budget can pay for.
 */
const ROUND_SAFETY_VALVE = 15;

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
  maxDurationMs: SURVEY_CAP_MS,
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
      timeLine(SURVEY_CAP_MS / 1000, budget?.remainingSec ?? 0),
      "",
      "First look around (ls, cat, find, git status/log, running processes, installed tooling) until you",
      "know what is actually here — do not plan against a machine you have imagined. Be quick about it:",
      "a few commands, not an audit. You are not solving the task in this step, and every second here is",
      "one the work itself does not get.",
      "",
      "Then, BEFORE writing any check, list `requirements`: go through the task sentence by sentence and",
      "write down every distinct thing it demands — each path, filename, format, exact value, exit code,",
      "count and behaviour. Quote its words. This list is what your criteria must cover; anything you fail",
      "to notice here is something nobody downstream will ever check.",
      "",
      "Then turn those requirements into acceptance criteria.",
      "Rules for criteria:",
      "  - each is checkable by ONE non-interactive shell command that exits 0 exactly when it holds;",
      "  - EVERY check must be able to fail on the WRONG thing being present, not only on the right thing",
      "    being absent. A check that confirms the values you expect, while ignoring whatever else is",
      "    there, passes a result with an extra row, a stray file or a trailing field — and the real tests",
      "    will not. Count things exhaustively, compare whole outputs, assert the absence of extras.",
      "  - the command must test real behaviour (run the program, query the service, parse the output),",
      "    not merely that a file exists — unless existence is genuinely all that is required;",
      "  - prefer a check that costs seconds over one that costs minutes: it is run more than once, by",
      "    more than one step. Where the honest check is expensive (cracking a hash, a full test suite),",
      "    checking the ARTIFACT it should have produced is usually just as decisive;",
      "  - no command may reference tests you have not seen, or write to the paths under test;",
      "  - keep it to the handful that actually decide the outcome, ordered most important first.",
      "",
      "For each criterion set `source` to the task's own words that require it, or the literal word",
      "INFERRED when the task does not say it and you worked it out. Be honest about which is which: an",
      "inference stated as a requirement is how a run ends up confidently satisfying the wrong contract.",
      "Then CHECK YOUR OWN WORK for contradictions — if one criterion enumerates a set and another counts",
      "it, the numbers must agree. (Measured: a survey demanded 16 rows for a table it had itself",
      "enumerated as 5 x 3 = 15. Every check passed; the task scored zero.)",
      "",
      "Finally, list `uncertainties`: the places the task is genuinely ambiguous and you had to pick a",
      "reading. Naming them is what lets the later check spend its scepticism where it is warranted.",
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
    const design = ctx.getStepResult<Static<typeof planSchema>>("survey");
    const round = ctx.getStepResult<{ remainingSec: number; round: number }>("budget");
    const lastVerify = ctx.getStepResult<Static<typeof verifySchema>>("verify");
    const failures = lastVerify?.failures ?? [];
    // Continuity across rounds is the SESSION's job, not a summary's: this step is `resumable`, so a
    // later round reopens the same conversation and still holds everything it read, ran and learned.
    // A three-field report of the same thing was strictly worse — lossier, and usually absent, since a
    // round that spends its whole box produces no report at all.
    const continuing = (round?.round ?? 1) > 1;

    const priorWork = continuing
      ? [
          "",
          "YOU HAVE BEEN HERE BEFORE. This conversation is your own from the previous round, which ran",
          "out of time or was judged incomplete — continue it rather than starting over, and re-read any",
          "file before you change it again.",
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
      // Deliberately NOT "what your work is measured against" — that is what they used to say, and it
      // made a quick reconnaissance pass the definition of success. The criteria are written by a step
      // that had looked at the machine for under two minutes and had never attempted the work; the
      // hidden tests are written from the task. Where they disagree, the task wins, and an implementer
      // that has learned something the survey did not know must be free to act on it.
      "CHECKLIST FROM A QUICK RECONNAISSANCE PASS — useful, but NOT the specification:",
      (design?.criteria?.length ?? 0) > 0 ? criteriaBlock(design?.criteria ?? []) : "  (none were derived — satisfy the task statement above, in full)",
      "Treat these as a floor, not a ceiling: satisfying every one of them is not the same as completing",
      "the task, and if one contradicts the task statement above, the task statement is right.",
      "",
      `PLANNED APPROACH: ${design?.approach ?? "(none derived — work from the task statement above)"}`,
      priorWork,
      retryBlock,
      "",
      GRADING_CONTRACT,
      "",
      timeLine(implementBoxMs(round?.remainingSec ?? 0) / 1000, round?.remainingSec ?? 0),
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
      "Check the task's own words too, not only the checklist above — it was written before anyone",
      "attempted the work and it misses things. Re-read the task for every path, filename, exact format,",
      "value and count it names, and make sure your result contains exactly what is asked for and nothing",
      "extra: a stray row, file or field fails a real test that a narrow check waves through.",
      "",
      "Delete any scratch files, probe scripts or sample outputs YOU created that the task did not ask",
      "for — they can only confuse whatever grades this machine.",
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
  maxDurationMs: VERIFY_CAP_MS,
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
      "THE QUESTION YOU ARE ANSWERING is whether THE TASK ABOVE is done — not whether the checklist below",
      "passes. The checklist was written by someone who had looked at this machine for a couple of minutes",
      "and had not yet attempted the work. It is a starting point and it is often incomplete. The tests",
      "that decide the outcome were written from the task, so the task is what you audit.",
      "",
      "STARTING CHECKLIST — run each one and observe the real result:",
      (design?.criteria?.length ?? 0) > 0 ? criteriaBlock(design?.criteria ?? []) : "  (none were derived — judge the task statement above on its own terms, end to end)",
      (design?.uncertainties?.length ?? 0) > 0
        ? ["", "THE CHECKLIST'S AUTHOR WAS UNSURE ABOUT THESE — check them harder than the rest:", ...(design?.uncertainties ?? []).map((u) => `  - ${u}`)].join("\n")
        : "",
      "",
      timeLine(VERIFY_CAP_MS / 1000, round?.remainingSec ?? 0),
      "",
      "Rules:",
      "  - run every check FROM A CLEAN SHELL (`bash -lc '<check>'`, starting from /), never from state",
      "    you have set up yourself: the machine is graded after everyone has left, so anything that",
      "    depends on an exported variable, a cwd or an activated venv is already broken;",
      "  - run every check; never mark one passed because it looks like it should pass;",
      "  - then RE-READ THE TASK and check what the checklist does not cover. Go requirement by",
      "    requirement: every path, filename, format, exact value, count and exit code it names. This is",
      "    where the outcome is usually decided;",
      "  - look for what should NOT be there as well as what should: an extra row, a stray file, a wrong",
      "    order, a trailing field. Checks tend to confirm the expected and ignore the unexpected, and the",
      "    real tests do not;",
      "  - an end-to-end run of what the task actually asks for often fails where every narrow check passes;",
      "  - if a check command is itself broken, judge the underlying criterion by other means and say so;",
      "  - DO NOT FIX ANYTHING. Report only. Someone else gets one more round to repair what you find.",
      "",
      "Then the verdict. List in `unchecked` everything the task requires that you did not actually",
      "verify — write that list BEFORE you decide `allPass`, and let it decide for you: if the list is not",
      "empty, `allPass` is false. Set `allPass` true only if you personally ran checks covering every",
      "requirement of the task and saw them all hold.",
      "",
      "WHEN IN DOUBT, SAY NOT DONE. Being wrong in that direction costs one more round, which there is",
      "time for. Being wrong the other way ends the run with the task broken and the clock unspent —",
      "measured, that happened to 13 of 45 runs that declared themselves finished.",
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
    // A runaway guard, not the exit: `checkpoint` ends rounds on the clock, so reaching this means that
    // logic is broken and the run should fail loudly rather than spin.
    maxIterations: 20,
  })
  .then(report)
  .commit();
