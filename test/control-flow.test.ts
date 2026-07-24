import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import type { RunContext } from "../src/flow/types.ts";
import { createTestHost } from "./helpers.ts";

const flagSchema = Type.Object({ a: Type.Boolean(), b: Type.Boolean() });

function armBody(name: string, value: string) {
  return createWorkflow({ name })
    .then(createStep({ name: `${name}-step`, output: Type.Object({ picked: Type.String() }), run: () => ({ picked: value }) }))
    .commit();
}

describe("branch node (spec §3.2, multi-match)", () => {
  it("runs every true arm sequentially, output keyed by executed arm names", async () => {
    const seed = createStep({ name: "seed", output: flagSchema, run: () => ({ a: true, b: true }) });
    const workflow = createWorkflow({ name: "branch-both" })
      .then(seed)
      .branch([
        [(ctx: RunContext) => ctx.getStepResult<{ a: boolean }>("seed")?.a === true, armBody("arm-a", "A")],
        [(ctx: RunContext) => ctx.getStepResult<{ b: boolean }>("seed")?.b === true, armBody("arm-b", "B")],
      ])
      .commit();

    const { host, store } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ "arm-a": { picked: "A" }, "arm-b": { picked: "B" } });

    const arms = (await store.loadEvents(result.runId)).filter((e): e is Extract<RunEvent, { type: "branch-arm" }> => e.type === "branch-arm");
    expect(arms.map((e) => [e.path, e.taken])).toEqual([
      ["arm-a", true],
      ["arm-b", true],
    ]);
  });

  it("produces an empty object when no arm condition holds", async () => {
    const seed = createStep({ name: "seed", output: flagSchema, run: () => ({ a: false, b: false }) });
    const workflow = createWorkflow({ name: "branch-none" })
      .then(seed)
      .branch([
        [(ctx: RunContext) => ctx.getStepResult<{ a: boolean }>("seed")?.a === true, armBody("arm-a", "A")],
        [(ctx: RunContext) => ctx.getStepResult<{ b: boolean }>("seed")?.b === true, armBody("arm-b", "B")],
      ])
      .commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({});
  });

  it("runs only the arms whose conditions hold", async () => {
    const seed = createStep({ name: "seed", output: flagSchema, run: () => ({ a: true, b: false }) });
    const workflow = createWorkflow({ name: "branch-one" })
      .then(seed)
      .branch([
        [(ctx: RunContext) => ctx.getStepResult<{ a: boolean }>("seed")?.a === true, armBody("arm-a", "A")],
        [(ctx: RunContext) => ctx.getStepResult<{ b: boolean }>("seed")?.b === true, armBody("arm-b", "B")],
      ])
      .commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.output).toEqual({ "arm-a": { picked: "A" } });
  });
});

const counterSchema = Type.Object({ count: Type.Integer() });

function incBody() {
  return createWorkflow({ name: "inc-body" })
    .then(
      createStep({
        name: "inc",
        input: counterSchema,
        output: counterSchema,
        run: ({ input }) => ({ count: input.count + 1 }),
      }),
    )
    .commit();
}

describe("loop nodes (spec §3.3)", () => {
  it("dountil repeats until the pure condition holds; output is the last iteration's output", async () => {
    const seed = createStep({ name: "seed", output: counterSchema, run: () => ({ count: 0 }) });
    const workflow = createWorkflow({ name: "loop-until" })
      .then(seed)
      .dountil(incBody(), (_ctx, last) => (last as { count: number }).count >= 3, { name: "count-loop" })
      .commit();

    const { host, store } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ count: 3 });

    const iterations = (await store.loadEvents(result.runId)).filter((e) => e.type === "loop-iteration");
    expect(iterations).toHaveLength(3); // ran 3 times
  });

  it("dowhile repeats while the condition holds", async () => {
    const seed = createStep({ name: "seed", output: counterSchema, run: () => ({ count: 0 }) });
    const workflow = createWorkflow({ name: "loop-while" })
      .then(seed)
      .dowhile(incBody(), (_ctx, last) => (last as { count: number }).count < 2, { name: "count-loop" })
      .commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    // iter1 -> {count:1} (1<2 true, continue); iter2 -> {count:2} (2<2 false, stop).
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ count: 2 });
  });

  it("crashes when the max-iteration guard trips", async () => {
    const seed = createStep({ name: "seed", output: counterSchema, run: () => ({ count: 0 }) });
    const workflow = createWorkflow({ name: "loop-runaway" })
      .then(seed)
      .dountil(incBody(), () => false, { name: "runaway", maxIterations: 5 }) // condition never holds
      .commit();

    const { host, store } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/runaway/);
    expect(result.error).toMatch(/max of 5 iterations/);
    const iterations = (await store.loadEvents(result.runId)).filter((e) => e.type === "loop-iteration");
    expect(iterations).toHaveLength(5); // ran exactly the guard limit, then crashed
  });

  it("evaluates the loop condition over the run context (pure, side-effect-free)", async () => {
    // The condition reads a prior step's output via ctx — no mutation, deterministic.
    const target = createStep({ name: "target", output: Type.Object({ target: Type.Integer() }), run: () => ({ target: 2 }) });
    const seed = createStep({ name: "seed", output: counterSchema, run: () => ({ count: 0 }) });
    const workflow = createWorkflow({ name: "loop-ctx" })
      .then(target)
      .then(seed)
      .dountil(incBody(), (ctx, last) => (last as { count: number }).count >= (ctx.getStepResult<{ target: number }>("target")?.target ?? 0), {
        name: "ctx-loop",
      })
      .commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ count: 2 });
  });
});
