import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import batchWorkflow from "../examples/batch.workflow.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createTestHost } from "./helpers.ts";

const itemSchema = Type.Object({ n: Type.Integer() });

/** A foreach that runs `body` over `items`; `appendLog` records the item order the body observed. */
function buildForeachWorkflow(items: readonly number[], appendLog: number[]) {
  const body = createWorkflow({ name: "item-body" })
    .then(
      createStep({
        name: "process",
        input: itemSchema,
        output: Type.Object({ squared: Type.Integer() }),
        run: ({ input }) => {
          appendLog.push(input.n);
          return { squared: input.n * input.n };
        },
      }),
    )
    .commit();

  return createWorkflow({ name: "foreach-wf" })
    .foreach(body, () => items.map((n) => ({ n })), { name: "each" })
    .commit();
}

describe("foreach node (spec §3.4, sequential)", () => {
  it("runs the body once per item and outputs the per-item results in order", async () => {
    const appendLog: number[] = [];
    const workflow = buildForeachWorkflow([2, 3, 4], appendLog);
    const { host, store } = createTestHost();

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([{ squared: 4 }, { squared: 9 }, { squared: 16 }]);
    expect(appendLog).toEqual([2, 3, 4]); // sequential, in selector order

    const events = await store.loadEvents(result.runId);
    const started = events.find((e): e is Extract<RunEvent, { type: "foreach-started" }> => e.type === "foreach-started");
    expect(started?.count).toBe(3);
    const completed = events.filter((e): e is Extract<RunEvent, { type: "foreach-item-completed" }> => e.type === "foreach-item-completed");
    expect(completed.map((e) => e.index)).toEqual([0, 1, 2]); // per-item checkpoints in order
  });

  it("completes immediately with an empty array when the selector yields no items", async () => {
    const appendLog: number[] = [];
    const workflow = buildForeachWorkflow([], appendLog);
    const { host, store } = createTestHost();

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([]);
    expect(appendLog).toEqual([]);
    const events = await store.loadEvents(result.runId);
    expect(events.some((e) => e.type === "foreach-item-started")).toBe(false); // no items ran
  });

  it("calls the selector once and iterates strictly sequentially (no concurrency)", async () => {
    let selectorCalls = 0;
    const order: string[] = [];
    const body = createWorkflow({ name: "seq-body" })
      .then(
        createStep({
          name: "seq-step",
          input: itemSchema,
          output: itemSchema,
          run: async ({ input }) => {
            order.push(`start-${input.n}`);
            await Promise.resolve();
            order.push(`end-${input.n}`);
            return input;
          },
        }),
      )
      .commit();
    const workflow = createWorkflow({ name: "seq-foreach" })
      .foreach(
        body,
        () => {
          selectorCalls += 1;
          return [{ n: 1 }, { n: 2 }, { n: 3 }];
        },
        { name: "seq-each" },
      )
      .commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(selectorCalls).toBe(1); // selector evaluated exactly once
    // Each item fully finishes before the next starts (no interleaving).
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("runs the batch example end-to-end", async () => {
    const { host } = createTestHost();
    const result = await runWorkflow(batchWorkflow, undefined, host);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual([{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }, { doubled: 8 }]);
  });
});
