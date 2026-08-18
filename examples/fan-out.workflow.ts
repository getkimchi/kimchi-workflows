/**
 * P3 example: `.parallel` structural fan-out over two independent function steps (spec §3.5),
 * offline-testable (no model).
 *
 * A seed step produces a sentence; `count-words` and `count-chars` both receive that SAME input
 * and run concurrently (bounded by the workflow's `maxConcurrency` ceiling, spec §3.6); the
 * node's output is an object keyed by arm name, independent of completion order.
 */

import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

export const sentenceSchema = Type.Object({ text: Type.String() })
export const wordCountSchema = Type.Object({ words: Type.Integer({ minimum: 0 }) })
export const charCountSchema = Type.Object({ chars: Type.Integer({ minimum: 0 }) })

const seed = createStep({
	name: "seed",
	output: sentenceSchema,
	run: () => ({ text: "hello concurrent workflow world" }),
})

const countWords = createStep({
	name: "count-words",
	input: sentenceSchema,
	output: wordCountSchema,
	run: ({ input }) => ({ words: input.text.split(/\s+/).filter(Boolean).length }),
})

const countChars = createStep({
	name: "count-chars",
	input: sentenceSchema,
	output: charCountSchema,
	run: ({ input }) => ({ chars: input.text.length }),
})

const fanOutWorkflow = createWorkflow({
	name: "fan-out",
	description: "Two independent steps run concurrently via .parallel (P3)",
})
	.then(seed)
	.parallel([countWords, countChars])
	.commit()

export default fanOutWorkflow
