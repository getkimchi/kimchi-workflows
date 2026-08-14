/**
 * Overlay replaceable, provider-confirmed token usage onto an authoritative progress projection.
 *
 * Called only when event or usage state changes—not on animation frames—so live rendering does not
 * rebuild the tree merely because time passed. The event log remains untouched and final usage can
 * replace the preview without ever being counted twice.
 */
import type { ProgressNode, ProgressView } from "./types.ts"

/** Apply the latest cumulative usage for active turns, keyed by dynamic step path. */
export function withUsagePreviews(view: ProgressView, usageByPath: ReadonlyMap<string, number>): ProgressView {
	if (usageByPath.size === 0) return view

	const presentedNodes = view.nodes.map((node) => withNodeUsage(node, usageByPath))
	const previewTokens = presentedNodes.reduce((total, node) => total + node.previewTokens, 0)
	if (previewTokens === 0) return view

	return {
		...view,
		tokens: view.tokens + previewTokens,
		nodes: presentedNodes.map(({ node }) => node),
	}
}

interface PresentedNode {
	readonly node: ProgressNode
	/** Usage previews below this node, including its own when it is a step. */
	readonly previewTokens: number
}

function withNodeUsage(node: ProgressNode, usageByPath: ReadonlyMap<string, number>): PresentedNode {
	const presentedChildren = node.children.map((child) => withNodeUsage(child, usageByPath))
	const childPreviewTokens = presentedChildren.reduce((total, child) => total + child.previewTokens, 0)
	const ownPreviewTokens = node.kind === "step" ? positiveUsage(usageByPath.get(node.path)) : 0
	const previewTokens = ownPreviewTokens + childPreviewTokens

	return {
		previewTokens,
		node:
			previewTokens === 0
				? node
				: {
						...node,
						tokens: node.tokens + previewTokens,
						children: presentedChildren.map(({ node: child }) => child),
					},
	}
}

function positiveUsage(tokens: number | undefined): number {
	return tokens !== undefined && tokens > 0 ? tokens : 0
}
