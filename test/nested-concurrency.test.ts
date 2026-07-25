import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { createStepBarrier } from "./step-barrier.ts";

const numberOutput = Type.Object({ n: Type.Integer() });

/**
 * spec §3.6: the ceiling bounds "the total number of STEPS executing at once across every construct in
 * the run". That wording is load-bearing once constructs NEST — a `.foreach` whose body fans out again.
 * If the slot were held by the enclosing construct instead of by the step, a foreach sitting at the
 * ceiling would occupy every slot while each of its items waited for a slot of its own, and the run
 * would hang forever with nothing to interrupt it (no timeout, and the project lock held throughout).
 */
describe("nested concurrent constructs (spec §3.6)", () => {
  it("a .foreach at the ceiling whose body fans out with .parallel still completes", async () => {
    const body = createWorkflow({ name: "item-body" })
      .parallel([createStep({ name: "left", output: numberOutput, run: () => ({ n: 1 }) }), createStep({ name: "right", output: numberOutput, run: () => ({ n: 2 }) })], {
        name: "fan",
      })
      .commit();
    // concurrency === maxConcurrency: every item is admitted at once, so every inner .parallel arm has
    // to find its slot behind them.
    const workflow = createWorkflow({ name: "foreach-of-parallel", maxConcurrency: 4 })
      .foreach(body, () => [1, 2, 3, 4], { name: "each", concurrency: 4 })
      .commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual(Array.from({ length: 4 }, () => ({ left: { n: 1 }, right: { n: 2 } })));
  });

  it("never runs more steps at once than the ceiling, counting across both nested constructs", async () => {
    const barrier = createStepBarrier<string>();
    let current = 0;
    let maxConcurrent = 0;

    // Each arm receives the foreach ITEM as its input (the body's linear hand-off), so the barrier can
    // key on `<item>:<arm>` and tell the two arms of DIFFERENT items apart.
    const armStep = (name: string) =>
      createStep({
        name,
        input: Type.Integer(),
        output: numberOutput,
        run: async ({ input }) => {
          current += 1;
          maxConcurrent = Math.max(maxConcurrent, current);
          await barrier.enter(`${input}:${name}`);
          current -= 1;
          return { n: input };
        },
      });

    const body = createWorkflow({ name: "item-body" })
      .parallel([armStep("left"), armStep("right")], { name: "fan" })
      .commit();
    const workflow = createWorkflow({ name: "bounded-nesting", maxConcurrency: 2 })
      .foreach(body, () => [1, 2], { name: "each", concurrency: 2 })
      .commit();

    const { host } = createTestHost();
    const resultPromise = runWorkflow(workflow, undefined, host);

    // Four steps want to run at once (2 items × 2 arms); only 2 ever do — the ceiling counts steps
    // across BOTH constructs, so the second item's arms wait even though its own lane is free.
    await Promise.all([barrier.waitFor("1:left"), barrier.waitFor("1:right")]);
    expect(barrier.entered).toEqual(new Set(["1:left", "1:right"]));
    expect(maxConcurrent).toBe(2);

    barrier.release("1:left");
    await barrier.waitFor("2:left"); // a freed slot admits the next queued step, in another construct
    expect(barrier.entered.size).toBe(2);

    barrier.release("1:right");
    await barrier.waitFor("2:right");
    barrier.release("2:left");
    barrier.release("2:right");

    const result = await resultPromise;
    expect(result.status).toBe("completed");
    expect(maxConcurrent).toBe(2); // never exceeded, though four steps wanted to run
  });
});
