import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";

describe("TypeBox validation failure", () => {
  it("fails the step with a descriptive error and crashes the run", async () => {
    // `count` type-checks fine (TS only sees `number`); the runtime constraint (>= 10) is
    // what TypeBox catches — proving validation happens at the schema, not just the type level.
    const tooSmall = createStep({
      name: "produce-count",
      output: Type.Object({ count: Type.Integer({ minimum: 10 }) }),
      run: () => ({ count: 1 }),
    });
    const workflow = createWorkflow({ name: "broken" }).then(tooSmall).commit();

    const { host, store } = createTestHost();
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/produce-count/);
    expect(result.error).toMatch(/count/);

    const runs = await store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: result.runId, workflowName: "broken", status: "crashed" });
  });

  it("does not emit step-completed for the failing step", async () => {
    const tooSmall = createStep({
      name: "produce-count",
      output: Type.Object({ count: Type.Integer({ minimum: 10 }) }),
      run: () => ({ count: 1 }),
    });
    const workflow = createWorkflow({ name: "broken" }).then(tooSmall).commit();

    const { host, events } = createTestHost();

    await runWorkflow(workflow, undefined, host);

    expect(events.map((event) => event.type)).toEqual(["run-started", "step-started", "run-crashed"]);
  });
});
