import { Type } from "typebox";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import type { WorkflowDefinition } from "../src/flow/types.ts";

export interface ToggleWorkflow {
  workflow: WorkflowDefinition;
  calls: { s1: number; s2: number; s3: number };
  fixStep2(): void;
}

/**
 * A 3-step workflow (`s1 -> s2 -> s3`) where step 2 throws while `failStep2` is true. Each step
 * increments its own invocation counter so tests can prove which steps (re-)ran. `fixStep2()`
 * flips step 2 to succeed, simulating an author fixing the definition before resuming.
 *
 * Outputs chain: s1 `{ a: 1 }` -> s2 `{ b: a + 1 }` -> s3 `{ c: b + 1 }` (final `{ c: 3 }`).
 */
export function buildToggleWorkflow(): ToggleWorkflow {
  const calls = { s1: 0, s2: 0, s3: 0 };
  let failStep2 = true;

  const s1 = createStep({
    name: "s1",
    output: Type.Object({ a: Type.Number() }),
    run: () => {
      calls.s1 += 1;
      return { a: 1 };
    },
  });
  const s2 = createStep({
    name: "s2",
    input: Type.Object({ a: Type.Number() }),
    output: Type.Object({ b: Type.Number() }),
    run: ({ input }) => {
      calls.s2 += 1;
      if (failStep2) throw new Error("boom in s2");
      return { b: input.a + 1 };
    },
  });
  const s3 = createStep({
    name: "s3",
    input: Type.Object({ b: Type.Number() }),
    output: Type.Object({ c: Type.Number() }),
    run: ({ input }) => {
      calls.s3 += 1;
      return { c: input.b + 1 };
    },
  });

  const workflow = createWorkflow({ name: "toggle" }).then(s1).then(s2).then(s3).commit();
  return {
    workflow,
    calls,
    fixStep2: () => {
      failStep2 = false;
    },
  };
}
