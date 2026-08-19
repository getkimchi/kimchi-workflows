/**
 * Phase 4a example: a single agent step that summarizes text into a structured object.
 *
 * Run it: `/workflow run examples/summarize.workflow.ts` inside the kimchi harness (the agent step
 * runs on the session model, or `kimchi-dev/kimi-k2.7` when set as the default). The step submits its
 * result by calling `workflow_submit_result`, and the engine validates that payload against `output`.
 */

import { createAgentStep, createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

export const summarySchema = Type.Object({
	summary: Type.String(),
	keywords: Type.Array(Type.String()),
})

const sampleText = createStep({
	name: "sample-text",
	output: Type.Object({ text: Type.String() }),
	run: () => ({
		text: "TypeBox is a runtime type system for TypeScript. It builds JSON Schema objects whose static types are inferred, so the same schema validates data at runtime and types it at compile time.",
	}),
})

const summarize = createAgentStep({
	name: "summarize",
	input: Type.Object({ text: Type.String() }),
	output: summarySchema,
	model: "kimchi-dev/kimi-k2.7",
	prompt: ({ input }) => ["Summarize the text below.", "", input.text].join("\n"),
})

const summarizeWorkflow = createWorkflow({
	name: "summarize",
	description: "Summarize text into a structured object (Phase 4a agent step)",
})
	.then(sampleText)
	.then(summarize)
	.commit()

export default summarizeWorkflow
