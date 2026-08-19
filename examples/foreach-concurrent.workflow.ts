/**
 * P3 example: `.foreach` with `concurrency > 1` (spec §3.4), offline-testable (no model).
 *
 * A seed step produces a list of numbers; the foreach body squares each one, up to 3 items
 * running at once (bounded further by the workflow's `maxConcurrency` ceiling, spec §3.6). The
 * node's output is the array of per-item outputs in ITEM order, regardless of completion order —
 * unlike `batch.workflow.ts`'s default `concurrency: 1`, this one genuinely overlaps.
 */

import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

export const itemSchema = Type.Object({ n: Type.Integer() })
export const squaredSchema = Type.Object({ squared: Type.Integer() })

const seed = createStep({
	name: "seed",
	output: Type.Object({ numbers: Type.Array(Type.Integer()) }),
	run: () => ({ numbers: [1, 2, 3, 4, 5] }),
})

const squareBody = createWorkflow({ name: "square-body" })
	.then(
		createStep({
			name: "square-item",
			input: itemSchema,
			output: squaredSchema,
			run: ({ input }) => ({ squared: input.n * input.n }),
		}),
	)
	.commit()

const foreachConcurrentWorkflow = createWorkflow({
	name: "foreach-concurrent",
	description: "Square each number, up to 3 items at once via .foreach concurrency (P3)",
})
	.then(seed)
	.foreach(squareBody, (ctx) => (ctx.getStepResult<{ numbers: number[] }>("seed")?.numbers ?? []).map((n) => ({ n })), {
		name: "square-each",
		concurrency: 3,
	})
	.commit()

export default foreachConcurrentWorkflow
