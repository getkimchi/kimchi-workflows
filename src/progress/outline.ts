/**
 * The static tree (progress §1): a `WorkflowDefinition` turned into ordered outline nodes, each
 * carrying the STATIC node path (spec §5.4) its events will be keyed by. Known before the run starts.
 *
 * This exists as its own pass, ahead of any event, because **the panel must be able to draw a workflow
 * that has not run yet** — and, more importantly, one that is only PARTLY run. Deriving rows from the
 * log alone would show a run as a growing list of things that already happened, which is precisely the
 * information a user watching a live run already has; what they do not have is what is still to come.
 * So the outline is the frame and the log fills it in (progress §3.4: "the outline is a template, not
 * the truth" — branch arms are undecided, a foreach's length is unknown, iteration counts are unknown,
 * and none of it is invented here).
 *
 * The one subtlety is that VISUAL nesting and PATH nesting disagree for a branch: an arm is drawn as a
 * child of its branch, but its path is a PEER of the branch's own (spec §8.5 — `armName/stepName`, not
 * `branchName/armName/stepName`, which is what `execute.ts`'s `runBranchNode` emits). Getting that
 * backwards would key every arm and everything inside it against a path no event ever carries, and the
 * whole subtree would render `todo` for the life of the run. Every other construct nests both ways at
 * once: a parallel's arms, a loop/foreach body, and a nested workflow's nodes all sit under their
 * construct's own segment.
 *
 * Pure — no PI, no `node:fs`, no clock (progress §2.1).
 */
import { appendForeachItem, appendSegment, formatPath, type NodePath, parsePath } from "../engine/node-path.ts"
import type { StepDefinition, WorkflowDefinition, WorkflowNode } from "../flow/types.ts"
import type { Outline, OutlineNode } from "./types.ts"

/** Build a workflow's static tree (progress §1, §3.4). Total: every node kind has a case. */
export function buildOutline(definition: WorkflowDefinition): Outline {
	return { workflowName: definition.name, nodes: outlineNodes(definition.nodes, []) }
}

function outlineNodes(nodes: readonly WorkflowNode[], parent: NodePath): OutlineNode[] {
	return nodes.map((node) => outlineNode(node, parent))
}

function outlineNode(node: WorkflowNode, parent: NodePath): OutlineNode {
	switch (node.kind) {
		case "step":
			return stepNode(node.step, parent)
		case "branch": {
			// Arms are PEERS of the branch's own path (spec §8.5) — see the module header.
			const arms = node.arms.map((arm) => {
				const armPath = appendSegment(parent, arm.name)
				return {
					kind: "branch-arm" as const,
					name: arm.name,
					path: formatPath(armPath),
					children: outlineNodes(arm.body.nodes, armPath),
				}
			})
			return { kind: "branch", name: node.name, path: formatPath(appendSegment(parent, node.name)), children: arms }
		}
		case "loop": {
			const path = appendSegment(parent, node.name)
			// The body's paths carry NO iteration index: a loop's static key drops it (spec §5.4), so
			// iteration 7 overwrites iteration 6 in the same row and the loop row carries `↻ 7/10` instead
			// (progress §3.3). Nothing is lost and the tree stays bounded however long the loop runs.
			return {
				kind: "loop",
				name: node.name,
				path: formatPath(path),
				children: outlineNodes(node.body.nodes, path),
				maxIterations: node.maxIterations,
			}
		}
		case "foreach": {
			const path = appendSegment(parent, node.name)
			// A TEMPLATE: a foreach item's index IS kept in its static key (spec §5.4's exception), so these
			// children are re-pathed per live item by `foreachItemChildren` rather than used as they stand.
			return { kind: "foreach", name: node.name, path: formatPath(path), children: outlineNodes(node.body.nodes, path) }
		}
		case "parallel": {
			const path = appendSegment(parent, node.name)
			// A parallel's arms are bare `StepDefinition`s, not nodes, and they nest UNDER the parallel's own
			// segment (`parallelName/armName`) — unlike a branch's arms.
			return {
				kind: "parallel",
				name: node.name,
				path: formatPath(path),
				children: node.arms.map((arm) => stepNode(arm, path)),
			}
		}
		case "workflow": {
			const path = appendSegment(parent, node.name)
			// Rendered as a nested SUBTREE, not one opaque row (progress §3.5): its steps fold into the
			// parent log by design, so hiding them would discard information the log already carries.
			return {
				kind: "workflow",
				name: node.name,
				path: formatPath(path),
				children: outlineNodes(node.workflow.nodes, path),
			}
		}
	}
}

function stepNode(step: StepDefinition, parent: NodePath): OutlineNode {
	return {
		kind: "step",
		name: step.name,
		path: formatPath(appendSegment(parent, step.name)),
		children: [],
		optional: step.optional === true,
		// `retry.maxRetry` counts attempts AFTER the first (spec §9.1), so the badge's denominator is one more.
		maxAttempts: (step.retry?.maxRetry ?? 0) + 1,
	}
}

/**
 * The static path of one live foreach item (progress §3.4): the foreach's own path with its leaf
 * segment indexed — `review-each` + 3 → `review-each@3`. Built through the node-path grammar rather
 * than by string concatenation so the `@` separator stays declared in exactly one place (node-path.ts).
 */
export function foreachItemPath(foreach: OutlineNode, index: number): string {
	const path = parsePath(foreach.path)
	const leaf = path.at(-1)
	if (!leaf) throw new Error(`foreachItemPath: "${foreach.path}" has no leaf segment`)
	return formatPath(appendForeachItem(path.slice(0, -1), leaf.name, index))
}

/**
 * A foreach's body template re-pathed for one live item: every descendant's path gains the item's index
 * at the foreach's own segment (`review-each/review` → `review-each@3/review`).
 *
 * Prefix substitution is exact, not heuristic: every descendant of a foreach body — including a branch
 * arm inside it, whose path is a peer of its branch's but still sits under the foreach — is addressed
 * beneath the foreach's own segment, so `${foreach.path}/` is a genuine prefix of all of them. It is
 * asserted rather than assumed: a mismatch would silently produce a path no event can ever match, and
 * the item would render as an empty todo subtree with no indication anything was wrong.
 */
export function foreachItemChildren(foreach: OutlineNode, itemPath: string): OutlineNode[] {
	return foreach.children.map((child) => repath(child, foreach.path, itemPath))
}

function repath(node: OutlineNode, from: string, to: string): OutlineNode {
	if (!node.path.startsWith(`${from}/`)) {
		throw new Error(
			`progress outline: "${node.path}" is not addressed under foreach "${from}" (the body template is malformed)`,
		)
	}
	return {
		...node,
		path: `${to}${node.path.slice(from.length)}`,
		children: node.children.map((child) => repath(child, from, to)),
	}
}
