import { describe, expect, it } from "vitest";
import tbSolver from "../benchmarks/terminal-bench/tb-solver.workflow.ts";
import { type AgentStep, forEachNode } from "../src/flow/index.ts";
import { createTestRun, raw, reply, throws } from "../src/testing/index.ts";

/**
 * Structural tests for the terminal-bench solver (benchmarks/terminal-bench/tb-solver.workflow.ts),
 * with every agent step scripted — so this pins the WIRING (which step reads whose output, when the
 * round loop stops, what the clock does) without a model or a container. The live behaviour is a
 * separate question; this is the part that must be right before spending a task budget on it.
 */

const plan = {
  approach: "fix the parser",
  requirements: ["the cli must print ok"],
  criteria: [{ id: "c1", statement: "cli prints ok", check: "python /app/main.py", expect: "prints ok, exits 0", source: "Make the cli print ok." }],
  uncertainties: [],
};
/** `implement` declares no output schema — it acts, so any text is a valid reply. */
const work = "patched /app/main.py";
/** A clean verdict: nothing left unchecked, nothing failing. From `audit`, it means "no objection". */
const allGood = { allPass: true, unchecked: [], failures: [] };

/** A deadline far enough out that the round loop is never the thing that stops the run. */
const roomyInput = () => ({ instruction: "Make the cli print ok.", deadlineIso: new Date(Date.now() + 3_600_000).toISOString() });

/**
 * A deadline above every other threshold in the schedule but BELOW the one that makes a second opinion
 * worth buying (audit 240s + a floor implement round 90s + its verify 150s + the 60s margin = 540s at a
 * 900s budget). Rounds still open here; only the audit is priced out.
 */
const noTimeToActInput = () => ({ instruction: "Make the cli print ok.", deadlineIso: new Date(Date.now() + 300_000).toISOString() });

/**
 * Every agent step in the committed tree, by name. This goes through the engine's own tree walk rather
 * than a hand-rolled one because `audit` sits inside a branch ARM, which a "recurse into node.body" walk
 * skips silently — turning the structural assertions below into no-ops that still pass.
 */
function agentSteps(): Map<string, AgentStep> {
  const steps = new Map<string, AgentStep>();
  forEachNode(tbSolver.nodes, (node) => {
    if (node.kind === "step" && node.step.kind === "agent") steps.set(node.step.name, node.step);
  });
  return steps;
}

describe("tb-solver: the round loop", () => {
  it("stops after one round when the independent check passes everything", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [raw(work)],
        verify: [reply(allGood)],
        // The clock is roomy, so a passing check also buys a second opinion before the run may stop.
        audit: [reply(allGood)],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ allPass: true, rounds: 1, remainingSec: expect.any(Number) });
    expect(run.agent("implement").sessions).toBe(1);
    expect(run.agent("verify").sessions).toBe(1);
  });

  it("runs a second round on a failed check, and feeds the failure back into the implementer", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [raw(work), raw("fixed the real cause")],
        verify: [reply({ allPass: false, unchecked: [], failures: [{ id: "c1", actual: "exit 1: SyntaxError", diagnosis: "stray paren" }] }), reply(allGood)],
        audit: [reply(allGood)], // only round two reaches it: round one already knows the work is unfinished
      },
    });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ allPass: true, rounds: 2 });

    // The second implement prompt must carry the FIRST round's observed failure — that feedback is the
    // only reason a second round is worth running.
    const prompts = run.agent("implement").messages;
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("SyntaxError");
    expect(prompts[1]).toContain("exit 1: SyntaxError");
    expect(prompts[1]).toContain("stray paren");
  });

  it("keeps opening rounds while the clock allows, rather than stopping at a fixed count", async () => {
    const failing = reply({ allPass: false, unchecked: [], failures: [{ id: "c1", actual: "exit 1", diagnosis: "still broken" }] });
    // A generous deadline and instant (test-double) rounds: the round count is now governed by time, so
    // more than the old fixed maximum of three must be possible. A fixed count ended real runs while
    // they still held most of their budget.
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: Array.from({ length: 18 }, () => raw(work)),
        verify: Array.from({ length: 18 }, () => failing),
      },
    });

    // Scripted rounds cost no time at all, so the clock can never end them — the safety valve does,
    // CLEANLY. That distinction matters: the loop's own guard would crash the run and skip the report.
    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ allPass: false });
    const rounds = (run.output as { rounds: number }).rounds;
    expect(rounds).toBeGreaterThan(3); // more than the fixed maximum this replaced
    expect(rounds).toBeLessThanOrEqual(15); // the safety valve, which must stop it cleanly
  });

  it("stops opening rounds when the clock runs out", async () => {
    const run = await createTestRun(tbSolver, {
      // Deadline already passed: the first checkpoint must call it and end the loop.
      input: { instruction: "Make the cli print ok.", deadlineIso: new Date(Date.now() - 1000).toISOString() },
      agents: {
        survey: [reply(plan)],
        implement: [raw(work)],
        verify: [reply({ allPass: false, unchecked: [], failures: [{ id: "c1", actual: "exit 1", diagnosis: "not done" }] })],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ allPass: false, rounds: 1 });
    expect(run.agent("implement").sessions).toBe(1); // no second round was opened
  });
});

