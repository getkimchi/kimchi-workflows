import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestRun, reply } from "../src/testing/index.ts";

/**
 * Step overrides (spec §13.2/§13.3). Overrides are spliced in as ordinary function steps, so:
 *  - a stub's return is checked against the REAL step's declared output schema (no bespoke validation
 *    code in the testing layer — it reuses the engine's own function-step check);
 *  - a stub that throws drives that step's real retry/crash/resume policy — an otherwise unreachable
 *    failure path becomes directly testable.
 */

const numberOutput = Type.Object({ n: Type.Integer() });

describe("step overrides: construction-time validation", () => {
  it("fails immediately when an override names a step the workflow does not contain", async () => {
    const step = createStep({ name: "real", output: numberOutput, run: () => ({ n: 1 }) });
    const workflow = createWorkflow({ name: "one-step" }).then(step).commit();

    await expect(createTestRun(workflow, { steps: { imaginary: () => ({ n: 1 }) } })).rejects.toThrow(/no step with that name/);
    await expect(createTestRun(workflow, { steps: { imaginary: () => ({ n: 1 }) } })).rejects.toThrow(/steps: real/); // names what IS available
  });

  it("leaves the workflow unchanged when no overrides are supplied", async () => {
    let ran = false;
    const step = createStep({
      name: "real",
      output: numberOutput,
      run: () => {
        ran = true;
        return { n: 1 };
      },
    });
    const workflow = createWorkflow({ name: "passthrough" }).then(step).commit();

    const run = await createTestRun(workflow);

    expect(run.status).toBe("completed");
    expect(ran).toBe(true);
  });
});

describe("step overrides: schema-checked stubs (spec §13.3)", () => {
  it("replaces a function step's behaviour with the stub's return value", async () => {
    const real = createStep({ name: "real", output: numberOutput, run: () => ({ n: 1 }) });
    const workflow = createWorkflow({ name: "override-value" }).then(real).commit();

    const run = await createTestRun(workflow, { steps: { real: () => ({ n: 99 }) } });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ n: 99 });
  });

  it("replaces an agent step too — the double is never consulted once a step is overridden", async () => {
    const asker = createAgentStep({ name: "asker", output: numberOutput, prompt: () => "go" });
    const workflow = createWorkflow({ name: "override-agent" }).then(asker).commit();

    // No `agents` script at all — if the override did not fully replace the agent step, this would
    // fail with "no replies were scripted".
    const run = await createTestRun(workflow, { steps: { asker: () => ({ n: 7 }) } });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ n: 7 });
  });

  it("fails the run when a stub's return drifts from the real step's declared output schema", async () => {
    const real = createStep({ name: "real", output: numberOutput, run: () => ({ n: 1 }) });
    const workflow = createWorkflow({ name: "override-drift" }).then(real).commit();

    // The stub returns a shape the REAL step's schema rejects (string instead of integer) — this must
    // fail the test, not silently pass a value the real contract would never allow.
    const run = await createTestRun(workflow, { steps: { real: () => ({ n: "not a number" }) } });

    expect(run.status).toBe("crashed");
    expect(run.error).toMatch(/real/);
  });

  it("applies to a step nested inside a branch arm and a loop body", async () => {
    const armStep = createStep({ name: "arm-step", output: numberOutput, run: () => ({ n: 1 }) });
    const armBody = createWorkflow({ name: "arm" }).then(armStep).commit();
    // No input schema: the loop's hand-off (the branch's `{ arm: {...} }` output) is simply ignored,
    // so the schema-chaining between the two constructs is not what this test is exercising.
    const loopStep = createStep({ name: "loop-step", output: numberOutput, run: () => ({ n: 1 }) });
    const loopBody = createWorkflow({ name: "loop-body" }).then(loopStep).commit();

    const workflow = createWorkflow({ name: "nested-overrides" })
      .branch([[() => true, armBody]])
      .dountil(loopBody, (_ctx, last) => (last as { n: number }).n >= 100, { name: "count-loop", maxIterations: 3 })
      .commit();

    const run = await createTestRun(workflow, {
      steps: {
        "arm-step": () => ({ n: 5 }),
        "loop-step": () => ({ n: 100 }), // stub jumps straight to the loop's exit condition
      },
    });

    expect(run.status).toBe("completed");
    expect(run.stepOutput("arm/arm-step")).toEqual({ n: 5 }); // nested under the arm's own path segment (spec §8.5)
    expect(run.eventsOf("loop-iteration")).toHaveLength(1); // the stub satisfied the condition on iteration 1
  });

  it("applies to a parallel arm", async () => {
    const a = createStep({ name: "a", output: numberOutput, run: () => ({ n: 1 }) });
    const b = createStep({ name: "b", output: numberOutput, run: () => ({ n: 2 }) });
    const workflow = createWorkflow({ name: "override-parallel" }).parallel([a, b]).commit();

    const run = await createTestRun(workflow, { steps: { a: () => ({ n: 10 }) } });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ a: { n: 10 }, b: { n: 2 } });
  });
});

