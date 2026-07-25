/**
 * Static isolation (spec §2.2, "Overlap implies isolation"): decide, from the workflow's SHAPE alone,
 * which agent steps can run concurrently with a sibling — every `.parallel` arm, and every step inside
 * a `.foreach` whose concurrency exceeds 1 (including nested arbitrarily deep: branch arms, loop
 * bodies, nested workflows, further foreach/parallel constructs — once isolated, a subtree STAYS
 * isolated all the way down; nesting a concurrency-1 foreach inside a concurrency-3 one does not undo
 * the outer overlap). Decided once, here, at `.commit()` — never re-derived at run time from whatever
 * happens to be in flight.
 *
 * This is also where `.commit()` enforces spec §10.1's "Q&A-capable agent steps may not overlap": an
 * isolated step runs as a one-shot PI subagent (same mechanism as `background`, spec §12.2) with no
 * conversation to resume an answer into, so `asks: true` on one is rejected right here, in the same
 * walk that discovers isolation — the two are the same fact checked at the same place. A
 * **questionnaire** step is deliberately exempt — its questions come from a schema, not a
 * conversation, so it may block anywhere, fan-out included (spec §8.6's several-blocked-at-once case
 * needs this).
 *
 * `resolveIsolation` returns a NEW node tree with every isolated agent step tagged `isolated: true`
 * (`AgentStep.isolated`) rather than mutating the input: a step or a sub-workflow's `body` can be the
 * SAME object composed into more than one place (see test/isolation.test.ts's "one shared step
 * definition, placed in two different workflows" case) — isolation is a property of WHERE a step sits
 * in THIS tree, so tagging must clone every node it touches, never write through a shared reference.
 * `.commit()` (create-workflow.ts) calls this once and uses its result as the committed `nodes`; the
 * engine (`execute.ts`) then just reads `step.isolated` — no runtime walk, no shape-path lookup.
 */
import type { StepDefinition, WorkflowDefinition, WorkflowNode } from "./types.ts";

/** Walk `nodes`, tag every isolated agent step, and reject `asks` wherever it overlaps (spec §2.2/§10.1). */
export function resolveIsolation(workflowName: string, nodes: readonly WorkflowNode[]): WorkflowNode[] {
  return walk(workflowName, nodes, false);
}

function walk(workflowName: string, nodes: readonly WorkflowNode[], isolatedHere: boolean): WorkflowNode[] {
  return nodes.map((node) => resolveNode(workflowName, node, isolatedHere));
}

function resolveNode(workflowName: string, node: WorkflowNode, isolatedHere: boolean): WorkflowNode {
  switch (node.kind) {
    case "step":
      return { kind: "step", step: resolveStep(workflowName, node.step, isolatedHere) };
    case "branch":
      return { ...node, arms: node.arms.map((arm) => ({ ...arm, body: resolveBody(workflowName, arm.body, isolatedHere) })) };
    case "loop":
      return { ...node, body: resolveBody(workflowName, node.body, isolatedHere) };
    case "foreach": {
      // Overlap implies isolation for the WHOLE body once concurrency exceeds 1, and once true an
      // inner construct's own (lower) concurrency can never turn it back off.
      const childIsolated = isolatedHere || node.concurrency > 1;
      return { ...node, body: resolveBody(workflowName, node.body, childIsolated) };
    }
    case "parallel":
      // Arms are bare steps (not sub-workflows, spec §3.5), always concurrent — isolated unconditionally.
      return { ...node, arms: node.arms.map((step) => resolveStep(workflowName, step, true)) };
    case "workflow":
      return { ...node, workflow: resolveBody(workflowName, node.workflow, isolatedHere) };
  }
}

function resolveBody(workflowName: string, body: WorkflowDefinition, isolatedHere: boolean): WorkflowDefinition {
  return { ...body, nodes: walk(workflowName, body.nodes, isolatedHere) };
}

function resolveStep(workflowName: string, step: StepDefinition, isolatedHere: boolean): StepDefinition {
  if (!isolatedHere || step.kind !== "agent") return step;
  if (step.asks) {
    throw new Error(
      `workflow "${workflowName}": agent step "${step.name}" declares asks but can overlap with a sibling — inside a .parallel arm, or a .foreach whose concurrency exceeds 1 (spec §2.2) — and an isolated step has no conversation to resume an answer into (spec §10.1); use a questionnaire step instead, or keep this step out of the fan-out`,
    );
  }
  return { ...step, isolated: true };
}
