import { describe, expect, it } from "vitest";
import tbSolver from "../benchmarks/terminal-bench/tb-solver.workflow.ts";
import { createTestRun, reply } from "../src/testing/index.ts";

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

  it("settles after the round budget instead of looping forever on a check that never passes", async () => {
    const failing = reply({ allPass: false, failures: [{ id: "c1", actual: "exit 1", diagnosis: "still broken" }] });
    const run = await createTestRun(tbSolver, {
      input: roomyInput(),
      agents: {
        survey: [reply(plan)],
        implement: [reply(work), reply(work), reply(work)],
        verify: [failing, failing, failing],
      },
    });

    // Rounds are a policy, not a crash: the run ENDS cleanly and reports the honest `allPass: false` —
    // the container is graded either way, so a runaway loop must not be how the run ends.
    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ allPass: false, rounds: 3 });
    expect(run.agent("implement").sessions).toBe(3);
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
