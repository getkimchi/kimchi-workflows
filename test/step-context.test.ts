import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";

describe("step context (spec §2.5): { input, ctx, abortSignal, logger }", () => {
  it("gives every step a run context, a live abort signal, and a working logger", async () => {
    const step = createStep({
      name: "introspect",
      run: ({ ctx, abortSignal, logger }) => {
        logger.info("hello from the step", { answer: 42 });
        return {
          runId: ctx.runId,
          workflowName: ctx.workflowName,
          aborted: abortSignal.aborted,
          hasAbortSignal: abortSignal instanceof AbortSignal,
        };
      },
    });
    const workflow = createWorkflow({ name: "introspection" }).then(step).commit();

    const { host, events } = createTestHost();

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toMatchObject({
      runId: result.runId,
      workflowName: "introspection",
      aborted: false,
      hasAbortSignal: true,
    });

    const logEvent = events.find((event) => event.type === "step-log");
    expect(logEvent).toMatchObject({
      type: "step-log",
      stepName: "introspect",
      level: "info",
      message: "hello from the step",
      data: { answer: 42 },
    });
  });

  it("exposes prior step outputs via ctx.getStepResult and workflow init data via ctx.getInitData", async () => {
    const first = createStep({
      name: "first",
      run: () => ({ seed: 7 }),
    });
    const second = createStep({
      name: "second",
      run: ({ ctx }) => ({
        fromFirst: ctx.getStepResult<{ seed: number }>("first"),
        init: ctx.getInitData<string>(),
      }),
    });
    const workflow = createWorkflow({ name: "context-access" }).then(first).then(second).commit();

    const { host } = createTestHost();
    const result = await runWorkflow(workflow, "init-value", host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ fromFirst: { seed: 7 }, init: "init-value" });
  });
});
