/**
 * B2 example: a questionnaire step gathers structured input up front (spec §2.4), then a
 * function step consumes it. The framework derives the questionnaire from the annotated `output`
 * schema; on answers, they are reassembled + validated into `output` — no LLM.
 */

import { createQuestionnaireStep, createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

export const answerSchema = Type.Object({
	name: Type.String({ title: "Name", description: "What is your name?" }),
	environment: Type.Union([Type.Literal("dev"), Type.Literal("prod")], {
		title: "Environment",
		description: "Which environment?",
		default: "dev",
	}),
})

const ask = createQuestionnaireStep({ name: "ask-params", output: answerSchema })

const greet = createStep({
	name: "greet",
	input: answerSchema,
	output: Type.Object({ message: Type.String() }),
	run: ({ input }) => ({ message: `Hello ${input.name}, deploying to ${input.environment}.` }),
})

const surveyWorkflow = createWorkflow({
	name: "survey",
	description: "Gather params via an input form, then greet (B2)",
})
	.then(ask)
	.then(greet)
	.commit()

export default surveyWorkflow