/**
 * The second opinion (spec of the failure it answers: FAILURE-MODES.md F10). A wrong "done" is the most
 * expensive event in a run — 13 of 45 such verdicts were wrong and each stopped with a median of 1412s
 * unspent — so a second, differently-argued check stands between the first verdict and the run halting.
 * What has to be pinned here is when it is bought, when it is not, and which way silence reads.
 */
describe("tb-solver: the second opinion", () => {
  it("does not buy one when the first check already says the work is unfinished", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [raw(work), raw("fixed it")],
        verify: [reply({ allPass: false, unchecked: [], failures: [{ id: "c1", actual: "exit 1", diagnosis: "not built" }] }), reply(allGood)],
        audit: [reply(allGood)],
      },
    });

    expect(run.status).toBe("completed");
    // Two rounds were checked, but only the one that said "done" was worth second-guessing: a verdict
    // that already sends the loop round again has nothing to overturn, and the round costs a subagent.
    expect(run.agent("verify").sessions).toBe(2);
    expect(run.agent("audit").sessions).toBe(1);
  });

  it("does not buy one when there would be no time to act on a disagreement", async () => {
    const run = await createTestRun(tbSolver, {
      input: noTimeToActInput(),
      agents: { survey: [reply(plan)], implement: [raw(work)], verify: [reply(allGood)], audit: [reply(allGood)] },
    });

    expect(run.status).toBe("completed");
    // 300s left: a round still fits, but not the audit PLUS the repair round a dissent would demand
    // plus its check plus the margin (540s). A second opinion nobody can act on is pure cost.
    expect(run.agent("audit").sessions).toBe(0);
    expect(run.output).toMatchObject({ allPass: true, rounds: 1 });
  });

  it("buys one when the check says done and there is still time to repair a disagreement", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: { survey: [reply(plan)], implement: [raw(work)], verify: [reply(allGood)], audit: [reply(allGood)] },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("audit").sessions).toBe(1);
    expect(run.output).toMatchObject({ allPass: true, rounds: 1 }); // no objection, so the run stops

    const auditPrompt = run.agent("audit").messages[0] as string;
    // Decorrelated by METHOD, not merely by context window: it is never shown the checklist, because a
    // second pass down the same criteria repeats the first pass's omissions rather than finding them.
    expect(auditPrompt).not.toContain("[c1] cli prints ok");
    expect(auditPrompt).not.toContain("python /app/main.py");
    expect(auditPrompt).toContain("DECLARED THE TASK COMPLETE");
    expect(auditPrompt).toContain("Make the cli print ok.");
    // Its bias is the opposite of the verifier's: overturning costs a repair round that can break work
    // which currently passes, so a doubt is not a dissent.
    expect(auditPrompt).toContain("EVIDENCE, NOT SUSPICION");
    expect(auditPrompt).toContain("DO NOT FIX ANYTHING");
    // Both trials of this step were killed at their box and returned nothing, which reads as no
    // objection — so it is told to land the verdict, and what its silence would cost.
    expect(auditPrompt).toContain("KEEP THE LAST THIRD OF YOUR BOX");
    expect(auditPrompt).toContain("NO OBJECTION");
  });

  it("keeps the loop going on a dissent, and carries both checks' findings into the next round", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [raw(work), raw("removed the stray row")],
        // A verdict of done that still lists a failing check is a shape a model really produces; the
        // implementer must be told about both lists, whichever of them reopened the round.
        verify: [reply({ allPass: true, unchecked: [], failures: [{ id: "c1", actual: "exit 0, 16 rows", diagnosis: "row count unconfirmed" }] }), reply(allGood)],
        audit: [reply({ allPass: false, unchecked: [], failures: [{ id: "a1", actual: "$ ./run | wc -l -> 17", diagnosis: "a debug line is still printed" }] }), reply(allGood)],
      },
    });

    expect(run.status).toBe("completed");
    // The first round PASSED its check and was reopened anyway — that is the whole point of the step.
    expect(run.output).toMatchObject({ allPass: true, rounds: 2 });
    expect(run.agent("implement").sessions).toBe(2);

    const second = run.agent("implement").messages[1] as string;
    expect(second).toContain("a debug line is still printed"); // the dissent itself
    expect(second).toContain("$ ./run | wc -l -> 17"); // with the output that demonstrates it
    expect(second).toContain("row count unconfirmed"); // and what the first check saw, merged in
  });

  it("reads an audit that never returned as no objection, so a timeout cannot spin the loop", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [raw(work)],
        verify: [reply(allGood)],
        // The step is `optional`, so this is what a blown box looks like from `checkpoint`: nothing.
        audit: [throws(new Error('step "audit" exceeded its 240000ms time budget'))],
      },
    });

    expect(run.status).toBe("completed");
    // Silence is not a dissent. The first check said done, and a second opinion that never arrived is no
    // evidence against it — reading it the other way would reopen the round on every timeout.
    expect(run.output).toMatchObject({ allPass: true, rounds: 1 });
    expect(run.agent("implement").sessions).toBe(1);
  });
});