describe("step overrides: a throwing stub drives the real retry/crash/resume path (spec §13.3)", () => {
  it("retries a stub that throws, exactly like a real function step would", async () => {
    let calls = 0;
    const flaky = createStep({
      name: "flaky",
      output: numberOutput,
      retry: { maxRetry: 1 }, // 1 retry after the first = 2 total attempts
      run: () => ({ n: 1 }), // never actually runs — fully replaced below
    });
    const workflow = createWorkflow({ name: "override-retry" }).then(flaky).commit();

    const run = await createTestRun(workflow, {
      steps: {
        flaky: () => {
          calls += 1;
          if (calls === 1) throw new Error("stubbed failure");
          return { n: 42 };
        },
      },
    });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ n: 42 });
    expect(calls).toBe(2);
    expect(run.eventsOf("step-retry")).toHaveLength(1);
  });

  it("crashes once the stub's throws exhaust maxRetry, and resume() re-invokes the SAME stub", async () => {
    let calls = 0;
    const flaky = createStep({ name: "flaky", output: numberOutput, retry: { maxRetry: 1 }, run: () => ({ n: 1 }) });
    const workflow = createWorkflow({ name: "override-crash-resume" }).then(flaky).commit();

    const run = await createTestRun(workflow, {
      steps: {
        flaky: () => {
          calls += 1;
          if (calls <= 2) throw new Error(`fail ${calls}`); // exhausts the FIRST run's budget (2 attempts)
          return { n: 7 }; // succeeds on resume's fresh attempt
        },
      },
    });

    expect(run.status).toBe("crashed");
    expect(calls).toBe(2);

    // A crashed run's retry budget resets on resume (spec §9.1) — the SAME override closure keeps
    // counting, so this proves BOTH that the override reaches the crash path AND that resume gives it
    // a fresh attempt rather than re-crashing instantly with an exhausted budget.
    const resumed = await run.resume();
    expect(resumed.status).toBe("completed");
    expect(resumed.output).toEqual({ n: 7 });
    expect(calls).toBe(3);
  });
});

describe("step overrides combined with agent scripting on OTHER steps", () => {
  it("scripts the non-overridden agent step normally while the override replaces the other", async () => {
    const stubbed = createStep({ name: "stubbed", output: numberOutput, run: () => ({ n: 1 }) });
    const scripted = createAgentStep({ name: "scripted", input: numberOutput, output: numberOutput, prompt: ({ input }) => `n=${input.n}` });
    const workflow = createWorkflow({ name: "mixed" }).then(stubbed).then(scripted).commit();

    const run = await createTestRun(workflow, {
      steps: { stubbed: () => ({ n: 3 }) },
      agents: { scripted: [reply({ n: 30 })] },
    });

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ n: 30 });
    expect(run.agent("scripted").messages[0]).toContain("n=3"); // saw the OVERRIDE's output, not the real step's
  });
});
