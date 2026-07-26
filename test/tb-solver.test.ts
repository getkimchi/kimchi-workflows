import { describe, expect, it } from "vitest";
import tbSolver from "../benchmarks/terminal-bench/tb-solver.workflow.ts";
import { createTestRun, raw, reply } from "../src/testing/index.ts";

/**
 * Structural tests for the terminal-bench solver (benchmarks/terminal-bench/tb-solver.workflow.ts),
 * with every agent step scripted — so this pins the WIRING (which step reads whose output, when the
 * round loop stops, what the clock does) without a model or a container. The live behaviour is a
 * separate question; this is the part that must be right before spending a task budget on it.
 */

const plan = {
  approach: "fix the parser",
  criteria: [{ id: "c1", statement: "cli prints ok", check: "python /app/main.py", expect: "prints ok, exits 0" }],
};
const work = { changes: "patched /app/main.py", ranChecks: "ran it, prints ok", incomplete: "" };

/** A deadline far enough out that the round loop is never the thing that stops the run. */
const roomyInput = () => ({ instruction: "Make the cli print ok.", deadlineIso: new Date(Date.now() + 3_600_000).toISOString() });

describe("tb-solver: the round loop", () => {
  it("stops after one round when the independent check passes everything", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [reply(work)],
        verify: [reply({ allPass: true, failures: [] })],
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
        implement: [reply(work), reply({ ...work, changes: "fixed the real cause" })],
        verify: [reply({ allPass: false, failures: [{ id: "c1", actual: "exit 1: SyntaxError", diagnosis: "stray paren" }] }), reply({ allPass: true, failures: [] })],
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
    const failing = reply({ allPass: false, failures: [{ id: "c1", actual: "exit 1", diagnosis: "still broken" }] });
    // A generous deadline and instant (test-double) rounds: the round count is now governed by time, so
    // more than the old fixed maximum of three must be possible. A fixed count ended real runs while
    // they still held most of their budget.
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: Array.from({ length: 18 }, () => reply(work)),
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
        implement: [reply(work)],
        verify: [reply({ allPass: false, failures: [{ id: "c1", actual: "exit 1", diagnosis: "not done" }] })],
      },
    });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ allPass: false, rounds: 1 });
    expect(run.agent("implement").sessions).toBe(1); // no second round was opened
  });
});

describe("tb-solver: what the steps are told", () => {
  it("gives the implementer the criteria and the grading contract, and the verifier no story to inherit", async () => {
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [reply(work)],
        verify: [reply({ allPass: true, failures: [] })],
      },
    });
    expect(run.status).toBe("completed");

    // Every step is told its OWN box, not just the run's remaining time: a step that thinks it owns the
    // whole budget overruns its cap and is killed mid-thought (measured: 4 in 10 surveys).
    for (const step of ["survey", "implement", "verify"]) {
      expect(run.agent(step).messages[0], step).toContain("for THIS step");
    }
    const surveyPrompt = run.agent("survey").messages[0] as string;
    expect(surveyPrompt).toContain("about 150s for THIS step"); // floored, not 15% of 900

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
        verify: [reply({ allPass: false, failures: [{ id: "c1", actual: "exit 1", diagnosis: "not built" }] }), reply({ allPass: true, failures: [] })],
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

  it("never asks the implementer for a structured reply, so it cannot fail at formatting", () => {
    const steps = new Map<string, { outputSchema?: unknown }>();
    const walk = (nodes: readonly unknown[]): void => {
      for (const node of nodes as { kind: string; step?: { kind: string; name: string; outputSchema?: unknown }; body?: { nodes: unknown[] } }[]) {
        if (node.kind === "step" && node.step?.kind === "agent") steps.set(node.step.name, node.step);
        if (node.body) walk(node.body.nodes);
      }
    };
    walk(tbSolver.nodes);

    // `implement` changes the machine and `verify` reads the machine, so nothing consumes its words.
    expect(steps.get("implement")?.outputSchema).toBeUndefined();
    // The two steps whose output IS consumed keep their contracts.
    expect(steps.get("survey")?.outputSchema).toBeDefined();
    expect(steps.get("verify")?.outputSchema).toBeDefined();
  });

  it("gives implement a shrinking share of the time left, and lets the workers fail without ending it", () => {
    // A cap in absolute ms is meaningless against a clock it does not know: an implement step capped at
    // 900s inside an 855s run can never fire, which is how v2 lost tasks the baseline solved.
    type Boxed = { maxDurationMs?: number | ((args: { ctx: unknown }) => number); optional?: boolean };
    const steps = new Map<string, Boxed>();
    const walk = (nodes: readonly unknown[]): void => {
      for (const node of nodes as { kind: string; step?: { kind: string; name: string } & Boxed; body?: { nodes: unknown[] } }[]) {
        if (node.kind === "step" && node.step?.kind === "agent") steps.set(node.step.name, node.step);
        if (node.body) walk(node.body.nodes);
      }
    };
    walk(tbSolver.nodes);

    // Recon and checking are sized from measured cost with a floor, not a bare percentage: at 900s a
    // pure 8%/10% put both caps below their observed medians and four of six surveys died at the limit.
    expect(steps.get("survey")?.maxDurationMs).toBe(150_000);
    expect(steps.get("verify")?.maxDurationMs).toBe(120_000);

    // `implement` is a function of run state, so each round can be smaller than the last. A constant
    // could not do this: sized small it fragments the work (53 of 89 implementations were cut off
    // mid-job), sized large the final round overruns and the deadline kills it mid-edit (15 runs).
    const box = steps.get("implement")?.maxDurationMs;
    expect(typeof box).toBe("function");
    const boxFor = (remainingSec: number): number => (box as (a: { ctx: unknown }) => number)({ ctx: { getStepResult: () => ({ remainingSec }) } });
    // Half of what is left, while a further round could still use the other half…
    expect(boxFor(800)).toBe(400_000);
    // …but once no further round can fit, this is the last one, so it takes the whole tail rather than
    // reserving half of it for a round that will never happen (would be 150s under a plain share).
    expect(boxFor(300)).toBe(120_000);
    expect(boxFor(10)).toBe(90_000); // floored: below this no useful edit lands

    // The box plus its verify must leave the clock intact, or the round cannot settle.
    const verifyMs = steps.get("verify")?.maxDurationMs;
    expect(typeof verifyMs).toBe("number");
    expect(boxFor(800) + (verifyMs as number)).toBeLessThan(800_000);

    // The workers may be cut short; that must cost the round, not the run.
    expect(steps.get("implement")?.optional).toBe(true);
    expect(steps.get("verify")?.optional).toBe(true);
    // Survey is optional too: a slow recon that blew its cap used to crash the run with nothing
    // attempted, so the workers fall back to the task statement instead.
    expect(steps.get("survey")?.optional).toBe(true);
  });

  it("runs every step as an isolated subagent, so no two share a conversation", () => {
    const names = ["survey", "implement", "verify"];
    const agents = new Map<string, { background?: boolean }>();
    const walk = (nodes: readonly unknown[]): void => {
      for (const node of nodes as { kind: string; step?: { kind: string; name: string; background?: boolean }; body?: { nodes: unknown[] } }[]) {
        if (node.kind === "step" && node.step?.kind === "agent") agents.set(node.step.name, node.step);
        if (node.body) walk(node.body.nodes);
      }
    };
    walk(tbSolver.nodes);

    expect([...agents.keys()].sort()).toEqual([...names].sort());
    for (const name of names) expect(agents.get(name)?.background).toBe(true);
  });
});
