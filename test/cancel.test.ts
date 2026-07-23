import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resumeWorkflow } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import type { WorkflowDefinition } from "../src/flow/types.ts";
import { createTestHost } from "./helpers.ts";

const aSchema = Type.Object({ a: Type.Number() });
const bSchema = Type.Object({ b: Type.Number() });
const cSchema = Type.Object({ c: Type.Number() });

/**
 * `s1 -> s2 -> s3`. `onS1Run` fires when s1's body runs — the test aborts the shared controller
 * there to trigger a boundary cancel before s2. `failS2WithAbort`, when set, makes s2 abort then
 * throw (the "throw while aborted" path). Counters prove which steps (re-)ran.
 */
function buildCancelWorkflow(hooks: { onS1Run?: () => void; s2Body?: () => { b: number } }): {
  workflow: WorkflowDefinition;
  calls: { s1: number; s2: number; s3: number };
} {
  const calls = { s1: 0, s2: 0, s3: 0 };
  const s1 = createStep({
    name: "s1",
    output: aSchema,
    run: () => {
      calls.s1 += 1;
      hooks.onS1Run?.();
      return { a: 1 };
    },
  });
  const s2 = createStep({
    name: "s2",
    input: aSchema,
    output: bSchema,
    run: ({ input }) => {
      calls.s2 += 1;
      return hooks.s2Body ? hooks.s2Body() : { b: input.a + 1 };
    },
  });
  const s3 = createStep({
    name: "s3",
    input: bSchema,
    output: cSchema,
    run: ({ input }) => {
      calls.s3 += 1;
      return { c: input.b + 1 };
    },
  });
  return { workflow: createWorkflow({ name: "cancelable" }).then(s1).then(s2).then(s3).commit(), calls };
}

describe("cancellation (spec §5, §8.6)", () => {
  it("aborts at the step boundary before step 2: cancelled, run-cancelled emitted, steps 2/3 never start", async () => {
    const controller = new AbortController();
    const { workflow, calls } = buildCancelWorkflow({ onS1Run: () => controller.abort() });
    const { host, store } = createTestHost();

    const result = await runWorkflow(workflow, undefined, host, { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(calls).toEqual({ s1: 1, s2: 0, s3: 0 });

    const events = await store.loadEvents(result.runId);
    expect(events.some((event) => event.type === "run-cancelled")).toBe(true);
    expect(events.some((event) => event.type === "run-crashed")).toBe(false);
    const started = events.filter((event) => event.type === "step-started").map((event) => event.stepName);
    expect(started).toEqual(["s1"]); // s2 and s3 never started
  });

  it("treats a throw while aborted as cancellation, not a crash", async () => {
    const controller = new AbortController();
    const { workflow } = buildCancelWorkflow({
      s2Body: () => {
        controller.abort();
        throw new Error("boom during cancel");
      },
    });
    const { host, store } = createTestHost();

    const result = await runWorkflow(workflow, undefined, host, { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    const events = await store.loadEvents(result.runId);
    expect(events.some((event) => event.type === "run-cancelled")).toBe(true);
    expect(events.some((event) => event.type === "run-crashed")).toBe(false);
  });

  it("lists a cancelled run as cancelled, and resume continues from the last completed step", async () => {
    const controller = new AbortController();
    const { workflow, calls } = buildCancelWorkflow({ onS1Run: () => controller.abort() });
    const { host, store } = createTestHost();

    const cancelledRun = await runWorkflow(workflow, undefined, host, { signal: controller.signal });
    expect(cancelledRun.status).toBe("cancelled");

    const listed = await store.list();
    expect(listed[0]).toMatchObject({ runId: cancelledRun.runId, status: "cancelled" });

    // Resume without a signal: s1 (completed) is skipped, so it is not re-run and does not re-abort.
    const resumed = await resumeWorkflow(workflow, await store.loadEvents(cancelledRun.runId), host);

    expect(resumed.status).toBe("completed");
    expect(resumed.runId).toBe(cancelledRun.runId);
    expect(resumed.output).toEqual({ c: 3 });
    expect(calls).toEqual({ s1: 1, s2: 1, s3: 1 }); // s1 not re-run
    expect((await store.list())[0]).toMatchObject({ status: "completed" });
  });
});
