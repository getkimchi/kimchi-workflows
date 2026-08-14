import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { createAgentStep, createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { ask, createTestRun, reply } from "../src/testing/index.ts"

/**
 * Questionnaire steps (spec §2.4) and Q&A agent steps (spec §10.1), driven through the public
 * testing framework — which is also the worked example of what that framework is for.
 */

// ---- Form mode -------------------------------------------------------------------------------------

const formSchema = Type.Object({
	name: Type.String({ description: "What is your name?" }),
	env: Type.Union([Type.Literal("dev"), Type.Literal("prod")], { default: "dev" }),
	tags: Type.Array(Type.Union([Type.Literal("a"), Type.Literal("b")])),
	address: Type.Object({ city: Type.String() }, { title: "Address" }),
})

describe("questionnaire step — form mode (B2, spec §2.4)", () => {
	it("blocks with a questionnaire derived from the annotated schema; answers reassemble + validate into output", async () => {
		const consume = createStep({
			name: "consume",
			input: formSchema,
			output: Type.Object({ label: Type.String() }),
			run: ({ input }) => ({ label: `${input.name}/${input.env}/${input.address.city}` }),
		})
		const workflow = createWorkflow({ name: "form" })
			.then(createQuestionnaireStep({ name: "ask", output: formSchema }))
			.then(consume)
			.commit()

		// No agent scripts: a form step never opens an agent session.
		const blocked = await createTestRun(workflow)

		expect(blocked.status).toBe("blocked")
		expect(blocked.path).toBe("ask")
		expect(blocked.questionKeys()).toEqual(["name", "env", "tags", "address.city"]) // nested key qualified
		expect(blocked.questionnaire?.questions.map((q) => q.kind)).toEqual(["text", "single", "multi", "text"])
		expect(blocked.questionnaire?.questions.find((q) => q.key === "address.city")?.section).toBe("Address")
		expect(blocked.violation).toBeUndefined() // a first ask rejects nothing

		const done = await blocked.answer({ name: "Ada", env: "prod", tags: ["a"], "address.city": "NYC" })

		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ label: "Ada/prod/NYC" }) // the following step consumed the reassembled input
		expect(done.stepOutput("ask")).toEqual({ name: "Ada", env: "prod", tags: ["a"], address: { city: "NYC" } }) // reassembled + validated
	})

	it("re-blocks with a violation when the answers violate the target schema", async () => {
		const workflow = createWorkflow({ name: "form-bad" })
			.then(createQuestionnaireStep({ name: "ask", output: formSchema }))
			.commit()
		const blocked = await createTestRun(workflow)

		const bad = await blocked.answer({ name: "Ada", env: "staging", tags: [], "address.city": "NYC" })
		expect(bad.status).toBe("blocked") // "staging" is not in the union → re-block
		expect(bad.violation).toMatch(/env/)

		const good = await bad.answer({ name: "Ada", env: "dev", tags: [], "address.city": "NYC" })
		expect(good.status).toBe("completed")
		expect(good.output).toEqual({ name: "Ada", env: "dev", tags: [], address: { city: "NYC" } })
	})

	it("re-blocks with a violation naming every mandatory question left unanswered", async () => {
		const workflow = createWorkflow({ name: "form-partial" })
			.then(createQuestionnaireStep({ name: "ask", output: formSchema }))
			.commit()
		const blocked = await createTestRun(workflow)

		const partial = await blocked.answer({ name: "Ada" })
		expect(partial.status).toBe("blocked")
		expect(partial.violation).toMatch(/env/)
		expect(partial.violation).toMatch(/tags/)
		expect(partial.questionKeys()).toEqual(["name", "env", "tags", "address.city"]) // the same batch comes back
	})
})

// ---- Agent (elicitation) mode ----------------------------------------------------------------------

const agentSchema = Type.Object({ answer: Type.String() })
const oneQuestion = (key: string, question: string) => ({
	questions: [{ key, header: key, question, kind: "text" as const }],
})

describe("Q&A agent step — elicitation (B2, spec §10.1)", () => {
	it("emits {questions} → blocks → answers delivered → emits {result} → completes; asking protocol injected", async () => {
		const elicit = createAgentStep({
			name: "elicit",
			output: agentSchema,
			asks: true,
			prompt: () => "Collect the answer.",
		})
		const workflow = createWorkflow({ name: "agent-input" }).then(elicit).commit()

		const blocked = await createTestRun(workflow, {
			agents: { elicit: [ask(oneQuestion("answer", "What is the answer?")), reply({ answer: "42" })] },
		})

		expect(blocked.status).toBe("blocked")
		expect(blocked.questionKeys()).toEqual(["answer"])
		// The framework auto-injected the asking protocol (the author's prompt is task-only).
		const firstMessage = blocked.agent("elicit").messages[0] ?? ""
		expect(firstMessage).toMatch(/"questions":/)
		expect(firstMessage).toMatch(/workflow_submit_result/)
		expect(firstMessage).toMatch(/[Bb]atch as many questions/)

		const done = await blocked.answer({ answer: "42" })
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ answer: "42" })
		expect(done.agent("elicit").sessions).toBe(2) // fresh session, then the continuation seeded with history
	})

	it("supports two questionnaire batches (re-batch) before the result", async () => {
		const elicit = createAgentStep({
			name: "elicit",
			output: agentSchema,
			asks: true,
			prompt: () => "Collect the answer.",
		})
		const workflow = createWorkflow({ name: "agent-rebatch" }).then(elicit).commit()

		const blocked1 = await createTestRun(workflow, {
			agents: {
				elicit: [ask(oneQuestion("answer", "Q1?")), ask(oneQuestion("answer", "Q2?")), reply({ answer: "done" })],
			},
		})
		expect(blocked1.status).toBe("blocked")

		const blocked2 = await blocked1.answer({ answer: "a1" })
		expect(blocked2.status).toBe("blocked") // re-batched
		expect(blocked2.violation).toBeUndefined() // an agent's re-batch is a new question, not a rejection

		const done = await blocked2.answer({ answer: "a2" })
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ answer: "done" })
		expect(done.eventsOf("questionnaire-asked")).toHaveLength(2)
	})
})

describe("plain agent step (regression: no Q&A protocol)", () => {
	it("still returns bare validated output and never blocks", async () => {
		const step = createAgentStep({
			name: "plain",
			output: Type.Object({ ok: Type.Boolean() }),
			prompt: () => "just do it",
		})
		const workflow = createWorkflow({ name: "plain" }).then(step).commit()

		const result = await createTestRun(workflow, { agents: { plain: [reply({ ok: true })] } })

		expect(result.status).toBe("completed")
		expect(result.output).toEqual({ ok: true })
		// A plain step gets the OUTPUT protocol (the engine validates against that schema either way), but
		// never the ASKING protocol — it cannot block, so it must not be invited to emit `{questions}`.
		const prompt = result.agent("plain").messages[0] as string
		expect(prompt).toContain("just do it")
		expect(prompt).toContain('"ok"')
		expect(prompt).not.toContain("questions")
	})
})
