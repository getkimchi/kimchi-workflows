import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createTestHost } from "./helpers.ts";

describe("linear hand-off (spec §3.6)", () => {
  it("feeds a step's output into the next step's input when schemas line up", async () => {
    const produce = createStep({
      name: "produce",
      output: Type.Object({ value: Type.Number() }),
      run: () => ({ value: 21 }),
    });
    const double = createStep({
      name: "double",
      input: Type.Object({ value: Type.Number() }),
      output: Type.Object({ doubled: Type.Number() }),
      run: ({ input }) => ({ doubled: input.value * 2 }),
    });
    const workflow = createWorkflow({ name: "pipeline-ish" }).then(produce).then(double).commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ doubled: 42 });
  });

  it("ignores upstream output for a step with no input schema", async () => {
    const produce = createStep({
      name: "produce",
      output: Type.Object({ value: Type.Number() }),
      run: () => ({ value: 99 }),
    });

    let receivedInput: unknown = "not-yet-called";
    const ignoreUpstream = createStep({
      output: Type.Object({ fixed: Type.Boolean() }),
      name: "ignore-upstream",
      run: ({ input }) => {
        receivedInput = input;
        return { fixed: true };
      },
    });
    const workflow = createWorkflow({ name: "ignore-chain" }).then(produce).then(ignoreUpstream).commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(receivedInput).toBeUndefined();
    expect(result.output).toEqual({ fixed: true });
  });
});
