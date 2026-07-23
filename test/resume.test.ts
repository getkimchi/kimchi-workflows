import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resumeWorkflow } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { buildToggleWorkflow } from "./toggle-workflow.ts";

describe("resume (spec §8): continue after the last completed step", () => {
  it("skips completed step 1, re-runs the fixed step 2 and step 3, reaches completed with the same run-id", async () => {
    const { workflow, calls, fixStep2 } = buildToggleWorkflow();
    const { host, store } = createTestHost();

    // Original run: crashes in s2 after s1 completed.
    const first = await runWorkflow(workflow, undefined, host);
    expect(first.status).toBe("crashed");
    expect(calls).toEqual({ s1: 1, s2: 1, s3: 0 });

    // Capture the partial log exactly as persisted.
    const priorEvents = await store.loadEvents(first.runId);

    // "Fix" step 2 and resume from the captured log.
    fixStep2();
    const resumed = await resumeWorkflow(workflow, priorEvents, host);

    expect(resumed.status).toBe("completed");
    expect(resumed.runId).toBe(first.runId); // same run-id, same log
    expect(resumed.output).toEqual({ c: 3 }); // s1{a:1} -> s2{b:2} -> s3{c:3}
    expect(calls).toEqual({ s1: 1, s2: 2, s3: 1 }); // s1 NOT re-run; s2 re-run once; s3 run once
  });

  it("emits run-resumed (not a second run-started) and appends to the same log", async () => {
    const { workflow, fixStep2 } = buildToggleWorkflow();
    const { host, store } = createTestHost();

    const first = await runWorkflow(workflow, undefined, host);
    const priorEvents = await store.loadEvents(first.runId);

    fixStep2();
    await resumeWorkflow(workflow, priorEvents, host);

    const fullLog = await store.loadEvents(first.runId);
    const timeline = fullLog.map((event) => ("stepName" in event ? `${event.type}:${event.stepName}` : event.type));
    expect(timeline).toEqual([
      "run-started",
      "step-started:s1",
      "step-completed:s1",
      "step-started:s2",
      "run-crashed:s2",
      "run-resumed", // carries fromStepName, asserted below
      "step-started:s2",
      "step-completed:s2",
      "step-started:s3",
      "step-completed:s3",
      "run-completed",
    ]);

    // Exactly one run-started; the continuation is a run-resumed that resumes at the interrupted step.
    expect(fullLog.filter((event) => event.type === "run-started")).toHaveLength(1);
    const resumedEvents = fullLog.filter((event) => event.type === "run-resumed");
    expect(resumedEvents).toHaveLength(1);
    expect(resumedEvents[0]).toMatchObject({ type: "run-resumed", fromStepName: "s2" });
  });

  it("lists a resumed-to-completed run as completed", async () => {
    const { workflow, fixStep2 } = buildToggleWorkflow();
    const { host, store } = createTestHost();

    const first = await runWorkflow(workflow, undefined, host);
    fixStep2();
    await resumeWorkflow(workflow, await store.loadEvents(first.runId), host);

    const runs = await store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: first.runId, status: "completed" });
  });

  it("fails with a descriptive error when a previously-completed step no longer exists (definition drift)", async () => {
    // Prior log records step "s1" as completed...
    const priorEvents: RunEvent[] = [
      { type: "run-started", runId: "drift-run", workflowName: "toggle", input: undefined, at: "t0" },
      { type: "step-started", runId: "drift-run", stepIndex: 0, stepName: "s1", input: undefined, at: "t1" },
      { type: "step-completed", runId: "drift-run", stepIndex: 0, stepName: "s1", output: { a: 1 }, at: "t2" },
      { type: "run-crashed", runId: "drift-run", stepName: "s2", error: "boom", at: "t3" },
    ];

    // ...but the reloaded workflow renamed s1 -> s1b, so s1 is gone.
    const renamed = createWorkflow({ name: "toggle" })
      .then(createStep({ name: "s1b", output: Type.Object({ a: Type.Number() }), run: () => ({ a: 1 }) }))
      .then(createStep({ name: "s2", input: Type.Object({ a: Type.Number() }), run: () => ({ b: 2 }) }))
      .commit();

    const { host } = createTestHost();
    const result = await resumeWorkflow(renamed, priorEvents, host);

    expect(result.status).toBe("crashed");
    expect(result.runId).toBe("drift-run");
    expect(result.error).toMatch(/s1/);
    expect(result.error).toMatch(/no longer exists|drift/);
  });
});
