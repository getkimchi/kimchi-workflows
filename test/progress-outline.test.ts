import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { createStep, createWorkflow } from "../src/flow/index.ts"
import { collapse } from "../src/progress/collapse.ts"
import { buildOutline, foreachItemChildren, foreachItemPath } from "../src/progress/outline.ts"
import type { OutlineNode, ProgressRow } from "../src/progress/types.ts"
import { branchRun, foreachRun, loopRun, nestedRun, parallelRun, sequenceRun, viewOf } from "./progress-fixtures.ts"

const step = (name: string) => createStep({ name, run: () => ({}) })

/** `kind path` per node, depth-first — the whole outline in one readable assertion. */
function flatten(nodes: readonly OutlineNode[], depth = 0): string[] {
	return nodes.flatMap((node) => [
		`${"  ".repeat(depth)}${node.kind} ${node.path}`,
		...flatten(node.children, depth + 1),
	])
}

/**
 * `buildOutline` is the static half of the projection (progress §1, §3.4) and the paths it produces are
 * the ONLY thing joining a row to the log. A path that no event can ever carry does not fail loudly —
 * the subtree simply reads `todo` for the life of the run — so every construct's addressing is pinned
 * here against the paths spec §8.5 actually emits.
 */
describe("buildOutline (progress §1, §3.4): static node paths", () => {
	it("a sequence is its steps in declaration order", () => {
		expect(flatten(buildOutline(sequenceRun().definition).nodes)).toEqual([
			"step analyze",
			"step plan",
			"step summarize",
		])
	})

	it("a loop body's paths carry NO iteration index (spec §5.4 drops it)", () => {
		expect(flatten(buildOutline(loopRun().definition).nodes)).toEqual([
			"step analyze",
			"loop until-green",
			"  step until-green/implement",
			"  step until-green/test",
			"  step until-green/review",
			"step summarize",
		])
	})

	it("branch arms are PEERS of the branch's own path, not nested under it (spec §8.5)", () => {
		// The engine emits `changelog/write-changelog`, never `gate/changelog/write-changelog` — getting
		// this backwards keys the whole arm against paths no event carries.
		expect(flatten(buildOutline(branchRun().definition).nodes)).toEqual([
			"branch gate",
			"  branch-arm needs-migration",
			"    step needs-migration/migrate",
			"  branch-arm changelog",
			"    step changelog/write-changelog",
		])
	})

	it("a parallel's arms DO nest under its own path (unlike a branch's)", () => {
		expect(flatten(buildOutline(parallelRun().definition).nodes)).toEqual([
			"step collect",
			"parallel checks",
			"  step checks/lint",
			"  step checks/types",
			"  step checks/tests",
		])
	})

	it("a nested workflow is a subtree under its own segment, not one opaque row (progress §3.5)", () => {
		expect(flatten(buildOutline(nestedRun().definition).nodes)).toEqual([
			"workflow audit",
			"  step audit/lint",
			"  step audit/types",
			"step publish",
		])
	})

	it("carries the declaration facts the panel cannot derive from the log: maxIterations, optional, attempts", () => {
		const workflow = createWorkflow({ name: "w" })
			.then(createStep({ name: "flaky", optional: true, retry: { maxRetry: 2 }, run: () => ({}) }))
			.dountil(createWorkflow({ name: "b" }).then(step("s")).commit(), () => true, { name: "spin", maxIterations: 9 })
			.commit()
		const [flaky, spin] = buildOutline(workflow).nodes

		expect(flaky?.optional).toBe(true)
		expect(flaky?.maxAttempts).toBe(3) // `maxRetry` counts attempts AFTER the first — the `retry 2/3` denominator
		expect(spin?.maxIterations).toBe(9)
	})
})

