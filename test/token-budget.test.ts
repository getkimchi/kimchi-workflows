import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createAgentStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { scriptedAgent } from "./scripted-agent.ts";

const outputSchema = Type.Object({ ok: Type.Boolean() });
const validReply = (totalTokens: number) => ({ text: JSON.stringify({ ok: true }), totalTokens });

describe("token budget (Phase 7a, spec §9.3)", () => {
  it("exceeding maxTokens → budget-exceeded → crash (single attempt)", async () => {
    const step = createAgentStep({ name: "big", output: outputSchema, maxTokens: 100, prompt: () => "go" });
    const workflow = createWorkflow({ name: "token-crash" }).then(step).commit();
    const agent = scriptedAgent([[validReply(150)]]);
    const { host } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/big/);
    expect(result.error).toMatch(/100-token budget/);
    expect(result.error).toMatch(/used 150/);
  });

  it("counts budget-exceeded against the retry policy, resetting per fresh session, then crashes", async () => {
    const step = createAgentStep({ name: "big", output: outputSchema, maxTokens: 100, retry: { maxRetry: 1 }, prompt: () => "go" }); // 1 retry after the first = 2 total attempts
    const workflow = createWorkflow({ name: "token-retry" }).then(step).commit();
    const agent = scriptedAgent([[validReply(150)], [validReply(150)]]); // two fresh sessions
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(agent.opened).toBe(2); // fresh session per attempt (token count resets)
    const retries = (await store.loadEvents(result.runId)).filter((e): e is Extract<RunEvent, { type: "step-retry" }> => e.type === "step-retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ reason: "budget-exceeded" });
  });

  it("under budget → completes normally", async () => {
    const step = createAgentStep({ name: "small", output: outputSchema, maxTokens: 100, prompt: () => "go" });
    const workflow = createWorkflow({ name: "token-ok" }).then(step).commit();
    const agent = scriptedAgent([[validReply(50)]]);
    const { host } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ok: true });
  });

  it("accumulates usage across steering turns (prompt + steering)", async () => {
    const step = createAgentStep({ name: "steery", output: outputSchema, maxTokens: 100, prompt: () => "go" });
    const workflow = createWorkflow({ name: "token-steer" }).then(step).commit();
    // turn 1 (60 tokens) is invalid → steer; turn 2 (60 tokens) pushes the total to 120 > 100.
    const agent = scriptedAgent([[{ text: "not json", totalTokens: 60 }, validReply(60)]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/token budget/);
    expect(result.error).toMatch(/used 120/);
    const steers = (await store.loadEvents(result.runId)).filter((e) => e.type === "agent-steer");
    expect(steers).toHaveLength(1); // one steer happened before the budget tripped
  });

  it("carries accumulated tokens across a block/answer continuation of the SAME attempt (spec §9.4)", async () => {
    const step = createAgentStep({ name: "asker", output: outputSchema, asks: true, maxTokens: 100, prompt: () => "go" });
    const workflow = createWorkflow({ name: "token-continuation" }).then(step).commit();
    // Session 1 (fresh): asks, using 60 tokens — well within the 100 budget on its own.
    // Session 2 (answer continuation, same attempt): replies using 60 MORE tokens — 60 alone is fine,
    // but the CUMULATIVE total (120) must trip the budget, proving the count did not reset at the block.
    const questionnaire = { questions: [{ key: "x", header: "X", question: "X?", kind: "text" as const }] };
    const agent = scriptedAgent([[{ text: JSON.stringify({ questions: questionnaire }), totalTokens: 60 }], [{ text: JSON.stringify({ result: { ok: true } }), totalTokens: 60 }]]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const blocked = await runWorkflow(workflow, undefined, host);
    expect(blocked.status).toBe("blocked");

    const events = await store.loadEvents(blocked.runId);
    const asked = events.find((event): event is Extract<RunEvent, { type: "questionnaire-asked" }> => event.type === "questionnaire-asked");
    expect(asked?.tokensUsed).toBe(60); // recorded at the moment of blocking

    const result = await resumeWithAnswer(workflow, events, { x: "hi" }, host);

    expect(result.status).toBe("crashed");
    expect(result.error).toMatch(/token budget/);
    expect(result.error).toMatch(/used 120/); // 60 (before the block) + 60 (after) = 120, not a fresh 60
  });

  it("ignores usage entirely when no maxTokens is set", async () => {
    const step = createAgentStep({ name: "unbudgeted", output: outputSchema, prompt: () => "go" });
    const workflow = createWorkflow({ name: "no-budget" }).then(step).commit();
    const agent = scriptedAgent([[validReply(999_999)]]);
    const { host } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
  });
});
