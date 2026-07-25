import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildCorrectionMessage } from "../src/engine/agent-output.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createAgentStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { scriptedAgent } from "./scripted-agent.ts";

const outputSchema = Type.Object({ summary: Type.String(), keywords: Type.Array(Type.String()) });
const valid = '{"summary":"ok","keywords":["k"]}';

function agentStepWith(overrides: { maxOutputRepairs?: number; retry?: { maxRetry: number } } = {}) {
  return createAgentStep({ name: "summarize", output: outputSchema, prompt: () => "Summarize.", ...overrides });
}

function steerEvents(events: RunEvent[]): Extract<RunEvent, { type: "agent-steer" }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: "agent-steer" }> => event.type === "agent-steer");
}

describe("output steering (Phase 4b, spec §9.2)", () => {
  it("corrects invalid output in the same session and completes after one repair", async () => {
    const workflow = createWorkflow({ name: "steer-ok" }).then(agentStepWith()).commit();
    const agent = scriptedAgent([['{"summary":"missing keywords"}', valid]]); // invalid, then valid
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "ok", keywords: ["k"] });
    expect(agent.opened).toBe(1); // same session reused (no fresh session)
    expect(agent.messages).toHaveLength(2); // original prompt + one correction
    expect(agent.disposed).toBe(1); // disposed exactly once at the end

    const steers = steerEvents(await store.loadEvents(result.runId));
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ path: "summarize", attempt: 1 });
    expect(steers[0]?.violation).toMatch(/keywords/);
  });

  it("crashes after exhausting the repair budget, emitting exactly maxOutputRepairs steers and no outer retry", async () => {
    const workflow = createWorkflow({ name: "steer-exhaust" })
      .then(agentStepWith({ maxOutputRepairs: 2 }))
      .commit();
    // Always invalid: first reply + 2 corrections = 3 replies, all bad.
    const agent = scriptedAgent([['{"summary":"x"}', '{"summary":"y"}', '{"summary":"z"}']]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/summarize/);
    expect(result.error).toMatch(/keywords/);
    expect(agent.opened).toBe(1); // NOT outer-retried with a fresh session
    expect(agent.messages).toHaveLength(3); // 1 prompt + 2 corrections
    expect(agent.disposed).toBe(1);

    const events = await store.loadEvents(result.runId);
    expect(steerEvents(events)).toHaveLength(2);
    expect(steerEvents(events).map((event) => event.attempt)).toEqual([1, 2]);
    expect(events.filter((event) => event.type === "step-retry")).toHaveLength(0); // steering != a fresh attempt
  });

  it("does not steer when maxOutputRepairs is 0 (immediate crash on invalid output)", async () => {
    const workflow = createWorkflow({ name: "steer-none" })
      .then(agentStepWith({ maxOutputRepairs: 0 }))
      .commit();
    const agent = scriptedAgent([['{"summary":"x"}']]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(agent.messages).toHaveLength(1); // only the first prompt, no correction
    expect(steerEvents(await store.loadEvents(result.runId))).toHaveLength(0);
  });

  it("steers unparseable (non-JSON) replies too, then completes", async () => {
    const workflow = createWorkflow({ name: "steer-nonjson" }).then(agentStepWith()).commit();
    const agent = scriptedAgent([["I cannot produce JSON, sorry.", valid]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    const steers = steerEvents(await store.loadEvents(result.runId));
    expect(steers).toHaveLength(1);
    expect(steers[0]?.violation).toMatch(/not valid JSON/);
  });

  it("falls back to the repeat policy once repairs are exhausted, when the step declares retry (spec §9.2/§9.3)", async () => {
    // Session 1: prompt + 1 repair, BOTH invalid -> repairs exhausted -> retryable -> outer retry starts
    // a FRESH session. Session 2 (a poisoned context could not fix itself, but a clean one can): valid
    // immediately. Carried-over item: today this crashed straight from "fatal" without ever consulting
    // maxRetry; the spec is explicit that only exhausted repairs make the attempt fail, and THEN the
    // repeat policy applies (§9.2's "Only when repairs are exhausted does the attempt fail and the
    // repeat policy apply").
    const step = agentStepWith({ maxOutputRepairs: 1, retry: { maxRetry: 1 } }); // 1 retry after the first = 2 total attempts
    const workflow = createWorkflow({ name: "steer-then-retry" }).then(step).commit();
    const agent = scriptedAgent([['{"summary":"x"}', '{"summary":"y"}'], [valid]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "ok", keywords: ["k"] });
    expect(agent.opened).toBe(2); // exhausted repairs -> a fresh session (outer retry), not an immediate crash

    const events = await store.loadEvents(result.runId);
    expect(steerEvents(events)).toHaveLength(1); // one repair attempted in session 1, then exhausted
    const retries = events.filter((event): event is Extract<RunEvent, { type: "step-retry" }> => event.type === "step-retry");
    expect(retries).toMatchObject([{ path: "summarize", attempt: 1, reason: "invalid-output" }]);
  });

  it("with the default maxRetry: 0, exhausted repairs still crash on the very next turn (behaviour unchanged for authors who set nothing)", async () => {
    const workflow = createWorkflow({ name: "steer-exhaust-default" })
      .then(agentStepWith({ maxOutputRepairs: 1 })) // no retry declared -> maxRetry defaults to 0
      .commit();
    const agent = scriptedAgent([['{"summary":"x"}', '{"summary":"y"}']]);
    const { host } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(agent.opened).toBe(1); // no outer retry: default maxRetry 0 means totalAttempts is 1
  });

  it("keeps steering (in-session) and transport-retry (fresh session) as independent budgets", async () => {
    // Session 1: throws (transport) -> outer retry. Session 2: invalid then valid -> one steer.
    const step = agentStepWith({ maxOutputRepairs: 2, retry: { maxRetry: 1 } }); // 1 retry after the first = 2 total attempts
    const workflow = createWorkflow({ name: "steer-and-retry" }).then(step).commit();
    const agent = scriptedAgent([[new Error("blip")], ['{"summary":"x"}', valid]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(agent.opened).toBe(2); // one fresh session from the transport retry
    const events = await store.loadEvents(result.runId);
    expect(events.filter((event) => event.type === "step-retry")).toHaveLength(1); // transport retry
    expect(steerEvents(events)).toHaveLength(1); // one in-session steer in session 2
  });

  describe("buildCorrectionMessage", () => {
    it("includes the violation text, the JSON Schema, and an ONLY-JSON instruction", () => {
      const message = buildCorrectionMessage(outputSchema, 'expected required property "keywords"');
      expect(message).toMatch(/expected required property "keywords"/); // the violation
      expect(message).toMatch(/ONLY a JSON value/i); // the instruction
      // The schema object itself is embedded (round-trips to the same schema).
      const schemaJson = message.slice(message.indexOf("{"));
      expect(JSON.parse(schemaJson)).toEqual(JSON.parse(JSON.stringify(outputSchema)));
    });
  });
});