describe("tb-solver: what the steps are told", () => {
  it("gives the implementer the criteria and the grading contract, and the verifier no story to inherit", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [raw(work)],
        verify: [reply(allGood)],
        audit: [reply(allGood)],
      },
    });
    expect(run.status).toBe("completed");

    // Every step is told its OWN box, not just the run's remaining time: a step that thinks it owns the
    // whole budget overruns its cap and is killed mid-thought (measured: 4 in 10 surveys).
    for (const step of ["survey", "implement", "verify", "audit"]) {
      expect(run.agent(step).messages[0], step).toContain("finished with THIS step");
    }
    const surveyPrompt = run.agent("survey").messages[0] as string;
    // The quoted deadline is SOFT — below the 225s the engine actually enforces, so ordinary overshoot
    // is absorbed instead of discarding the answer mid-sentence.
    expect(surveyPrompt).toContain("about 169s");
    expect(surveyPrompt).not.toContain("about 225s");

    const implementPrompt = run.agent("implement").messages[0] as string;
    expect(implementPrompt).toContain("[c1] cli prints ok");
    expect(implementPrompt).toContain("python /app/main.py");
    expect(implementPrompt).toContain("FINAL STATE of this machine");

    // The verifier is told the task and the criteria — never what the implementer claimed to have done.
    const verifyPrompt = run.agent("verify").messages[0] as string;
    expect(verifyPrompt).toContain("[c1] cli prints ok");
    expect(verifyPrompt).not.toContain("patched /app/main.py");
    expect(verifyPrompt).toContain("DO NOT FIX ANYTHING");
  });

  it("tells a second-round implementer it is continuing its own session, not starting over", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        // An acting step: no schema, so whatever it says is accepted — including the `/auto` that used
        // to fail the step outright and throw away a round whose edits were already on disk.
        implement: [raw("/auto"), raw("done")],
        verify: [reply({ allPass: false, unchecked: [], failures: [{ id: "c1", actual: "exit 1", diagnosis: "not built" }] }), reply(allGood)],
        audit: [reply(allGood)],
      },
    });

    expect(run.status).toBe("completed");
    const first = run.agent("implement").messages[0] as string;
    const second = run.agent("implement").messages[1] as string;
    // Round one has no past to refer to; round two is told the conversation it is reading IS its own.
    expect(first).not.toContain("YOU HAVE BEEN HERE BEFORE");
    expect(second).toContain("YOU HAVE BEEN HERE BEFORE");
    expect(second).toContain("continue it rather than starting over");
    // The verifier's findings still reach it — that is the part a session cannot supply.
    expect(second).toContain("exit 1");
  });

  it("tells the verifier to judge the task rather than the checklist, and to bias toward not-done", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply({ ...plan, uncertainties: ["whether the header row counts toward the total"] })],
        implement: [raw(work)],
        verify: [reply(allGood)],
        audit: [reply(allGood)],
      },
    });
    const verifyPrompt = run.agent("verify").messages[0] as string;

    // Precision was 71% over a full run, and the losses were unexamined corners rather than sloppy
    // checking: criteria written before anyone attempted the work simply did not cover the requirement.
    expect(verifyPrompt).toContain("whether THE TASK ABOVE is done");
    expect(verifyPrompt).toContain("RE-READ THE TASK");
    expect(verifyPrompt).toContain("what should NOT be there");
    // A false positive ends the run broken; a false negative costs one round there is time for.
    expect(verifyPrompt).toContain("WHEN IN DOUBT, SAY NOT DONE");
    // 6 checks in 15 were killed at their box, which costs the box AND returns nothing: it is told to
    // reserve time for the verdict, and that silence here reads as not passed.
    expect(verifyPrompt).toContain("KEEP THE LAST THIRD OF YOUR BOX");
    expect(verifyPrompt).toContain("NOT PASSED");
    // Survey's own doubts are forwarded, so scepticism lands where it is warranted.
    expect(verifyPrompt).toContain("whether the header row counts toward the total");
  });

  it("retries recon when it produced no criteria, and tells the second pass to stop looking", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        // Pass one yields nothing usable — live, this is the step dying at its cap with the contract
        // unwritten, which left four runs in six with no criteria at all.
        survey: [reply({ approach: "", requirements: [], criteria: [], uncertainties: [] }), reply(plan)],
        implement: [raw(work)],
        verify: [reply(allGood)],
        audit: [reply(allGood)],
      },
    });

    expect(run.status).toBe("completed");
    const passes = run.agent("survey").messages;
    expect(passes).toHaveLength(2);
    // Pass two must not go looking again — there is only time to write the answer down.
    expect(passes[1]).toContain("DO NOT RUN ANY MORE COMMANDS");
    expect(passes[1]).toContain("produce it NOW from what you already know");
    // Two executions, but one conversation: the step is `resumable`, so the host reopens pass one's
    // session by name rather than starting cold (the resume-key wiring itself is covered in
    // test/resumable-step.test.ts). That is the only reason a 60s landing pass can succeed at all.
    expect(run.agent("survey").sessions).toBe(2);
    // The criteria that eventually arrived are what the implementer works against.
    expect(run.agent("implement").messages[0]).toContain("[c1] cli prints ok");
  });

  it("does not re-run recon when the first pass produced criteria", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: { survey: [reply(plan)], implement: [raw(work)], verify: [reply(allGood)], audit: [reply(allGood)] },
    });

    expect(run.status).toBe("completed");
    expect(run.agent("survey").messages).toHaveLength(1); // the common case costs nothing
  });

  it("makes the surveyor enumerate requirements and mark what it inferred", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: { survey: [reply(plan)], implement: [raw(work)], verify: [reply(allGood)], audit: [reply(allGood)] },
    });
    const surveyPrompt = run.agent("survey").messages[0] as string;

    expect(surveyPrompt).toContain("BEFORE writing any check");
    // The failure this addresses: checks that confirm expected values while ignoring everything else.
    expect(surveyPrompt).toContain("fail on the WRONG thing being present");
    expect(surveyPrompt).toContain("INFERRED");
  });

  it("never asks the implementer for a structured reply, so it cannot fail at formatting", () => {
    const steps = agentSteps();

    // `implement` changes the machine and `verify` reads the machine, so nothing consumes its words.
    expect(steps.get("implement")?.outputSchema).toBeUndefined();
    // Both looping workers resume rather than restart — for `survey` that is what makes a cheap second
    // pass possible instead of redoing the exploration that blew the first box.
    expect(steps.get("survey")?.resumable).toBe(true);
    expect(steps.get("implement")?.resumable).toBe(true);
    // `audit` must NOT: its whole value is a reader who has never seen this machine or its own earlier
    // opinion of it, and a resumed session would inherit exactly the beliefs it exists to break.
    expect(steps.get("audit")?.resumable).not.toBe(true);
    // The three steps whose output IS consumed keep their contracts.
    expect(steps.get("survey")?.outputSchema).toBeDefined();
    expect(steps.get("verify")?.outputSchema).toBeDefined();
    expect(steps.get("audit")?.outputSchema).toBeDefined();
  });

  it("gives implement a shrinking share of the time left, and lets the workers fail without ending it", () => {
    // A cap in absolute ms is meaningless against a clock it does not know: an implement step capped at
    // 900s inside an 855s run can never fire, which is how v2 lost tasks the baseline solved.
    const steps = agentSteps();

    // Checking is sized from measured cost, and its two bounds answer different evidence: the ceiling
    // moved because four of six killed verifications piled up on it, while the floor stayed because
    // every verification that ever reached a verdict did so in under 120s.
    expect(steps.get("verify")?.maxDurationMs).toBe(120_000);
    // The audit gets a bigger box than the check it second-guesses, because it is handed no checklist:
    // it pays for the reconnaissance `verify` is given for free, so it costs survey PLUS verify.
    expect(steps.get("audit")?.maxDurationMs).toBe(240_000);

    // Survey's box depends on which recon pass it is: the first explores, a later one only writes down
    // what that pass already found, so it gets a much smaller box. A second full-sized box would put a
    // third of a short run into reconnaissance.
    const surveyBox = steps.get("survey")?.maxDurationMs;
    expect(typeof surveyBox).toBe("function");
    const surveyFor = (pass: number): number => (surveyBox as (a: { ctx: unknown }) => number)({ ctx: { getStepResult: () => ({ pass, remainingSec: 3600 }) } });
    expect(surveyFor(1)).toBe(225_000); // explore
    expect(surveyFor(2)).toBe(60_000); // land it

    // `implement` is a function of run state, so each round can be smaller than the last. A constant
    // could not do this: sized small it fragments the work (53 of 89 implementations were cut off
    // mid-job), sized large the final round overruns and the deadline kills it mid-edit (15 runs).
    const box = steps.get("implement")?.maxDurationMs;
    expect(typeof box).toBe("function");
    const boxFor = (remainingSec: number): number => (box as (a: { ctx: unknown }) => number)({ ctx: { getStepResult: () => ({ remainingSec }) } });
    // Half of what is left, while a further round could still use the other half…
    expect(boxFor(1000)).toBe(500_000);
    // …but once no further round can fit, this is the last one, so it takes the whole tail rather than
    // reserving half of it for a round that will never happen (would be 250s under a plain share).
    expect(boxFor(500)).toBe(320_000);
    expect(boxFor(10)).toBe(90_000); // floored: below this no useful edit lands

    // The box plus its verify must leave the clock intact, or the round cannot settle.
    const verifyMs = steps.get("verify")?.maxDurationMs;
    expect(typeof verifyMs).toBe("number");
    expect(boxFor(1000) + (verifyMs as number)).toBeLessThan(1_000_000);

    // The workers may be cut short; that must cost the round, not the run.
    expect(steps.get("implement")?.optional).toBe(true);
    expect(steps.get("verify")?.optional).toBe(true);
    // Survey is optional too: a slow recon that blew its cap used to crash the run with nothing
    // attempted, so the workers fall back to the task statement instead.
    expect(steps.get("survey")?.optional).toBe(true);
    // The audit above all: a verdict that never arrived is silence, and silence must not be able to
    // reopen a round the first check already passed, or a timeout spins the loop to the deadline.
    expect(steps.get("audit")?.optional).toBe(true);
  });

  it("runs every step as an isolated subagent, so no two share a conversation", () => {
    const names = ["survey", "implement", "verify", "audit"];
    const agents = agentSteps();

    expect([...agents.keys()].sort()).toEqual([...names].sort());
    for (const name of names) expect(agents.get(name)?.background).toBe(true);
  });
});
