import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { AgentSession, RunEvent } from "../src/engine/types.ts";
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { createManualClock } from "./manual-clock.ts";

const okSchema = Type.Object({ ok: Type.Boolean() });

/** A step that never resolves on its own — it settles only when its abort signal fires. */
const awaitsAbort = (name: string, retry?: { maxRetry: number }) =>
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
      .then(awaitsAbort("slow", { maxRetry: 1 })) // 1 retry after the first = 2 total attempts
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

  it("excludes blocked time from the budget (spec §9.4): a human taking a long time to answer cannot crash the run", async () => {
    const clock = createManualClock();
    const questionnaire = { questions: [{ key: "x", header: "X", question: "X?", kind: "text" as const }] };
    const step = createAgentStep({ name: "asker", output: okSchema, asks: true, maxDurationMs: 1000, prompt: () => "go" });
    const workflow = createWorkflow({ name: "time-continuation-slow-human" }).then(step).commit();

    let call = 0;
    const startAgent = (): AgentSession => {
      const index = call++;
      return {
        async sendAndAwaitEnd() {
          if (index === 0) return { text: JSON.stringify({ questions: questionnaire }) };
          return { text: JSON.stringify({ result: { ok: true } }) };
        },
        getConversation: () => [],
        dispose: () => {},
      };
    };
    // A single fixed instant while the run is actively executing — it is the multi-day GAP between
    // blocking and resuming (below), never sampled by anything, that stands in for the slow human.
    let now = new Date("2026-01-01T00:00:00.000Z");
    const { host, store } = createTestHost({ startAgent, sleep: clock.sleep, now: () => now });

    const blocked = await runWorkflow(workflow, undefined, host);
    expect(blocked.status).toBe("blocked");

    // A week passes while blocked — nothing samples the clock in that gap, so no time is ever charged
    // to the budget for it (spec §9.4).
    now = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const events = await store.loadEvents(blocked.runId);
    const result = await resumeWithAnswer(workflow, events, { x: "hi" }, host);

    expect(result.status).toBe("completed"); // the week spent blocked never counted against the 1000ms budget
  });

  it("carries wall-clock time spent in_progress across a block/answer continuation cumulatively (spec §9.4)", async () => {
    const clock = createManualClock();
    const questionnaire = { questions: [{ key: "x", header: "X", question: "X?", kind: "text" as const }] };
    const step = createAgentStep({ name: "asker", output: okSchema, asks: true, maxDurationMs: 1000, prompt: () => "go" });
    const workflow = createWorkflow({ name: "time-continuation-cumulative" }).then(step).commit();

    let ms = 0;
    let secondSessionCalls = 0;
    let call = 0;
    const startAgent = (): AgentSession => {
      const index = call++;
      return {
        async sendAndAwaitEnd() {
          if (index === 0) {
            ms += 1000; // the WHOLE budget spent in_progress before it ever asks
            return { text: JSON.stringify({ questions: questionnaire }) };
          }
          secondSessionCalls += 1;
          return { text: JSON.stringify({ result: { ok: true } }) };
        },
        getConversation: () => [],
        dispose: () => {},
      };
    };
    const { host, store } = createTestHost({ startAgent, sleep: clock.sleep, now: () => new Date(ms) });

    const blocked = await runWorkflow(workflow, undefined, host);
    expect(blocked.status).toBe("blocked");

    const events = await store.loadEvents(blocked.runId);
    const asked = events.find((event): event is Extract<RunEvent, { type: "questionnaire-asked" }> => event.type === "questionnaire-asked");
    expect(asked?.elapsedMs).toBe(1000); // the whole budget already recorded as spent, at the moment of blocking

    const result = await resumeWithAnswer(workflow, events, { x: "hi" }, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/1000ms time budget/);
    expect(secondSessionCalls).toBe(0); // rejected before even starting a new attempt — no bonus fresh window
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
