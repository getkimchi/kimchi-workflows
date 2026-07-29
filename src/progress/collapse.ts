/**
 * Collapse (progress §6): the projected tree flattened into exactly the rows worth drawing.
 *
 * Three rules, and the reason each earns its lines:
 *
 *  - **A completed construct folds to one summary row** (§6.1). Its detail has stopped being
 *    actionable — nothing in it can change again — and it is not lost: the log holds it and
 *    `/workflow status` (§11.4) prints it in full. The panel shrinks exactly when it should.
 *  - **A construct that has not started is one `○` row** (§6.3). Expanding structure that may never run
 *    — an untaken branch arm above all — is noise dressed as information.
 *  - **Everything else stays expanded** (§6.2), which is what keeps the active path visible root to
 *    leaf, together with the siblings of whatever is running: the only region a user can act on, and
 *    so the only region that pays for its lines.
 *
 * There is no line budget (§6.5, deferred): a cap is a mechanism with a tuning problem attached, and
 * the three rules above keep a realistic run comfortably small without one.
 *
 * Pure — no PI, no `node:fs`, no clock (progress §2.1).
 */
import type { ProgressKind, ProgressNode, ProgressRow, ProgressView } from "./types.ts";

/** Kinds that are containers rather than units of work — the ones §6.1/§6.3 fold and unfold. */
const CONSTRUCTS: ReadonlySet<ProgressKind> = new Set<ProgressKind>(["branch", "branch-arm", "loop", "foreach", "foreach-item", "parallel", "workflow"]);

/** Flatten a view into the rows a render draws, applying progress §6.1–§6.3. */
export function collapse(view: ProgressView): ProgressRow[] {
  const rows: ProgressRow[] = [];
  emit(view.nodes, [], 0, rows);
  return rows;
}

function emit(nodes: readonly ProgressNode[], parentGuides: readonly boolean[], depth: number, rows: ProgressRow[]): void {
  nodes.forEach((node, index) => {
    const hasNextSibling = index < nodes.length - 1;
    // Depth 0 draws no connector at all, so it contributes no guide; every deeper level contributes
    // exactly one, and the node's own is always the last (progress §4.3).
    const guides = depth === 0 ? [] : [...parentGuides, hasNextSibling];
    const collapsed = isCollapsed(node);
    const expanded = !collapsed && isExpanded(node);
    rows.push({ node, depth, guides, collapsed, expanded });
    if (expanded) emit(node.children, guides, depth + 1, rows);
  });
}

/** Progress §6.1: a construct that finished folds to a summary row carrying its counters and cost. */
function isCollapsed(node: ProgressNode): boolean {
  return !isInlined(node) && CONSTRUCTS.has(node.kind) && node.children.length > 0 && node.state === "completed";
}

/**
 * A foreach item whose body is a single step IS that step's row (progress §3.6's
 * `✓ review · src/engine`), so it neither folds to a summary nor grows a child of its own — drawing
 * both would spend two lines saying one thing, on the construct most likely to have many of them.
 * The step still EXISTS in the projection, addressed at the path the engine emits; it is only this
 * row that stands in for it.
 */
function isInlined(node: ProgressNode): boolean {
  return node.kind === "foreach-item" && node.children.length === 1 && node.children[0]?.kind === "step";
}

/**
 * Progress §6.3: a construct renders its body only once it has been entered.
 *
 * `skipped` is excluded alongside `todo` deliberately — a branch arm whose condition was false is
 * settled, not pending, but its body never ran and never will, so its steps carry no information at all
 * (`deriveStepStates` records the skip on the ARM and does not walk into it, spec §5.1). Drawing them
 * would fill the panel with `todo` rows for work that is already decided against.
 */
function isExpanded(node: ProgressNode): boolean {
  return !isInlined(node) && node.children.length > 0 && node.state !== "todo" && node.state !== "skipped";
}
