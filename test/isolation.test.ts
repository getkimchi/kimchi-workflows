import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { computeIsolatedAgentSteps } from "../src/engine/isolation.ts";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts";
import { createTestHost } from "./helpers.ts";
import { scriptedAgent } from "./scripted-agent.ts";

/**
 * Static isolation (spec §2.2, "Overlap implies isolation"): an agent step that CAN run concurrently
 * with another — a `.parallel` arm, or a step inside a `.foreach` whose concurrency exceeds 1 — must be
 * decided from the workflow's SHAPE alone, not from what happens to be in flight. These tests prove the
 * decision both at the pure `computeIsolatedAgentSteps` level and end-to-end through `AgentRequest`
 * (via the scripted host double), matching this test task's own two headline cases:
 *   - a `.parallel` arm is isolated; the same step in a plain `.then` chain is not;
 *   - a `.foreach({concurrency: 3})` step is isolated; at concurrency 1 it is not.
 */

const okSchema = Type.Object({ ok: Type.Boolean() });
const okReply = JSON.stringify({ ok: true });

describe("computeIsolatedAgentSteps (pure, spec §2.2)", () => {
  it("a top-level .then() agent step is not isolated", () => {
    const step = createAgentStep({ name: "solo", output: okSchema, prompt: () => "go" });
    const workflow = createWorkflow({ name: "w" }).then(step).commit();
    expect(computeIsolatedAgentSteps(workflow.nodes)).toEqual(new Set());
  });

  it("every arm of a .parallel is isolated, unconditionally", () => {
    const a = createAgentStep({ name: "a", output: okSchema, prompt: () => "go" });
    const b = createAgentStep({ name: "b", output: okSchema, prompt: () => "go" });
    const workflow = createWorkflow({ name: "w" }).parallel([a, b], { name: "par" }).commit();
    expect(computeIsolatedAgentSteps(workflow.nodes)).toEqual(new Set(["par/a", "par/b"]));
  });

  it("a .foreach body step is isolated when concurrency exceeds 1", () => {
    const inner = createAgentStep({ name: "inner", output: okSchema, prompt: () => "go" });
    const body = createWorkflow({ name: "body" }).then(inner).commit();
    const workflow = createWorkflow({ name: "w" })
      .foreach(body, () => [1, 2, 3], { name: "batch", concurrency: 3 })
      .commit();
    expect(computeIsolatedAgentSteps(workflow.nodes)).toEqual(new Set(["batch/inner"]));
  });

  it("a .foreach body step at concurrency 1 (the default) is NOT isolated", () => {
    const inner = createAgentStep({ name: "inner", output: okSchema, prompt: () => "go" });
    const body = createWorkflow({ name: "body" }).then(inner).commit();
    const workflow = createWorkflow({ name: "w" })
      .foreach(body, () => [1, 2, 3], { name: "batch" }) // default concurrency: 1
      .commit();
    expect(computeIsolatedAgentSteps(workflow.nodes)).toEqual(new Set());
  });

  it("isolation propagates through nested branch/loop/workflow constructs inside an isolated foreach", () => {
    const deep = createAgentStep({ name: "deep", output: okSchema, prompt: () => "go" });
    const armBody = createWorkflow({ name: "arm-body" }).then(deep).commit();
    const pick = createStep({ name: "pick", output: Type.Object({ go: Type.Boolean() }), run: () => ({ go: true }) });
    const body = createWorkflow({ name: "body" })
      .then(pick)
      .branch([[(ctx) => ctx.getStepResult<{ go: boolean }>("pick")?.go === true, armBody]], { name: "inner-branch" })
      .commit();
    const workflow = createWorkflow({ name: "w" })
      .foreach(body, () => [1, 2], { name: "batch", concurrency: 2 })
      .commit();

    // `deep` sits under batch/arm-body/deep — a branch arm is a PEER scope of the branch's own name
    // (spec §8.5), which `computeIsolatedAgentSteps` mirrors exactly like the engine's own addressing.
    expect(computeIsolatedAgentSteps(workflow.nodes)).toEqual(new Set(["batch/arm-body/deep"]));
  });

  it("once isolated, an inner concurrency-1 foreach does not undo the outer overlap", () => {
    const inner = createAgentStep({ name: "inner", output: okSchema, prompt: () => "go" });
    const innerBody = createWorkflow({ name: "inner-body" }).then(inner).commit();
    const outerBody = createWorkflow({ name: "outer-body" })
      .foreach(innerBody, () => [1], { name: "solo-item" }) // concurrency 1 on its own
      .commit();
    const workflow = createWorkflow({ name: "w" })
      .foreach(outerBody, () => [1, 2, 3], { name: "batch", concurrency: 3 })
      .commit();

    expect(computeIsolatedAgentSteps(workflow.nodes)).toEqual(new Set(["batch/solo-item/inner"]));
  });
});

