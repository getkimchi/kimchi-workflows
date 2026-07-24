import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";

type StepRetryEvent = Extract<RunEvent, { type: "step-retry" }>;

describe("retry policy (spec §9)", () => {
  it("retries a thrown error and succeeds within maxRetry, sleeping the backoff", async () => {
    let attempts = 0;
    const flaky = createStep({
      name: "flaky",
      output: Type.Object({ ok: Type.Boolean() }),
      retry: { maxRetry: 1, backoffMs: 50 }, // 1 retry after the first = 2 total attempts
      run: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient failure");
        return { ok: true };
      },
    });
    const workflow = createWorkflow({ name: "retry-success" }).then(flaky).commit();
    const { host, store, sleepCalls } = createTestHost();

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);

    const retries = (await store.loadEvents(result.runId)).filter((event): event is StepRetryEvent => event.type === "step-retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ stepName: "flaky", attempt: 1, reason: "thrown-error" });
    expect(sleepCalls).toEqual([50]); // backoff requested exactly once
  });

  it("crashes after exhausting maxRetry, emitting one fewer step-retry than attempts", async () => {
    let attempts = 0;
    const broken = createStep({
      name: "broken",
      retry: { maxRetry: 2, backoffMs: 10 }, // 2 retries after the first = 3 total attempts
      run: () => {
        attempts += 1;
        throw new Error(`fail ${attempts}`);
      },
    });
    const workflow = createWorkflow({ name: "retry-exhaust" }).then(broken).commit();
    const { host, store, sleepCalls } = createTestHost();

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(attempts).toBe(3);
    expect(result.error).toBe("fail 3"); // the last error is recorded

    const retries = (await store.loadEvents(result.runId)).filter((event) => event.type === "step-retry");
    expect(retries).toHaveLength(2); // 3 attempts -> 2 retries
    expect(sleepCalls).toEqual([10, 10]);
  });

  it("retries an invalid output but never retries an invalid input", async () => {
    // Invalid output: strict schema fails on attempt 1, passes on attempt 2 -> completed.
    let n = 0;
    const strict = createStep({
      name: "strict",
      output: Type.Object({ count: Type.Integer({ minimum: 10 }) }),
      retry: { maxRetry: 1 }, // 1 retry after the first = 2 total attempts
      run: () => {
        n += 1;
        return { count: n === 1 ? 1 : 10 };
      },
    });
    const outputWorkflow = createWorkflow({ name: "retry-output" }).then(strict).commit();
    const { host: outHost, store: outStore } = createTestHost();

    const outResult = await runWorkflow(outputWorkflow, undefined, outHost);
    expect(outResult.status).toBe("completed");
    const outRetries = (await outStore.loadEvents(outResult.runId)).filter((event): event is StepRetryEvent => event.type === "step-retry");
    expect(outRetries).toHaveLength(1);
    expect(outRetries[0]).toMatchObject({ reason: "invalid-output", attempt: 1 });

    // Invalid input: upstream output violates the consumer's input schema -> immediate crash, no retry.
    let consumerRuns = 0;
    const produce = createStep({ name: "produce", output: Type.Object({ v: Type.String() }), run: () => ({ v: "hi" }) });
    const consume = createStep({
      name: "consume",
      input: Type.Object({ n: Type.Number() }), // expects a number `n`, gets a string `v`
      retry: { maxRetry: 4 }, // 4 retries after the first = 5 total attempts (never reached: input violation crashes first)
      run: () => {
        consumerRuns += 1;
        return { ok: true };
      },
    });
    const inputWorkflow = createWorkflow({ name: "retry-input" }).then(produce).then(consume).commit();
    const { host: inHost, store: inStore } = createTestHost();

    const inResult = await runWorkflow(inputWorkflow, undefined, inHost);
    expect(inResult.status).toBe("crashed");
    expect(inResult.error).toMatch(/consume/);
    expect(consumerRuns).toBe(0); // body never ran
    const inRetries = (await inStore.loadEvents(inResult.runId)).filter((event) => event.type === "step-retry");
    expect(inRetries).toHaveLength(0); // input violation is not retried
  });
});
