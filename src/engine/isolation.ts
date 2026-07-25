/**
 * Static isolation (spec §2.2, "Overlap implies isolation"): decide, from the workflow's SHAPE alone —
 * never from what happens to be in flight at runtime — which agent steps can run concurrently with
 * another agent step and therefore must be isolated exactly as a `background` step is (spec §12.2,
 * src/host/pi-agent.ts). A session hosts one conversation; two agent steps that CAN be mid-turn at the
 * same time can never safely share it, so this is decided once, from the definition, rather than
 * inferred from whichever steps happen to be executing when a given step starts.
 *
 * Two causes, matching spec §3.4/§3.5:
 *  - every arm of a `.parallel` is isolated — arms always run concurrently, unconditionally;
 *  - every step inside a `.foreach` body is isolated when that foreach's declared `concurrency` exceeds
 *    1 — INCLUDING steps nested arbitrarily deep inside it (branch arms, loop bodies, nested workflows,
 *    further foreach/parallel constructs): a sibling ITEM can be mid-turn in its own session regardless
 *    of how sequential that step's own local subtree is. Once a subtree is isolated it stays isolated
 *    all the way down — nesting a concurrency-1 foreach inside a concurrency-3 one does not undo the
 *    outer overlap.
 *
 * A `.foreach` at concurrency 1 (the default) is sequential — never isolated on its own account.
 *
 * Pure — no fs/PI/network, keeping this alongside the rest of the pure engine (spec §13.1).
 */
import type { WorkflowNode } from "../flow/types.ts";

/**
 * Every isolated agent step in `nodes`, keyed by its SHAPE path (node names only, no iteration/item
 * index — see `shapePathOf` in node-path.ts) so a lookup at run time — which only ever has a step's
 * live, indexed path — is a single Set membership check after stripping indices the same way.
 */
export function computeIsolatedAgentSteps(nodes: readonly WorkflowNode[]): ReadonlySet<string> {
  const isolated = new Set<string>();
  walk(nodes, [], false, isolated);
  return isolated;
}

function walk(nodes: readonly WorkflowNode[], parentNames: readonly string[], isolatedHere: boolean, into: Set<string>): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "step":
        if (isolatedHere && node.step.kind === "agent") into.add(shapeKey(parentNames, node.step.name));
        break;
      case "branch":
        for (const arm of node.arms) walk(arm.body.nodes, [...parentNames, arm.name], isolatedHere, into);
        break;
      case "loop":
        walk(node.body.nodes, [...parentNames, node.name], isolatedHere, into);
        break;
      case "foreach": {
        // Overlap implies isolation for the WHOLE body once concurrency exceeds 1 — and, once true,
        // an inner construct's own (lower) concurrency can never turn it back off.
        const childIsolated = isolatedHere || node.concurrency > 1;
        walk(node.body.nodes, [...parentNames, node.name], childIsolated, into);
        break;
      }
      case "parallel":
        // Arms are bare steps (not sub-workflows, spec §3.5), always concurrent — isolated unconditionally.
        for (const step of node.arms) {
          if (step.kind === "agent") into.add(shapeKey(parentNames, node.name, step.name));
        }
        break;
      case "workflow":
        walk(node.workflow.nodes, [...parentNames, node.name], isolatedHere, into);
        break;
    }
  }
}

/** Must match `shapePathOf`'s separator (node-path.ts) — the two sides of the same lookup. */
function shapeKey(parentNames: readonly string[], ...leaf: readonly string[]): string {
  return [...parentNames, ...leaf].join("/");
}
