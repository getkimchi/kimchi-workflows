import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createAgentStep, createWorkflow, QuestionnaireSchema } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { createKimiAgentStarter, resolveKimiApiKey } from "./kimi-agent.ts";

/**
 * Real E2E for Q&A/parked (B2): a Q&A-capable planning input step (agent mode) instructed to ask a
 * clarifying questionnaire first, then plan after the answers. Proves park → answers (history replay)
 * → complete on real kimi-k2.7. Gated on KIMCHI_API_KEY; runs only via `npm run test:integration`.
 */
const apiKey = resolveKimiApiKey();

const planSchema = Type.Object({ steps: Type.Array(Type.String()) });

describe.skipIf(!apiKey)("planning Q&A E2E (kimchi-dev/kimi-k2.7)", () => {
  it("parks on a real questionnaire, then completes after the answers", async () => {
    if (!apiKey) throw new Error("unreachable: skipIf guards this");

    const plan = createAgentStep({
      name: "plan",
      output: planSchema,
      model: "kimchi-dev/kimi-k2.7",
      asks: true,
      prompt: () =>
        [
          "Task: add a caching layer to an HTTP API. You do not yet know which cache backend to use.",
          "You MUST first ask exactly ONE clarifying question about the cache backend before planning.",
        ].join("\n"),
    });
    const workflow = createWorkflow({ name: "planning-e2e" }).then(plan).commit();

    const { host, store } = createTestHost({ startAgent: createKimiAgentStarter(apiKey) });

    const parked = await runWorkflow(workflow, undefined, host);
    console.log("[integration] planning parked:", parked.status, "| questionnaire:", JSON.stringify(parked.questionnaire));
    expect(parked.status).toBe("parked");
    expect(Value.Check(QuestionnaireSchema, parked.questionnaire)).toBe(true);

    const firstKey = parked.questionnaire?.questions[0]?.key ?? "backend";
    const done = await resumeWithAnswer(workflow, await store.loadEvents(parked.runId), { [firstKey]: "Redis" }, host);
    console.log("[integration] planning completed:", done.status, "| plan:", JSON.stringify(done.output));
    expect(done.status).toBe("completed");
    expect(Value.Check(planSchema, done.output)).toBe(true);
    expect((done.output as { steps: string[] }).steps.length).toBeGreaterThan(0);
  });
});
