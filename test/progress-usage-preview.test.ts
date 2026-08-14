import { describe, expect, it } from "vitest"
import type { ProgressNode } from "../src/progress/types.ts"
import { withUsagePreviews } from "../src/progress/usage-preview.ts"
import { parallelRun, sequenceRun, viewOf } from "./progress-fixtures.ts"

function nodeAt(nodes: readonly ProgressNode[], path: string): ProgressNode {
	for (const node of nodes) {
		if (node.path === path) return node
		const nested = findNode(node.children, path)
		if (nested) return nested
	}
	throw new Error(`test fixture has no progress node at ${path}`)
}

function findNode(nodes: readonly ProgressNode[], path: string): ProgressNode | undefined {
	for (const node of nodes) {
		if (node.path === path) return node
		const nested = findNode(node.children, path)
		if (nested) return nested
	}
	return undefined
}

describe("progress usage previews", () => {
	it("adds the latest preview once per active path and rolls parallel previews up", () => {
		const base = viewOf(parallelRun())
		const shown = withUsagePreviews(
			base,
			new Map([
				["checks/types", 100],
				["checks/tests", 240],
			]),
		)

		expect(base.tokens).toBe(12_400)
		expect(shown.tokens).toBe(12_740)
		expect(nodeAt(shown.nodes, "checks/types").tokens).toBe(100)
		expect(nodeAt(shown.nodes, "checks/tests").tokens).toBe(12_640)
		expect(nodeAt(shown.nodes, "checks").tokens).toBe(12_740)
	})

	it("returns the authoritative view unchanged when no preview maps to its tree", () => {
		const base = viewOf(sequenceRun())

		expect(withUsagePreviews(base, new Map())).toBe(base)
		expect(
			withUsagePreviews(
				base,
				new Map([
					["plan", 0],
					["not-in-this-run", 999],
				]),
			),
		).toBe(base)
	})
})
