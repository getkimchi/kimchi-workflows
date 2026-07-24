import { describe, expect, it } from "vitest";
import { collectNodeNames, forEachNode, nodeName, type StepDefinition, type WorkflowDefinition, type WorkflowNode } from "../src/flow/index.ts";

function step(name: string): WorkflowNode {
  const def: StepDefinition = { kind: "function", name, run: () => ({}) };
  return { kind: "step", step: def };
}

function body(name: string, ...nodes: WorkflowNode[]): WorkflowDefinition {
  return { name, nodes, maxConcurrency: 4 };
}

// A tree exercising every recursive shape: step, branch (2 arms), loop, foreach, parallel, nested workflow.
const tree: WorkflowNode[] = [
  step("s0"),
  {
    kind: "branch",
    name: "br",
    arms: [
      { name: "arm-a", condition: () => true, body: body("arm-a", step("a1")) },
      { name: "arm-b", condition: () => false, body: body("arm-b", step("b1")) },
    ],
  },
  { kind: "loop", name: "lp", mode: "dowhile", body: body("lb", step("l1")), condition: () => false, maxIterations: 1 },
  { kind: "foreach", name: "fe", body: body("feb", step("f1")), selector: () => [], concurrency: 1 },
  { kind: "parallel", name: "pa", arms: [{ kind: "function", name: "p1", run: () => ({}) } as const, { kind: "function", name: "p2", run: () => ({}) } as const] },
  { kind: "workflow", name: "nw", workflow: body("nw-wf", step("n1")) },
];

describe("forEachNode / collectNodeNames", () => {
  it("visits every node exactly once, pre-order, recursing into arms/bodies/parallel arms/nested workflows", () => {
    const visited: string[] = [];
    forEachNode(tree, (node) => visited.push(nodeName(node)));
    expect(visited).toEqual(["s0", "br", "a1", "b1", "lp", "l1", "fe", "f1", "pa", "p1", "p2", "nw", "n1"]);
    // exactly once each
    expect(new Set(visited).size).toBe(visited.length);
  });

  it("collectNodeNames returns the full recursive name set", () => {
    expect(collectNodeNames(tree)).toEqual(new Set(["s0", "br", "a1", "b1", "lp", "l1", "fe", "f1", "pa", "p1", "p2", "nw", "n1"]));
  });
});
