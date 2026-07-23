import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { createManualClock } from "./manual-clock.ts";

const okSchema = Type.Object({ ok: Type.Boolean() });

/** A step that never resolves on its own — it settles only when its abort signal fires. */
const awaitsAbort = (name: string, retry?: { maxAttempts: number }) =>
  createStep({
    name,
    output: okSchema,
    maxDurationMs: 1000,
    retry,
    run: ({ abortSignal }) =>
      new Promise<{ ok: boolean }>((_resolve, reject) => {
        if (abortSignal.aborted) return reject(new Error("aborted"));
        abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });

describe("time budget (Phase 7a, spec §9.3)", () => {
  it("times out a step that exceeds maxDurationMs → budget-exceeded → crash (single attempt)", async () => {
    const clock = createManualClock();
    const { host, store } = createTestHost({ sleep: clock.sleep });
    const workflow = createWorkflow({ name: "timeout-crash" }).then(awaitsAbort("slow")).commit();

    const promise = runWorkflow(workflow, undefined, host);
    await clock.waitForTimer(); // the engine registered the budget timer
    clock.fireAll(); // fire the timeout while the step awaits its abort signal
    const result = await promise;

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/slow/);
    expect(result.error).toMatch(/1000ms time budget/);
    const events = await store.loadEvents(result.runId);
    expect(events.filter((e) => e.type === "step-retry")).toHaveLength(0); // no retry configured
  });

  it("counts budget-exceeded against the retry policy, then crashes when exhausted", async () => {
    const clock = createManualClock();
    const { host, store } = createTestHost({ sleep: clock.sleep });
    const workflow = createWorkflow({ name: "timeout-retry" })
      .then(awaitsAbort("slow", { maxAttempts: 2 }))
      .commit();

    const promise = runWorkflow(workflow, undefined, host);
    await clock.waitForTimer();
    clock.fireAll(); // attempt 1 times out → retry
    await clock.waitForTimer();
    clock.fireAll(); // attempt 2 times out → exhausted
    const result = await promise;

    expect(result.status).toBe("crashed");
    const retries = (await store.loadEvents(result.runId)).filter((e): e is Extract<RunEvent, { type: "step-retry" }> => e.type === "step-retry");
    expect(retries).toHaveLength(1); // 2 attempts → 1 retry
    expect(retries[0]).toMatchObject({ reason: "budget-exceeded", attempt: 1 });
  });

  it("lets a step that finishes within budget complete normally (timer never fired)", async () => {
    const clock = createManualClock();
    const { host } = createTestHost({ sleep: clock.sleep });
    const fast = createStep({ name: "fast", output: okSchema, maxDurationMs: 1000, run: () => ({ ok: true }) });
    const workflow = createWorkflow({ name: "within-budget" }).then(fast).commit();

    // The step resolves on its own; we never fire the clock — no timeout.
    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ok: true });
  });

  it("a run-level cancel aborts a budgeted step before its timer fires (cancel, not budget-exceeded)", async () => {
    const clock = createManualClock();
    const { host, store } = createTestHost({ sleep: clock.sleep });
    const controller = new AbortController();
    const step = createStep({
      name: "cancelable",
      output: okSchema,
      maxDurationMs: 1000,
      run: ({ abortSignal }) =>
        new Promise<{ ok: boolean }>((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    const workflow = createWorkflow({ name: "cancel-budgeted" }).then(step).commit();

    const promise = runWorkflow(workflow, undefined, host, { signal: controller.signal });
    await clock.waitForTimer(); // budget timer registered
    controller.abort(); // run cancel fires first (timer never fired)
    const result = await promise;

    expect(result.status).toBe("cancelled");
    const events = await store.loadEvents(result.runId);
    expect(events.some((e) => e.type === "run-cancelled")).toBe(true);
    expect(events.some((e) => e.type === "run-crashed")).toBe(false);
  });
});
