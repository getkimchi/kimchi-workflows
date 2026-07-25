import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createAgentStep, createWorkflow } from "../src/flow/index.ts";
import { createTestRun, raw, reply, usage } from "../src/testing/index.ts";
import { createTestHost } from "./helpers.ts";
import { scriptedAgent } from "./scripted-agent.ts";

const outputSchema = Type.Object({ verdict: Type.String() });

/**
 * The engine owns the output contract (spec §2.2/§9.2): a step's reply is parsed and validated against
 * its `outputSchema` whether or not the author remembered to describe it, so the framework states it —
 * exactly as it already did for `asks` steps and for steering corrections. A `background`/`isolated`
 * step has no repair budget at all, so an unstated expectation there costs the whole attempt.
 */
describe("output protocol injection", () => {
  it("appends the schema to a plain agent step's first message", async () => {
    const step = createAgentStep({ name: "judge", output: outputSchema, prompt: () => "Decide the thing." });
    const workflow = createWorkflow({ name: "protocol" }).then(step).commit();

    const run = await createTestRun(workflow, { agents: { judge: [reply({ verdict: "ok" })] } });

    expect(run.status).toBe("completed");
    const prompt = run.agent("judge").messages[0] as string;
    expect(prompt).toContain("Decide the thing."); // the author's prompt is untouched, and comes first
    expect(prompt.indexOf("Decide the thing.")).toBe(0);
    expect(prompt).toContain('"verdict"'); // …followed by the shape the engine will hold it to
    expect(prompt).toContain("INSTANCE of this JSON Schema");
  });

  it("does not double up on an `asks` step, whose asking protocol already carries the schema", async () => {
    const step = createAgentStep({ name: "elicit", output: outputSchema, asks: true, prompt: () => "Find out the thing." });
    const workflow = createWorkflow({ name: "asks-protocol" }).then(step).commit();

    const run = await createTestRun(workflow, { agents: { elicit: [reply({ verdict: "ok" })] } });

    expect(run.status).toBe("completed");
    const prompt = run.agent("elicit").messages[0] as string;
    expect(prompt).toContain("Find out the thing.");
    expect(prompt).toContain('"questions"'); // the asking protocol…
    expect(prompt).not.toContain("INSTANCE of this JSON Schema"); // …and not the plain one as well
  });

  it("is sent on a retry too, since a fresh attempt is a fresh session", async () => {
    const step = createAgentStep({ name: "judge", output: outputSchema, retry: { maxRetry: 1 }, prompt: () => "Decide." });
    const workflow = createWorkflow({ name: "retry-protocol" }).then(step).commit();

    const run = await createTestRun(workflow, {
      // First attempt: unparseable, and with no repair budget left it fails the attempt outright.
      agents: { judge: [raw("nope"), raw("still nope"), raw("nope again"), reply({ verdict: "ok" })] },
    });

    expect(run.status).toBe("completed");
    for (const message of run.agent("judge").messages.filter((m) => m.startsWith("Decide."))) {
      expect(message).toContain('"verdict"');
    }
  });
});

/**
 * Token usage per turn (spec §9.3). A run's cost is otherwise invisible: an isolated step is its own
 * one-shot subprocess, so nothing outside the engine — no session file, no single provider call — sees
 * what it spent.
 */
describe("agent-usage events", () => {
  it("records each turn's usage against the step's path", async () => {
    const step = createAgentStep({ name: "judge", output: outputSchema, prompt: () => "Decide." });
    const workflow = createWorkflow({ name: "usage" }).then(step).commit();

    const run = await createTestRun(workflow, { agents: { judge: [usage(reply({ verdict: "ok" }), 1234)] } });

    expect(run.status).toBe("completed");
    expect(run.eventsOf("agent-usage")).toEqual([expect.objectContaining({ path: "judge", totalTokens: 1234 })]);
  });

  it("emits one event per turn, so a steered step's cost sums rather than overwrites", async () => {
    const step = createAgentStep({ name: "judge", output: outputSchema, maxOutputRepairs: 2, prompt: () => "Decide." });
    const workflow = createWorkflow({ name: "usage-steer" }).then(step).commit();

    const run = await createTestRun(workflow, {
      agents: { judge: [usage(raw("not json"), 100), usage(reply({ verdict: "ok" }), 250)] },
    });

    expect(run.status).toBe("completed");
    const total = run.eventsOf("agent-usage").reduce((sum, event) => sum + event.totalTokens, 0);
    expect(total).toBe(350); // the failed turn is part of what the step cost
  });

  it("says nothing when the host reports no usage, rather than recording a zero", async () => {
    const { host, store } = createTestHost({ startAgent: scriptedAgent([[JSON.stringify({ verdict: "ok" })]]).startAgent });
    const step = createAgentStep({ name: "judge", output: outputSchema, prompt: () => "Decide." });
    const workflow = createWorkflow({ name: "usage-absent" }).then(step).commit();

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("completed");
    const events = await store.loadEvents(result.runId);
    expect(events.filter((event) => event.type === "agent-usage")).toHaveLength(0);
  });
});
