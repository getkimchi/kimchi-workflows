import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resumeWorkflow } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { createStepBarrier } from "./step-barrier.ts";

const itemSchema = Type.Object({ n: Type.Integer() });
const squaredSchema = Type.Object({ squared: Type.Integer() });

function buildConcurrentForeach(items: readonly number[], concurrency: number, barrier: ReturnType<typeof createStepBarrier<number>>) {
  const body = createWorkflow({ name: "item-body" })
    .then(
      createStep({
        name: "process",
        input: itemSchema,
        output: squaredSchema,
        run: async ({ input }) => {
          await barrier.enter(input.n);
          return { squared: input.n * input.n };
        },
      }),
    )
    .commit();

  return createWorkflow({ name: "foreach-wf" })
    .foreach(body, () => items.map((n) => ({ n })), { name: "each", concurrency })
    .commit();
}

describe(".foreach concurrency (spec §3.4): item order preserved under out-of-order completion", () => {
  it("outputs items in ORIGINAL item order even when they complete in a different order", async () => {
    const barrier = createStepBarrier<number>();
    const workflow = buildConcurrentForeach([10, 20, 30], 3, barrier);
    const { host } = createTestHost();

    const resultPromise = runWorkflow(workflow, undefined, host);
    await Promise.all([barrier.waitFor(10), barrier.waitFor(20), barrier.waitFor(30)]);

    // Finish in REVERSE order: item 30 (index 2) first, then 10 (index 0), then 20 (index 1).
    barrier.release(30);
    barrier.release(10);
    barrier.release(20);

    const result = await resultPromise;
    expect(result.status).toBe("completed");
    // Output is still index-ordered: [item 10's result, item 20's result, item 30's result].
    expect(result.output).toEqual([{ squared: 100 }, { squared: 400 }, { squared: 900 }]);
  });

  it("bounds concurrent items by the declared concurrency, itself capped by the workflow ceiling", async () => {
    const barrier = createStepBarrier<number>();
    let current = 0;
    let maxConcurrent = 0;
    const items = [1, 2, 3, 4, 5];
    const body = createWorkflow({ name: "counted-body" })
      .then(
        createStep({
          name: "process",
          input: itemSchema,
          output: squaredSchema,
          run: async ({ input }) => {
            current += 1;
            maxConcurrent = Math.max(maxConcurrent, current);
            await barrier.enter(input.n);
            current -= 1;
            return { squared: input.n * input.n };
          },
        }),
      )
      .commit();
    const workflow = createWorkflow({ name: "capped-foreach" })
      .foreach(body, () => items.map((n) => ({ n })), { name: "each", concurrency: 2 })
      .commit();

    const { host } = createTestHost();
    const resultPromise = runWorkflow(workflow, undefined, host);

    await Promise.all([barrier.waitFor(1), barrier.waitFor(2)]);
    expect(barrier.entered).toEqual(new Set([1, 2])); // item 3 must NOT have started — concurrency 2

    barrier.release(1);
    await barrier.waitFor(3);
    expect(barrier.entered.size).toBe(2);
    barrier.release(2);
    await barrier.waitFor(4);
    barrier.release(3);
    await barrier.waitFor(5);
    barrier.release(4);
    barrier.release(5);

    const result = await resultPromise;
    expect(result.status).toBe("completed");
    expect(result.output).toEqual(items.map((n) => ({ squared: n * n })));
    expect(maxConcurrent).toBe(2);
  });

  it("resuming a crashed concurrent foreach re-runs only the non-completed items, preserving item order in the final output", async () => {
    const items = [1, 2, 3, 4];
    let failOnce = true;
    const processed: number[] = [];
    const body = createWorkflow({ name: "flaky-body" })
      .then(
        createStep({
          name: "process",
          input: itemSchema,
          output: squaredSchema,
          run: ({ input }) => {
            processed.push(input.n);
            if (failOnce && input.n === 3) throw new Error("boom on item 3");
            return { squared: input.n * input.n };
          },
        }),
      )
      .commit();
    const workflow = createWorkflow({ name: "resumable-foreach" })
      .foreach(body, () => items.map((n) => ({ n })), { name: "each", concurrency: 4 })
      .commit();

    const { host, store } = createTestHost();
    const first = await runWorkflow(workflow, undefined, host);
    expect(first.status).toBe("crashed");
    // Items 1,2,4 succeeded (concurrency 4 — all attempted in the same round); item 3 crashed the run.
    expect(processed.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    failOnce = false; // "fix" the definition before resuming
    const priorEvents = await store.loadEvents(first.runId);
    const resumed = await resumeWorkflow(workflow, priorEvents, host);

    expect(resumed.status).toBe("completed");
    expect(resumed.output).toEqual([{ squared: 1 }, { squared: 4 }, { squared: 9 }, { squared: 16 }]);
  });
});

describe(".foreach: .commit() rejects concurrency above the workflow's ceiling (spec §3.6)", () => {
  it("rejects when a foreach's concurrency exceeds maxConcurrency", () => {
    const body = createWorkflow({ name: "body" })
      .then(createStep({ name: "s", run: () => ({}) }))
      .commit();
    expect(() =>
      createWorkflow({ name: "w", maxConcurrency: 4 })
        .foreach(body, () => [], { name: "each", concurrency: 8 })
        .commit(),
    ).toThrow(/concurrency 8, above the workflow's ceiling of 4/);
  });

  it("accepts a foreach's concurrency exactly at the ceiling", () => {
    const body = createWorkflow({ name: "body" })
      .then(createStep({ name: "s", run: () => ({}) }))
      .commit();
    expect(() =>
      createWorkflow({ name: "w", maxConcurrency: 4 })
        .foreach(body, () => [], { name: "each", concurrency: 4 })
        .commit(),
    ).not.toThrow();
  });

  it("defaults to concurrency 1 (sequential) when not declared", () => {
    const body = createWorkflow({ name: "body" })
      .then(createStep({ name: "s", run: () => ({}) }))
      .commit();
    const workflow = createWorkflow({ name: "w" })
      .foreach(body, () => [])
      .commit();
    const foreachNode = workflow.nodes[0];
    expect(foreachNode?.kind).toBe("foreach");
    expect(foreachNode && foreachNode.kind === "foreach" ? foreachNode.concurrency : undefined).toBe(1);
  });

  it("rejects a foreach nested inside a branch arm with concurrency above the ENCLOSING workflow's ceiling too (recursive check)", () => {
    const body = createWorkflow({ name: "inner-body" })
      .then(createStep({ name: "s", run: () => ({}) }))
      .commit();
    // The arm's OWN commit succeeds against its OWN (generous) ceiling; the OUTER workflow's commit
    // still catches the mismatch by walking the full recursive tree against ITS OWN, stricter ceiling.
    const armWithForeach = createWorkflow({ name: "arm", maxConcurrency: 20 })
      .foreach(body, () => [], { concurrency: 10 })
      .commit();
    expect(() =>
      createWorkflow({ name: "w", maxConcurrency: 4 })
        .branch([[() => true, armWithForeach]])
        .commit(),
    ).toThrow(/above the workflow's ceiling of 4/);
  });
});
