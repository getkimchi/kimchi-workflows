import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createAgentStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { scriptedAgent } from "./scripted-agent.ts";

const outputSchema = Type.Object({ summary: Type.String() });
const valid = '{"summary":"ok"}';

function steerEvents(events: RunEvent[]): Extract<RunEvent, { type: "agent-steer" }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: "agent-steer" }> => event.type === "agent-steer");
}

function retryEvents(events: RunEvent[]): Extract<RunEvent, { type: "step-retry" }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: "step-retry" }> => event.type === "step-retry");
}

describe(".commit() rejects background + asks (spec §10.1)", () => {
  it("rejects a top-level agent step declaring both", () => {
    expect(() =>
      createWorkflow({ name: "w" })
        .then(createAgentStep({ name: "s", output: outputSchema, background: true, asks: true, prompt: () => "go" }))
        .commit(),
    ).toThrow(/background.*asks|asks.*background/i);
  });

  it("rejects the combination when it is one of several `.parallel()` arms, not just a lone top-level step", () => {
    // A parallel's arms are plain steps checked within the SAME commit() call (spec §3.5), unlike a
    // branch arm/loop body (each pre-committed separately) — this proves the recursive walk finds the
    // violation buried among otherwise-valid siblings, not just when it is the workflow's only node.
    expect(() =>
      createWorkflow({ name: "w" })
        .parallel([
          createAgentStep({ name: "ok", output: outputSchema, prompt: () => "go" }),
          createAgentStep({ name: "bad", output: outputSchema, background: true, asks: true, prompt: () => "go" }),
        ])
        .commit(),
    ).toThrow(/spec §10\.1|background.*asks/i);
  });

  it("accepts background alone and asks alone, just not together", () => {
    expect(() =>
      createWorkflow({ name: "w1" })
        .then(createAgentStep({ name: "bg", output: outputSchema, background: true, prompt: () => "go" }))
        .commit(),
    ).not.toThrow();
    expect(() =>
      createWorkflow({ name: "w2" })
        .then(createAgentStep({ name: "qa", output: outputSchema, asks: true, prompt: () => "go" }))
        .commit(),
    ).not.toThrow();
  });
});

describe("background agent step (spec §2.2/§9.2, faked subagent seam offline)", () => {
  it("runs as a background request (no history, background flag threaded) and completes on a valid reply", async () => {
    const step = createAgentStep({ name: "bg", output: outputSchema, background: true, prompt: () => "go" });
    const workflow = createWorkflow({ name: "bg-ok" }).then(step).commit();
    const agent = scriptedAgent([[valid]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "ok" });
    expect(agent.backgrounds).toEqual([true]);
    expect(agent.histories).toEqual([undefined]);
    expect(agent.opened).toBe(1);

    const events = await store.loadEvents(result.runId);
    expect(steerEvents(events)).toHaveLength(0); // never steered — one-shot, no resumable conversation
  });

  it("never steers invalid output in-session — no agent-steer events even though the reply is bad", async () => {
    const step = createAgentStep({ name: "bg", output: outputSchema, background: true, maxOutputRepairs: 2, prompt: () => "go" });
    const workflow = createWorkflow({ name: "bg-invalid" }).then(step).commit();
    // Two invalid subagent runs: the first attempt and the one free repeat an unsteerable step gets.
    const agent = scriptedAgent([['{"summary":123}'], ['{"summary":123}']]); // schema violation
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(agent.opened).toBe(2); // a fresh SESSION per attempt…
    expect(agent.messages).toHaveLength(2); // …one turn each, never a correction inside one
    const events = await store.loadEvents(result.runId);
    expect(steerEvents(events)).toHaveLength(0); // maxOutputRepairs is ignored for background — no steering budget at all
  });

  it("repeats once by default, since a step that cannot be steered would otherwise die on one bad reply", async () => {
    // No `retry` declared: the default for an unsteerable step is one repeat (spec §9.1/§9.2), which is
    // the counterpart of the two in-session repairs a steerable step gets for free.
    const step = createAgentStep({ name: "bg", output: outputSchema, background: true, prompt: () => "go" });
    const workflow = createWorkflow({ name: "bg-default-retry" }).then(step).commit();
    const agent = scriptedAgent([['{"summary":123}'], [valid]]); // invalid, then good
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(agent.opened).toBe(2);
    const events = await store.loadEvents(result.runId);
    expect(events.filter((e) => e.type === "step-retry")).toHaveLength(1);
  });

  it("falls back to the repeat policy on invalid output: retries with a fresh subagent session and succeeds", async () => {
    const step = createAgentStep({ name: "bg", output: outputSchema, background: true, retry: { maxRetry: 1 }, prompt: () => "go" });
    const workflow = createWorkflow({ name: "bg-retry" }).then(step).commit();
    // First subagent invocation: invalid. Second (fresh, retried) invocation: valid.
    const agent = scriptedAgent([['{"summary":123}'], [valid]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(agent.opened).toBe(2); // a fresh, isolated subagent session per attempt
    expect(agent.backgrounds).toEqual([true, true]);

    const events = await store.loadEvents(result.runId);
    expect(steerEvents(events)).toHaveLength(0); // still never steered
    const retries = retryEvents(events);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ path: "bg", attempt: 1, reason: "invalid-output" });
  });

  it("crashes once the repeat policy is exhausted too", async () => {
    const step = createAgentStep({ name: "bg", output: outputSchema, background: true, retry: { maxRetry: 1 }, prompt: () => "go" });
    const workflow = createWorkflow({ name: "bg-retry-exhaust" }).then(step).commit();
    const agent = scriptedAgent([['{"summary":123}'], ['{"summary":456}']]); // both invalid
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(agent.opened).toBe(2);
    const events = await store.loadEvents(result.runId);
    expect(steerEvents(events)).toHaveLength(0);
    expect(retryEvents(events)).toHaveLength(1); // 2 attempts -> 1 retry
  });

  it("still retries a thrown transport error exactly like a non-background step", async () => {
    const step = createAgentStep({ name: "bg", output: outputSchema, background: true, retry: { maxRetry: 1 }, prompt: () => "go" });
    const workflow = createWorkflow({ name: "bg-transport" }).then(step).commit();
    const agent = scriptedAgent([[new Error("blip")], [valid]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    const events = await store.loadEvents(result.runId);
    expect(retryEvents(events)).toMatchObject([{ reason: "thrown-error" }]);
  });
});
