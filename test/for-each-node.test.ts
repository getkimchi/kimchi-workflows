import { describe, expect, it } from "vitest";
import { collectNodeNames, forEachNode, nodeName, type StepDefinition, type WorkflowDefinition, type WorkflowNode } from "../src/flow/index.ts";

function step(name: string): WorkflowNode {
  const def: StepDefinition = { kind: "function", name, run: () => ({}) };
  return { kind: "step", step: def };
}

function body(name: string, ...nodes: WorkflowNode[]): WorkflowDefinition {
  return { name, nodes };
}

// A tree exercising every recursive shape: step, branch (2 arms), loop, foreach, nested workflow.
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
  { kind: "foreach", name: "fe", body: body("feb", step("f1")), selector: () => [] },
  { kind: "workflow", name: "nw", workflow: body("nw-wf", step("n1")) },
];

describe("forEachNode / collectNodeNames", () => {
  it("visits every node exactly once, pre-order, recursing into arms/bodies/nested workflows", () => {
    const visited: string[] = [];
    forEachNode(tree, (node) => visited.push(nodeName(node)));
    expect(visited).toEqual(["s0", "br", "a1", "b1", "lp", "l1", "fe", "f1", "nw", "n1"]);
    // exactly once each
    expect(new Set(visited).size).toBe(visited.length);
  });

  it("collectNodeNames returns the full recursive name set", () => {
    expect(collectNodeNames(tree)).toEqual(new Set(["s0", "br", "a1", "b1", "lp", "l1", "fe", "f1", "nw", "n1"]));
  });
});
