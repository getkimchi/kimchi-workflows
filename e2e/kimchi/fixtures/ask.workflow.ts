import { createQuestionnaireStep, createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const answer = Type.Object({
	decision: Type.Union([Type.Literal("yes"), Type.Literal("no")], {
		title: "Decision",
		description: "Continue the workflow?",
	}),
})

const ask = createQuestionnaireStep({ name: "ask", output: answer })
const finish = createStep({
	name: "finish",
	input: answer,
	output: Type.Object({ decision: Type.String() }),
	run: ({ input }) => ({ decision: input.decision }),
})

export default createWorkflow({ name: "ask" }).then(ask).then(finish).commit()
