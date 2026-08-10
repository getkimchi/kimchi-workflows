import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import {
	authoringSchemas,
	describeSourceConformance,
	renderAuthoringGuide,
	renderWorkflowScaffold,
	type WorkflowBlueprint,
} from "../src/host/builtin/workflow-authoring.ts"
import { loadWorkflowFile } from "../src/host/load-workflow.ts"
import { workflowsDir } from "../src/host/project-dir.ts"

const textSchema = {
	kind: "object" as const,
	fields: [{ name: "text", schema: { kind: "string" as const } }],
}
const itemSchema = {
	kind: "object" as const,
	fields: [{ name: "value", schema: { kind: "integer" as const } }],
}

const blueprint: WorkflowBlueprint = {
	name: "full-authoring-surface",
	description: "Exercise every deterministically rendered authoring construct",
	summary: "A generation fixture covering steps, mapping, control flow, fan-out, and nesting.",
	maxConcurrency: 4,
	schemas: [
		{ name: "text", schema: textSchema },
		{ name: "item", schema: itemSchema },
	],
	nodes: [
		{
			kind: "questionnaire",
			name: "ask",
			purpose: "collect initial text",
			output: "text",
			inputSource: "none",
		},
		{
			kind: "agent",
			name: "research",
			purpose: "research the requested topic",
			input: "text",
			output: "text",
			inputSource: "previous",
			mode: "report",
			background: true,
			maxTokens: 2_000,
			retry: { maxRetry: 1 },
		},
		{ kind: "map", name: "to-item", purpose: "convert research into one work item", sources: ["research"] },
		{
			kind: "loop",
			name: "until-reviewed",
			purpose: "repeat work until it passes review",
			mode: "dountil",
			maxIterations: 3,
			body: {
				name: "review-round",
				nodes: [{ kind: "agent", name: "review", purpose: "review the current result", mode: "act" }],
			},
		},
		{
			kind: "foreach",
			name: "each-item",
			purpose: "process every selected item",
			concurrency: 2,
			body: {
				name: "item-body",
				nodes: [
					{
						kind: "function",
						name: "process-item",
						purpose: "process one item",
						input: "item",
						output: "item",
						inputSource: "scope",
					},
				],
			},
		},
		{
			kind: "parallel",
			name: "checks",
			purpose: "run independent checks",
			arms: [
				{ kind: "function", name: "lint", purpose: "run lint" },
				{ kind: "function", name: "types", purpose: "run type checks" },
			],
		},
		{
			kind: "branch",
			name: "publish-choice",
			purpose: "publish when the checks pass",
			arms: [
				{
					purpose: "publish approved work",
					body: {
						name: "publish-arm",
						nodes: [{ kind: "function", name: "publish", purpose: "publish the result" }],
					},
				},
			],
		},
		{
			kind: "workflow",
			name: "finalize",
			purpose: "run final cleanup",
			body: {
				name: "finalize-body",
				nodes: [{ kind: "function", name: "cleanup", purpose: "clean temporary state", optional: true }],
			},
		},
	],
}

async function loadSource(source: string) {
	const root = await mkdtemp(path.join(tmpdir(), "workflow-authoring-"))
	const directory = workflowsDir(root)
	await mkdir(directory, { recursive: true })
	const file = path.join(directory, "fixture.workflow.ts")
	await writeFile(file, source, "utf8")
	return loadWorkflowFile(file)
}

describe("workflow creation authoring contract", () => {
	it("validates a recursive blueprint covering the public construct families", () => {
		expect(Value.Check(authoringSchemas.workflowBlueprint, blueprint)).toBe(true)
	})

	it("selects exact generated API documentation from the blueprint", () => {
		const guide = renderAuthoringGuide(blueprint)

		expect(guide).toContain("WorkflowBuilder.map(transform: MapFn")
		expect(guide).toContain("WorkflowBuilder.dountil(body: WorkflowDefinition")
		expect(guide).toContain("WorkflowBuilder.foreach(body: WorkflowDefinition")
		expect(guide).toContain("WorkflowBuilder.parallel(arms: readonly StepDefinition[]")
		expect(guide).toContain("WorkflowBuilder.branch(arms: readonly BranchArmSpec[]")
		expect(guide).toContain("WorkflowBuilder.workflow(subWorkflow: WorkflowDefinition")
		expect(guide).toContain("An acting agent omits `output`")
		expect(guide).toContain("```ts\ncreateAgentStep<")
	})

	it("renders a loadable scaffold for every construct and detects unfinished placeholders", async () => {
		const source = renderWorkflowScaffold(blueprint)
		const workflow = await loadSource(source)

		expect(workflow.name).toBe(blueprint.name)
		expect(describeSourceConformance(blueprint, source, workflow)).toMatch(/TODO_WORKFLOW/)

		const completedSource = source.replaceAll("TODO_WORKFLOW", "IMPLEMENTED_WORKFLOW")
		const completedWorkflow = await loadSource(completedSource)
		expect(describeSourceConformance(blueprint, completedSource, completedWorkflow)).toBeUndefined()
	})

	it("documents only capabilities used by a linear workflow", () => {
		const linear: WorkflowBlueprint = {
			name: "linear",
			description: "A linear workflow",
			summary: "One function step",
			schemas: [],
			nodes: [{ kind: "function", name: "run", purpose: "do the work" }],
		}
		const guide = renderAuthoringGuide(linear)

		expect(guide).toContain("### createStep")
		expect(guide).toContain("### createWorkflow")
		expect(guide).not.toContain("### WorkflowBuilder.foreach")
		expect(guide).not.toContain("### WorkflowBuilder.workflow")
	})
})
