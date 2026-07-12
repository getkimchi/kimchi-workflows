/**
 * Phase 5b example: a foreach that processes a list sequentially (function-only, offline-testable).
 *
 * A seed step produces a list of numbers; the foreach runs its body once per number (item as input),
 * doubling each; the node output is the array of per-item outputs, in order.
 */
import { Type } from "typebox";
import { createStep, createWorkflow } from "../src/flow/index.ts";

export const itemSchema = Type.Object({ n: Type.Integer() });
export const doubledSchema = Type.Object({ doubled: Type.Integer() });

const seed = createStep({
  name: "seed",
  output: Type.Object({ numbers: Type.Array(Type.Integer()) }),
  run: () => ({ numbers: [1, 2, 3, 4] }),
});

const doubleBody = createWorkflow({ name: "double-body" })
  .then(
    createStep({
      name: "double-item",
      input: itemSchema,
      output: doubledSchema,
      run: ({ input }) => ({ doubled: input.n * 2 }),
    }),
  )
  .commit();

const batchWorkflow = createWorkflow({ name: "batch", description: "Double each number in a list via foreach (Phase 5b)" })
  .then(seed)
  .foreach(doubleBody, (ctx) => (ctx.getStepResult<{ numbers: number[] }>("seed")?.numbers ?? []).map((n) => ({ n })), { name: "double-each" })
  .commit();

export default batchWorkflow;
