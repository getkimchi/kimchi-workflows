import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { createAgentStep, createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"

/**
 * spec §10.1, "Q&A-capable agent steps may not overlap": `asks: true` inside a `.parallel` arm, or
 * inside a `.foreach` whose concurrency exceeds 1, is rejected at `.commit()` — the same underlying
 * reason as `background` + `asks` (test/background-step.test.ts): an overlapping step is isolated
 * (spec §2.2), and an isolated step has no conversation to resume an answer into. A questionnaire step
 * is unaffected — it may block anywhere, fan-out included, since its questions come from a schema
 * rather than a conversation.
 */

const outputSchema = Type.Object({ summary: Type.String() })
const askingStep = (name: string) => createAgentStep({ name, output: outputSchema, asks: true, prompt: () => "go" })

describe(".commit() rejects asks inside an overlapping construct (spec §10.1)", () => {
	it("rejects asks as one of several .parallel() arms", () => {
		expect(() =>
			createWorkflow({ name: "w" })
				.parallel([createAgentStep({ name: "ok", output: outputSchema, prompt: () => "go" }), askingStep("bad")], {
					name: "par",
				})
				.commit(),
		).toThrow(/"bad".*asks|overlap/i)
	})

	it("rejects asks inside a .foreach whose concurrency exceeds 1", () => {
		const body = createWorkflow({ name: "body" }).then(askingStep("bad")).commit()
		expect(() =>
			createWorkflow({ name: "w" })
				.foreach(body, () => [1, 2, 3], { name: "batch", concurrency: 3 })
				.commit(),
		).toThrow(/"bad".*asks|overlap/i)
	})

	it("rejects a nested case: asks buried inside a branch arm inside a concurrency>1 foreach", () => {
		const pick = createStep({ name: "pick", output: Type.Object({ go: Type.Boolean() }), run: () => ({ go: true }) })
		const armBody = createWorkflow({ name: "arm-body" }).then(askingStep("deep")).commit()
		const body = createWorkflow({ name: "body" })
			.then(pick)
			.branch([[(ctx) => ctx.getStepResult<{ go: boolean }>("pick")?.go === true, armBody]], { name: "inner-branch" })
			.commit()
		expect(() =>
			createWorkflow({ name: "w" })
				.foreach(body, () => [1, 2], { name: "batch", concurrency: 2 })
				.commit(),
		).toThrow(/"deep".*asks|overlap/i)
	})

	it("rejects when overlap arrives through an OUTER concurrency>1 foreach even if an inner foreach is concurrency 1", () => {
		const innerBody = createWorkflow({ name: "inner-body" }).then(askingStep("deep")).commit()
		const outerBody = createWorkflow({ name: "outer-body" })
			.foreach(innerBody, () => [1], { name: "solo-item" }) // concurrency 1 on its own — does not undo the outer overlap
			.commit()
		expect(() =>
			createWorkflow({ name: "w" })
				.foreach(outerBody, () => [1, 2, 3], { name: "batch", concurrency: 3 })
				.commit(),
		).toThrow(/"deep".*asks|overlap/i)
	})
})

describe(".commit() accepts asks where it does NOT overlap (spec §10.1)", () => {
	it("accepts asks in a plain .then() chain", () => {
		expect(() => createWorkflow({ name: "w" }).then(askingStep("qa")).commit()).not.toThrow()
	})

	it("accepts asks inside a .dowhile/.dountil loop body — a loop is inherently sequential, never isolated", () => {
		const body = createWorkflow({ name: "loop-body" }).then(askingStep("qa")).commit()
		expect(() =>
			createWorkflow({ name: "w" })
				.dountil(body, (_ctx, last) => (last as { summary: string }).summary === "done", { name: "until-done" })
				.commit(),
		).not.toThrow()
	})

	it("accepts asks inside a .foreach at concurrency 1 (the default)", () => {
		const body = createWorkflow({ name: "body" }).then(askingStep("qa")).commit()
		expect(() =>
			createWorkflow({ name: "w" })
				.foreach(body, () => [1, 2, 3], { name: "batch" }) // default concurrency: 1
				.commit(),
		).not.toThrow()
	})
})

describe(".commit() never rejects a questionnaire step for overlap (spec §10.1)", () => {
	const questionnaireStep = (name: string) => createQuestionnaireStep({ name, output: outputSchema })

	it("accepts a questionnaire step as a .parallel() arm", () => {
		expect(() =>
			createWorkflow({ name: "w" })
				.parallel([questionnaireStep("q1"), questionnaireStep("q2")], { name: "par" })
				.commit(),
		).not.toThrow()
	})

	it("accepts a questionnaire step inside a .foreach whose concurrency exceeds 1", () => {
		const body = createWorkflow({ name: "body" }).then(questionnaireStep("q")).commit()
		expect(() =>
			createWorkflow({ name: "w" })
				.foreach(body, () => [1, 2, 3], { name: "batch", concurrency: 3 })
				.commit(),
		).not.toThrow()
	})

	it("accepts a questionnaire step nested deep inside an overlapping construct", () => {
		const pick = createStep({ name: "pick", output: Type.Object({ go: Type.Boolean() }), run: () => ({ go: true }) })
		const armBody = createWorkflow({ name: "arm-body" }).then(questionnaireStep("deep")).commit()
		const body = createWorkflow({ name: "body" })
			.then(pick)
			.branch([[(ctx) => ctx.getStepResult<{ go: boolean }>("pick")?.go === true, armBody]], { name: "inner-branch" })
			.commit()
		expect(() =>
			createWorkflow({ name: "w" })
				.foreach(body, () => [1, 2], { name: "batch", concurrency: 2 })
				.commit(),
		).not.toThrow()
	})
})
