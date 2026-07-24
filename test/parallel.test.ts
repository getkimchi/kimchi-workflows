import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { createStepBarrier } from "./step-barrier.ts";

const numberOutput = Type.Object({ n: Type.Integer() });

describe(".parallel (spec §3.5): structural fan-out over independent steps", () => {
  it("runs every arm concurrently; output is keyed by arm name, independent of completion order", async () => {
    const barrier = createStepBarrier<string>();
    const a = createStep({
      name: "a",
      output: numberOutput,
      run: async () => {
        await barrier.enter("a");
        return { n: 1 };
      },
    });
    const b = createStep({
      name: "b",
      output: numberOutput,
      run: async () => {
        await barrier.enter("b");
        return { n: 2 };
      },
    });
    const workflow = createWorkflow({ name: "fan-out" }).parallel([a, b]).commit();

    const { host } = createTestHost();
    const resultPromise = runWorkflow(workflow, undefined, host);

    // Both arms are genuinely concurrent: neither can complete until BOTH have started.
    await Promise.all([barrier.waitFor("a"), barrier.waitFor("b")]);
    // Release in the OPPOSITE order from arm declaration — output keying must not depend on this.
    barrier.release("b");
    barrier.release("a");

    const result = await resultPromise;
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ a: { n: 1 }, b: { n: 2 } });
  });

  it("addresses each arm under the parallel's own node path (parallelName/armName)", async () => {
    const a = createStep({ name: "a", output: numberOutput, run: () => ({ n: 1 }) });
    const b = createStep({ name: "b", output: numberOutput, run: () => ({ n: 2 }) });
    const workflow = createWorkflow({ name: "fan-out-paths" }).parallel([a, b], { name: "par" }).commit();

    const { host, store } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);
    expect(result.status).toBe("completed");

    const events = await store.loadEvents(result.runId);
    expect(events.some((e) => e.type === "step-completed" && e.path === "par/a")).toBe(true);
    expect(events.some((e) => e.type === "step-completed" && e.path === "par/b")).toBe(true);
    expect(events.some((e) => e.type === "node-completed" && e.path === "par" && JSON.stringify(e.output) === JSON.stringify({ a: { n: 1 }, b: { n: 2 } }))).toBe(true);
  });

  it("bounds concurrent arms by the workflow's maxConcurrency ceiling (spec §3.6)", async () => {
    const barrier = createStepBarrier<string>();
    let current = 0;
    let maxConcurrent = 0;
    const names = ["a", "b", "c", "d", "e"];
    const arms = names.map((name) =>
      createStep({
        name,
        output: numberOutput,
        run: async () => {
          current += 1;
          maxConcurrent = Math.max(maxConcurrent, current);
          await barrier.enter(name);
          current -= 1;
          return { n: name.charCodeAt(0) };
        },
      }),
    );
    const workflow = createWorkflow({ name: "ceiling", maxConcurrency: 2 }).parallel(arms).commit();

    const { host } = createTestHost();
    const resultPromise = runWorkflow(workflow, undefined, host);

    await Promise.all([barrier.waitFor("a"), barrier.waitFor("b")]);
    expect(barrier.entered).toEqual(new Set(["a", "b"])); // "c" must NOT have started yet — ceiling is 2

    barrier.release("a");
    await barrier.waitFor("c");
    expect(barrier.entered.size).toBe(2); // still never more than 2 at once

    barrier.release("b");
    await barrier.waitFor("d");
    barrier.release("c");
    await barrier.waitFor("e");
    barrier.release("d");
    barrier.release("e");

    const result = await resultPromise;
    expect(result.status).toBe("completed");
    expect(maxConcurrent).toBe(2);
  });

  it("a nested workflow's .parallel inherits the ROOT run's ceiling, not its own default (spec §3.6)", async () => {
    const barrier = createStepBarrier<string>();
    let current = 0;
    let maxConcurrent = 0;
    const names = ["x", "y", "z"];
    const arms = names.map((name) =>
      createStep({
        name,
        output: numberOutput,
        run: async () => {
          current += 1;
          maxConcurrent = Math.max(maxConcurrent, current);
          await barrier.enter(name);
          current -= 1;
          return { n: 0 };
        },
      }),
    );
    // The nested workflow's OWN ceiling defaults to 4 (would allow all 3 arms at once); the ROOT
    // declares 1, which must be what actually governs at runtime.
    const nested = createWorkflow({ name: "inner" }).parallel(arms).commit();
    const root = createWorkflow({ name: "outer", maxConcurrency: 1 }).workflow(nested).commit();

    const { host } = createTestHost();
    const resultPromise = runWorkflow(root, undefined, host);

    await barrier.waitFor("x");
    expect(barrier.entered).toEqual(new Set(["x"])); // only one at a time — root ceiling of 1 wins
    barrier.release("x");
    await barrier.waitFor("y");
    barrier.release("y");
    await barrier.waitFor("z");
    barrier.release("z");

    await resultPromise;
    expect(maxConcurrent).toBe(1);
  });
});

describe(".parallel: .commit() validation", () => {
  it("rejects an empty arm list", () => {
    expect(() => createWorkflow({ name: "w" }).parallel([]).commit()).toThrow(/at least one arm/);
  });

  it("rejects two arms sharing a name", () => {
    const a1 = createStep({ name: "dup", run: () => ({}) });
    const a2 = createStep({ name: "dup", run: () => ({}) });
    expect(() => createWorkflow({ name: "w" }).parallel([a1, a2]).commit()).toThrow(/two arms named "dup"/);
  });

  it("rejects an arm name containing node-path syntax", () => {
    const bad = createStep({ name: "bad/name", run: () => ({}) });
    expect(() => createWorkflow({ name: "w" }).parallel([bad]).commit()).toThrow(/node-path syntax/);
  });

  it("rejects a non-step value passed as an arm", () => {
    const notAStep = { name: "nope", run: () => ({}) } as any;
    expect(() => createWorkflow({ name: "w" }).parallel([notAStep]).commit()).toThrow(/expects a step from createStep/);
  });
});
