/**
 * B2 example: a Q&A-capable "planning" agent step (spec §10.1). It may ask a `{questions}`
 * batch (blocking the run), then — on the answers — emits a structured `{result}` plan.
 *
 * `createAgentStep({ asks: true })` produces a Q&A agent that fills `output`; the framework owns the
 * questionnaire schema and auto-injects the asking protocol, so the `prompt` is task-only.
 */

import { createAgentStep, createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

export const planSchema = Type.Object({
	steps: Type.Array(Type.String()),
	summary: Type.String(),
})

const plan = createAgentStep({
	name: "plan",
	output: planSchema,
	model: "kimchi-dev/kimi-k2.7",
	asks: true,
	prompt: () =>
		"Plan the software task: 'add a caching layer to the API'. Ask a clarifying question first only if something essential is ambiguous, then produce the plan.",
})

/** A trivial follow-up so the example demonstrates execution continuing past the Q&A step. */
const announce = createStep({
	name: "announce",
	input: planSchema,
	output: Type.Object({ message: Type.String() }),
	run: ({ input }) => ({ message: `Plan ready with ${input.steps.length} steps: ${input.summary}` }),
})

const planningWorkflow = createWorkflow({
	name: "planning",
	description: "Q&A-capable planning agent that may ask before planning (B2)",
})
	.then(plan)
	.then(announce)
	.commit()

export default planningWorkflow
