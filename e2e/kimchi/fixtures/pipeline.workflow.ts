import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const seed = createStep({
	name: "seed",
	output: Type.Object({ items: Type.Array(Type.String()) }),
	run: () => ({ items: ["a", "b", "c"] }),
})

const body = createWorkflow({ name: "uppercase-body" })
	.then(
		createStep({
			name: "uppercase",
			input: Type.String(),
			output: Type.String(),
			run: ({ input }) => input.toUpperCase(),
		}),
	)
	.commit()

const summaryInput = Type.Object({ values: Type.Array(Type.String()), originalCount: Type.Integer() })
const summarize = createStep({
	name: "summarize",
	input: summaryInput,
	output: Type.Object({ summary: Type.String() }),
	run: ({ input }) => ({ summary: `${input.values.join(",")}|${input.originalCount}` }),
})

export default createWorkflow({ name: "pipeline", maxConcurrency: 3 })
	.then(seed)
	.foreach(body, (ctx) => ctx.getStepResult<{ items: string[] }>("seed")?.items ?? [], {
		name: "process-each",
		concurrency: 3,
	})
	.map(
		(ctx) => ({
			values: ctx.getStepResult<string[]>("process-each") ?? [],
			originalCount: ctx.getStepResult<{ items: string[] }>("seed")?.items.length ?? 0,
		}),
		{ name: "combine" },
	)
	.then(summarize)
	.commit()
