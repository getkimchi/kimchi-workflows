import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { renderWorkflowPlan, type WorkflowPlan, workflowPlanSchema } from "../src/host/builtin/workflow-authoring.ts"

const plan: WorkflowPlan = {
	goal: "Review the current git diff and show actionable findings",
	summary: "Read the current diff, review it, and show findings immediately.",
	acceptanceCriteria: [
		"The current diff is reviewed",
		"Actionable findings are shown before the workflow records completion",
	],
	decisions: [
		"Use the current working tree without asking for a path",
		"Show Markdown in the conversation as soon as review finishes",
		"Do not modify reviewed files",
	],
	name: "review-current-diff",
	invocation: { requiresArguments: false },
	steps: [
		{
			title: "Read changes",
			purpose: "Collect the current working-tree diff",
			receives: [],
			produces: ["git diff"],
			delivers: [],
		},
		{
			title: "Review changes",
			purpose: "Find actionable correctness issues",
			receives: ["git diff"],
			produces: [],
			delivers: ["Markdown review findings in the conversation"],
		},
	],
}

const target = {
	entryPath: "/project/.kimchi/workflows/review-current-diff.workflow.ts",
}

describe("workflow creation behavior contract", () => {
	it("validates a compact behavior-level proposal", () => {
		expect(Value.Check(workflowPlanSchema, plan)).toBe(true)
	})

	it("renders decisions, information flow, mid-workflow delivery, and the simple command", () => {
		const markdown = renderWorkflowPlan(plan, target)

		expect(markdown).toContain("# Proposed workflow")
		expect(markdown).toContain("## Acceptance criteria")
		expect(markdown).toContain("Show Markdown in the conversation as soon as review finishes")
		expect(markdown).toContain("Receives: git diff")
		expect(markdown).toContain("Delivers here: Markdown review findings in the conversation")
		expect(markdown).toContain("`/workflow run review-current-diff`")
		expect(markdown).toContain(target.entryPath)
	})

	it("does not expose implementation blueprint concepts", () => {
		const markdown = renderWorkflowPlan(plan, target)

		for (const implementationDetail of [
			"TypeBox",
			"schema",
			"agent mode",
			"retry",
			"token budget",
			"timeout",
			"maxIterations",
			"concurrency",
		]) {
			expect(markdown.toLowerCase()).not.toContain(implementationDetail.toLowerCase())
		}
	})

	it("shows arguments only when the approved behavior explicitly requires them", () => {
		const markdown = renderWorkflowPlan(
			{
				...plan,
				invocation: { requiresArguments: true, reason: "The caller explicitly supplies a release id." },
			},
			target,
		)

		expect(markdown).toContain("`/workflow run review-current-diff --input …`")
		expect(markdown).toContain("The caller explicitly supplies a release id.")
	})
})