describe("foreach templates (progress §3.4): a body re-pathed per live item", () => {
	const foreach = buildOutline(foreachRun().definition).nodes[1] as OutlineNode

	it("the declared body is a template addressed by the foreach's bare name", () => {
		expect(foreach.path).toBe("review-each")
		expect(flatten(foreach.children)).toEqual(["step review-each/review"])
	})

	it("an item's path KEEPS its index (spec §5.4's exception) and re-paths the whole subtree", () => {
		const itemPath = foreachItemPath(foreach, 3)
		expect(itemPath).toBe("review-each@3")
		expect(flatten(foreachItemChildren(foreach, itemPath))).toEqual(["step review-each@3/review"])
	})

	it("re-paths a DEEP body, including a branch arm inside it (whose path is a peer of its branch's)", () => {
		const armBody = createWorkflow({ name: "urgent" }).then(step("escalate")).commit()
		const body = createWorkflow({ name: "item-body" })
			.then(createStep({ name: "classify", input: Type.String(), run: () => ({}) }))
			.branch([[() => true, armBody]], { name: "triage" })
			.commit()
		const workflow = createWorkflow({ name: "w" })
			.foreach(body, () => [], { name: "each" })
			.commit()
		const node = buildOutline(workflow).nodes[0] as OutlineNode

		expect(flatten(foreachItemChildren(node, foreachItemPath(node, 2)))).toEqual([
			"step each@2/classify",
			"branch each@2/triage",
			"  branch-arm each@2/urgent",
			"    step each@2/urgent/escalate",
		])
	})

	it("refuses a template whose descendant is not addressed under the foreach, rather than inventing a path", () => {
		const malformed: OutlineNode = {
			kind: "foreach",
			name: "each",
			path: "each",
			children: [{ kind: "step", name: "stray", path: "elsewhere/stray", children: [] }],
		}
		expect(() => foreachItemChildren(malformed, "each@0")).toThrow(/not addressed under foreach/)
	})
})

// -- collapse (progress §6) ----------------------------------------------------------------------------

/** `glyph-ish` per row: depth, whether it folded or unfolded, and its path — enough to pin every §6 rule. */
function shape(rows: readonly ProgressRow[]): string[] {
	return rows.map((row) => {
		const marker = row.collapsed ? "▸" : "▾"
		return `${"  ".repeat(row.depth)}${row.collapsed || row.expanded ? marker : "·"} ${row.node.path}`
	})
}

describe("collapse (progress §6): which rows are worth drawing", () => {
	it("§6.2 — the active path is fully expanded, together with the active node's siblings", () => {
		expect(shape(collapse(viewOf(loopRun())))).toEqual([
			"· analyze",
			"▾ until-green",
			"  · until-green/implement",
			"  · until-green/test",
			"  · until-green/review",
			"· summarize",
		])
	})

	it("§6.1 — a completed construct folds to a summary row and its body leaves the panel", () => {
		expect(shape(collapse(viewOf(nestedRun())))).toEqual(["▸ audit", "· publish"])
	})

	it("§6.3 — a construct that has not started is a single row with no body", () => {
		const body = createWorkflow({ name: "b" }).then(step("inner")).commit()
		const workflow = createWorkflow({ name: "w" })
			.then(step("first"))
			.dountil(body, () => true, { name: "later", maxIterations: 3 })
			.commit()
		const view = viewOf({ definition: workflow, events: [], nowMs: 0 })
		expect(shape(collapse(view))).toEqual(["· first", "· later"])
	})

	it("§6.3 — a skipped branch arm keeps its body hidden even though it is settled, not pending", () => {
		// The skip is recorded on the ARM (spec §5.1 does not walk into it), so its steps carry no
		// information at all — drawing them would fill the panel with work already decided against.
		expect(shape(collapse(viewOf(branchRun())))).toEqual([
			"▾ gate",
			"  · needs-migration",
			"  ▾ changelog",
			"    · changelog/write-changelog",
		])
	})

	it("guides describe every level, with the node's own continuation last (progress §4.3)", () => {
		const rows = collapse(viewOf(branchRun()))
		expect(rows.map((row) => row.guides)).toEqual([
			[], // gate — depth 0 draws no connector at all
			[true], // needs-migration: a sibling follows
			[false], // changelog: last arm
			[false, false], // write-changelog: under a last arm, itself last
		])
	})

	it("a foreach draws one row per LIVE item and none for items with no events yet (progress §3.3)", () => {
		expect(shape(collapse(viewOf(foreachRun())))).toEqual([
			"· collect-changes",
			"▾ review-each",
			"  · review-each@0",
			"  · review-each@1",
			"  · review-each@2",
		])
	})
})
