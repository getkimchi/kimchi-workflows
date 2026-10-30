/**
 * Overlay live step activity onto an authoritative progress projection (inspection, specs/progress-ui.md
 * §14): each in-progress step's row carries its CURRENT tool call as one bounded hint, e.g.
 * `read · src/engine/step-runner.ts`.
 *
 * Called only when an activity event arrives — not on animation frames — so live rendering does not
 * rebuild the tree merely because time passed. The log is untouched, exactly as with usage previews
 * (`usage-preview.ts`), whose wrap-don't-mutate shape this mirrors.
 *
 * A hint reaches a row only while that row is `in_progress` AND is a step-shaped leaf (`step`, or a
 * `foreach-item` — both are keyed by the dynamic node path the activity channel publishes), which is
 * what makes a stale hint structurally impossible: the projection's own state is the gate, so a step
 * that settles takes its hint with it without anyone remembering to clear the map.
 */
import type { ProgressNode, ProgressView } from "./types.ts"

/** Apply the latest tool activity for active steps, keyed by dynamic step path. */
export function withActivity(view: ProgressView, hintByPath: ReadonlyMap<string, string>): ProgressView {
	if (hintByPath.size === 0) return view
	return { ...view, nodes: view.nodes.map((node) => withNode(node, hintByPath)) }
}

function withNode(node: ProgressNode, hintByPath: ReadonlyMap<string, string>): ProgressNode {
	const children = node.children.map((child) => withNode(child, hintByPath))
	const childrenChanged = children.some((child, index) => child !== node.children[index])
	// The hint key is the dynamic node path exactly as the activity channel records it — indices
	// included, so a fan-out's live items each carry their own.
	const hint =
		node.state === "in_progress" && (node.kind === "step" || node.kind === "foreach-item")
			? hintByPath.get(node.path)
			: undefined
	if (!childrenChanged && hint === undefined) return node
	return { ...node, ...(hint !== undefined ? { activityHint: hint } : {}), children }
}
