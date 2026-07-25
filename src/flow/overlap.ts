/**
 * Q&A-capable agent steps may not overlap (spec §10.1, the "Q&A-capable agent steps may not overlap"
 * paragraph): `asks: true` inside a `.parallel` arm, or inside a `.foreach` whose concurrency exceeds
 * 1, is rejected at `.commit()` (create-workflow.ts) — the same underlying reason as `background` +
 * `asks` (also checked there): an overlapping step is isolated (spec §2.2), and an isolated step has
 * no conversation to resume an answer into. A **questionnaire** step is deliberately NOT checked here
 * — its questions come from a schema, not a conversation, so it may block anywhere, fan-out included
 * (that asymmetry is what keeps spec §8.6's several-blocked-at-once case real).
 *
 * This needs a context-aware walk — whether a step CAN overlap depends on every construct it is nested
 * inside, not the step alone — unlike the flat, ancestor-blind `forEachNode` visitor `create-workflow.ts`
 * uses for its other `.commit()` checks. It is the SAME overlap propagation `computeIsolatedAgentSteps`
 * computes at run time (src/engine/isolation.ts): every `.parallel` arm is isolated unconditionally;
 * every step inside a `.foreach` body is isolated once concurrency exceeds 1, and STAYS isolated through
 * nested branch/loop/foreach/workflow constructs (nesting a concurrency-1 foreach inside a concurrency-3
 * one does not undo the outer overlap).
 *
 * Duplicated rather than imported: `src/flow` is the pure authoring layer `src/engine` depends on, never
 * the reverse (see `isValidNodeName` in create-workflow.ts for the same constraint/pattern). Kept in its
 * own file, rather than inlined in create-workflow.ts, purely to keep that file's size in check — split
 * out, not because the walk depends on anything create-workflow.ts-specific. Keep the two walks (this
 * one and engine/isolation.ts's) in sync if either changes.
 */
import type { StepDefinition, WorkflowNode } from "./types.ts";

export function assertNoOverlappingAsks(workflowName: string, nodes: readonly WorkflowNode[]): void {
  walkForOverlappingAsks(workflowName, nodes, false);
}

function walkForOverlappingAsks(workflowName: string, nodes: readonly WorkflowNode[], isolatedHere: boolean): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "step":
        rejectIfOverlappingAsks(workflowName, node.step, isolatedHere);
        break;
      case "branch":
        for (const arm of node.arms) walkForOverlappingAsks(workflowName, arm.body.nodes, isolatedHere);
        break;
      case "loop":
        walkForOverlappingAsks(workflowName, node.body.nodes, isolatedHere);
        break;
      case "foreach":
        // Overlap implies isolation for the WHOLE body once concurrency exceeds 1, and once true an
        // inner construct's own (lower) concurrency can never turn it back off.
        walkForOverlappingAsks(workflowName, node.body.nodes, isolatedHere || node.concurrency > 1);
        break;
      case "parallel":
        // Arms are bare steps (not sub-workflows, spec §3.5), always concurrent — isolated unconditionally.
        for (const step of node.arms) rejectIfOverlappingAsks(workflowName, step, true);
        break;
      case "workflow":
        walkForOverlappingAsks(workflowName, node.workflow.nodes, isolatedHere);
        break;
    }
  }
}

function rejectIfOverlappingAsks(workflowName: string, step: StepDefinition, isolatedHere: boolean): void {
  if (!isolatedHere || step.kind !== "agent" || !step.asks) return;
  throw new Error(
    `workflow "${workflowName}": agent step "${step.name}" declares asks but can overlap with a sibling — inside a .parallel arm, or a .foreach whose concurrency exceeds 1 (spec §2.2) — and an isolated step has no conversation to resume an answer into (spec §10.1); use a questionnaire step instead, or keep this step out of the fan-out`,
  );
}