describe("static isolation end-to-end (spec §2.2): AgentRequest.isolated threaded through the engine", () => {
  it("a .parallel arm is isolated; the SAME step definition in a plain .then chain is not", async () => {
    // One shared step definition, placed in two different workflows — proves isolation is a property of
    // WHERE the step sits, not anything about the step itself.
    const step = createAgentStep({ name: "same-step", output: okSchema, prompt: () => "go" });

    const sequenced = createWorkflow({ name: "sequenced" }).then(step).commit();
    const sequencedAgent = scriptedAgent([[okReply]]);
    const { host: sequencedHost } = createTestHost({ startAgent: sequencedAgent.startAgent });
    expect((await runWorkflow(sequenced, undefined, sequencedHost)).status).toBe("completed");
    expect(sequencedAgent.isolateds).toEqual([false]);

    const fannedOut = createWorkflow({ name: "fanned-out" }).parallel([step], { name: "par" }).commit();
    const fannedAgent = scriptedAgent([[okReply]]);
    const { host: fannedHost } = createTestHost({ startAgent: fannedAgent.startAgent });
    expect((await runWorkflow(fannedOut, undefined, fannedHost)).status).toBe("completed");
    expect(fannedAgent.isolateds).toEqual([true]);
  });

  it(".foreach({concurrency: 3}) isolates its agent step; concurrency 1 does not", async () => {
    const inner = createAgentStep({ name: "inner", output: okSchema, prompt: () => "go" });
    const body = createWorkflow({ name: "item-body" }).then(inner).commit();

    const concurrentWorkflow = createWorkflow({ name: "concurrent" })
      .foreach(body, () => [1, 2], { name: "batch", concurrency: 3 })
      .commit();
    const concurrentAgent = scriptedAgent([[okReply], [okReply]]);
    const { host: concurrentHost } = createTestHost({ startAgent: concurrentAgent.startAgent });
    const concurrentResult = await runWorkflow(concurrentWorkflow, undefined, concurrentHost);
    expect(concurrentResult.status).toBe("completed");
    expect(concurrentAgent.isolateds).toEqual([true, true]);

    const sequentialWorkflow = createWorkflow({ name: "sequential" })
      .foreach(body, () => [1, 2], { name: "batch" }) // default concurrency: 1
      .commit();
    const sequentialAgent = scriptedAgent([[okReply], [okReply]]);
    const { host: sequentialHost } = createTestHost({ startAgent: sequentialAgent.startAgent });
    const sequentialResult = await runWorkflow(sequentialWorkflow, undefined, sequentialHost);
    expect(sequentialResult.status).toBe("completed");
    expect(sequentialAgent.isolateds).toEqual([false, false]);
  });

  it("an isolated step's repair budget is forced to 0, same as background (spec §9.2)", async () => {
    const a = createAgentStep({ name: "a", output: okSchema, maxOutputRepairs: 2, prompt: () => "go" });
    const b = createAgentStep({ name: "b", output: okSchema, maxOutputRepairs: 2, prompt: () => "go" });
    const workflow = createWorkflow({ name: "w" }).parallel([a, b], { name: "par" }).commit();

    // Both arms reply with schema-invalid output; a steerable step would send a correction and get a
    // second turn from the SAME session — an isolated one must fail the attempt outright instead.
    const agent = scriptedAgent([['{"ok":"nope"}'], ['{"ok":"nope"}']]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(agent.messages).toHaveLength(2); // one turn per arm, no correction sent to either
    const events = await store.loadEvents(result.runId);
    expect(events.some((e) => e.type === "agent-steer")).toBe(false);
  });
});
