import { describe, expect, it } from "vitest";
import helloWorkflow from "../examples/hello.workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createTestHost } from "./helpers.ts";

describe("hello workflow (Phase 1 tracer bullet)", () => {
  it("runs the example end-to-end through the engine to completed", async () => {
    const { host, store } = createTestHost();

    const result = await runWorkflow(helloWorkflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ message: "Hello, PI workflows!" });

    const runs = await store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: result.runId,
      workflowName: "hello",
      status: "completed",
    });
    expect(runs[0]?.startedAt).toBeTruthy();
    expect(runs[0]?.completedAt).toBeTruthy();
  });

  it("emits the expected lifecycle event sequence", async () => {
    const { host } = createTestHost();
    const events: string[] = [];
    const spyingHost: typeof host = {
      ...host,
      emit: async (event) => {
        events.push(event.type);
        await host.emit(event);
      },
    };

    const result = await runWorkflow(helloWorkflow, undefined, spyingHost);

    expect(result.status).toBe("completed");
    expect(events).toEqual(["run-started", "step-started", "step-completed", "run-completed"]);
  });

  it("uses an injected clock and run id, so the event log is fully deterministic", async () => {
    const at = "2026-07-12T00:00:00.000Z";
    const { host } = createTestHost({ generateRunId: () => "run-fixed-1", now: () => new Date(at) });
    const events: RunEvent[] = [];
    const spyingHost: typeof host = {
      ...host,
      emit: async (event) => {
        events.push(event);
        await host.emit(event);
      },
    };

    const result = await runWorkflow(helloWorkflow, undefined, spyingHost);

    expect(result.runId).toBe("run-fixed-1");
    expect(events).toEqual([
      { type: "run-started", runId: "run-fixed-1", workflowName: "hello", input: undefined, at },
      { type: "step-started", runId: "run-fixed-1", stepIndex: 0, stepName: "say-hello", input: undefined, at },
      { type: "step-completed", runId: "run-fixed-1", stepIndex: 0, stepName: "say-hello", output: { message: "Hello, PI workflows!" }, at },
      { type: "run-completed", runId: "run-fixed-1", output: { message: "Hello, PI workflows!" }, at },
    ]);
  });
});
