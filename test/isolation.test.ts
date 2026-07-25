import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine/run-workflow.ts";
import { createAgentStep, createStep, createWorkflow } from "../src/flow/index.ts";
import type { StepDefinition, WorkflowNode } from "../src/flow/types.ts";
import { createTestHost } from "./helpers.ts";
import { scriptedAgent } from "./scripted-agent.ts";

/**
 * Static isolation (spec §2.2, "Overlap implies isolation"): an agent step that CAN run concurrently
 * with another — a `.parallel` arm, or a step inside a `.foreach` whose concurrency exceeds 1 — is
 * decided from the workflow's SHAPE alone, once, at `.commit()` (flow/isolation.ts), which tags the
 * step itself (`AgentStep.isolated`) rather than the engine re-deriving it at run time. These tests
 * prove the tagging both directly on the committed tree and end-to-end through `AgentRequest.isolated`
 * (via the scripted host double), matching this test task's own two headline cases:
 *   - a `.parallel` arm is isolated; the same step in a plain `.then` chain is not;
 *   - a `.foreach({concurrency: 3})` step is isolated; at concurrency 1 it is not.
 */

const okSchema = Type.Object({ ok: Type.Boolean() });
const okReply = JSON.stringify({ ok: true });

/** Find the step at a slash-joined SHAPE path (node names only) in a committed tree — test-only mirror of the addressing flow/isolation.ts itself walks. */
function findStep(nodes: readonly WorkflowNode[], path: string): StepDefinition | undefined {
  const [head, ...rest] = path.split("/");
  for (const node of nodes) {
    const found = findInNode(node, head as string, rest);
    if (found) return found;
  }
  return undefined;
}

/** One node's contribution to {@link findStep}: undefined means "not this node, keep looking". */
function findInNode(node: WorkflowNode, head: string, rest: readonly string[]): StepDefinition | undefined {
  switch (node.kind) {
    case "step":
      return rest.length === 0 && node.step.name === head ? node.step : undefined;
    case "branch": {
      const arm = node.arms.find((a) => a.name === head);
      return arm ? findStep(arm.body.nodes, rest.join("/")) : undefined;
    }
    case "loop":
    case "foreach":
      return node.name === head ? findStep(node.body.nodes, rest.join("/")) : undefined;
    case "parallel":
      return node.name === head ? node.arms.find((s) => s.name === rest[0]) : undefined;
    case "workflow":
      return node.name === head ? findStep(node.workflow.nodes, rest.join("/")) : undefined;
  }
}

function isIsolated(nodes: readonly WorkflowNode[], path: string): boolean {
  const step = findStep(nodes, path);
  return step?.kind === "agent" && step.isolated === true;
}

describe(".commit() tags isolated agent steps onto the committed tree (spec §2.2)", () => {
  it("a top-level .then() agent step is not isolated", () => {
    const step = createAgentStep({ name: "solo", output: okSchema, prompt: () => "go" });
    const workflow = createWorkflow({ name: "w" }).then(step).commit();
    expect(isIsolated(workflow.nodes, "solo")).toBe(false);
  });

  it("every arm of a .parallel is isolated, unconditionally", () => {
    const a = createAgentStep({ name: "a", output: okSchema, prompt: () => "go" });
    const b = createAgentStep({ name: "b", output: okSchema, prompt: () => "go" });
    const workflow = createWorkflow({ name: "w" }).parallel([a, b], { name: "par" }).commit();
    expect(isIsolated(workflow.nodes, "par/a")).toBe(true);
    expect(isIsolated(workflow.nodes, "par/b")).toBe(true);
  });

  it("a .foreach body step is isolated when concurrency exceeds 1", () => {
    const inner = createAgentStep({ name: "inner", output: okSchema, prompt: () => "go" });
    const body = createWorkflow({ name: "body" }).then(inner).commit();
    const workflow = createWorkflow({ name: "w" })
      .foreach(body, () => [1, 2, 3], { name: "batch", concurrency: 3 })
      .commit();
    expect(isIsolated(workflow.nodes, "batch/inner")).toBe(true);
  });

  it("a .foreach body step at concurrency 1 (the default) is NOT isolated", () => {
    const inner = createAgentStep({ name: "inner", output: okSchema, prompt: () => "go" });
    const body = createWorkflow({ name: "body" }).then(inner).commit();
    const workflow = createWorkflow({ name: "w" })
      .foreach(body, () => [1, 2, 3], { name: "batch" }) // default concurrency: 1
      .commit();
    expect(isIsolated(workflow.nodes, "batch/inner")).toBe(false);
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
    // (spec §8.5), which the tagging walk mirrors exactly like the engine's own addressing.
    expect(isIsolated(workflow.nodes, "batch/arm-body/deep")).toBe(true);
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

    expect(isIsolated(workflow.nodes, "batch/solo-item/inner")).toBe(true);
  });

  it("tags a CLONE, never the shared step object itself — composing the same step in two places must not cross-contaminate", () => {
    // One shared step definition, composed into two different workflows: a plain .then() chain (not
    // isolated) and a .parallel arm (isolated). If .commit() mutated the step in place instead of
    // cloning, whichever commit ran LAST would win and silently retag the other's copy too.
    const shared = createAgentStep({ name: "shared", output: okSchema, prompt: () => "go" });
    expect(shared.isolated).toBeUndefined();

    const fannedOut = createWorkflow({ name: "fanned-out" }).parallel([shared], { name: "par" }).commit();
    const sequenced = createWorkflow({ name: "sequenced" }).then(shared).commit();

    // The isolated commit produced its OWN tagged copy...
    expect(isIsolated(fannedOut.nodes, "par/shared")).toBe(true);
    // ...while the sequential commit's copy (built from the SAME `shared` reference) stays untagged...
    expect(isIsolated(sequenced.nodes, "shared")).toBe(false);
    // ...and the original object the author holds was never written through.
    expect(shared.isolated).toBeUndefined();
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
    // second turn from the SAME session — an isolated one must fail the attempt outright instead, and
    // then take its one default repeat as a wholly fresh session (four sessions, two per arm).
    const agent = scriptedAgent([['{"ok":"nope"}'], ['{"ok":"nope"}'], ['{"ok":"nope"}'], ['{"ok":"nope"}']]);
    const { host, store } = createTestHost({ startAgent: agent.startAgent });

    const result = await runWorkflow(workflow, undefined, host);

    expect(result.status).toBe("crashed");
    expect(agent.messages).toHaveLength(4); // one turn per attempt, no correction sent inside any of them
    const events = await store.loadEvents(result.runId);
    expect(events.some((e) => e.type === "agent-steer")).toBe(false);
  });
});
