import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { createAgentStep, createQuestionnaireStep, createStep, createWorkflow } from "../src/flow/index.ts"
import { ask, createTestRun, raw, reply, throws, usage } from "../src/testing/index.ts"

/**
 * The testing framework's own tests. Covers what the framework promises workflow authors:
 * step-keyed agent scripting, queues that survive session boundaries, the questionnaire-step answer
 * matrix (spec §2.4), and construction-time rejection of scripts that cannot apply to their step.
 */

const planSchema = Type.Object({ steps: Type.Array(Type.String()) })
const formSchema = Type.Object({
	name: Type.String({ description: "Your name?" }),
	environment: Type.Union([Type.Literal("dev"), Type.Literal("prod")], { description: "Which environment?" }),
})

const oneQuestion = {
	questions: [{ key: "backend", header: "Backend", question: "Which cache?", kind: "text" as const }],
}

describe("agent scripting by step name", () => {
	it("dispatches replies per step, so two agent steps are scripted independently", async () => {
		const first = createAgentStep({ name: "first", output: Type.Object({ a: Type.Number() }), prompt: () => "do a" })
		const second = createAgentStep({
			name: "second",
			input: Type.Object({ a: Type.Number() }),
			output: Type.Object({ b: Type.Number() }),
			prompt: ({ input }) => `do b after ${input.a}`,
		})
		const workflow = createWorkflow({ name: "two-agents" }).then(first).then(second).commit()

		const run = await createTestRun(workflow, {
			agents: { first: [reply({ a: 1 })], second: [reply({ b: 2 })] },
		})

		expect(run.status).toBe("completed")
		expect(run.output).toEqual({ b: 2 })
		expect(run.stepOutput("first")).toEqual({ a: 1 })
		// Each step saw only its own prompt — dispatch is by name, not by call order.
		expect(run.agent("first").messages[0]).toContain("do a")
		expect(run.agent("second").messages[0]).toContain("do b after 1")
	})

	it("consumes one step's queue across sessions: a block and its answer-resume take successive entries", async () => {
		const plan = createAgentStep({ name: "plan", output: planSchema, asks: true, prompt: () => "plan it" })
		const workflow = createWorkflow({ name: "asking" }).then(plan).commit()

		const blocked = await createTestRun(workflow, {
			agents: { plan: [ask(oneQuestion), reply({ steps: ["cache reads"] })] },
		})
		expect(blocked.status).toBe("blocked")
		expect(blocked.questionKeys()).toEqual(["backend"])
		expect(blocked.violation).toBeUndefined() // an agent's question is not a rejection

		const done = await blocked.answer({ backend: "Redis" })
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ steps: ["cache reads"] })

		// Two sessions for one step (fresh, then the answer-resume seeded with history), one queue.
		const record = done.agent("plan")
		expect(record.sessions).toBe(2)
		expect(record.remaining).toBe(0)
		expect(record.messages[0]).toMatch(/plan it/)
		expect(record.messages[1]).toMatch(/Redis/)
	})

	it("scripts the failure paths: a thrown turn retries, and the next queue entry serves the retry", async () => {
		const flaky = createAgentStep({
			name: "flaky",
			output: planSchema,
			retry: { maxRetry: 1, backoffMs: 25 },
			prompt: () => "go",
		}) // 1 retry after the first = 2 total attempts
		const workflow = createWorkflow({ name: "agent-retry" }).then(flaky).commit()

		const run = await createTestRun(workflow, {
			agents: { flaky: [throws("503 upstream"), reply({ steps: ["ok"] })] },
		})

		expect(run.status).toBe("completed")
		expect(run.eventsOf("step-retry")).toMatchObject([{ path: "flaky", attempt: 1, reason: "thrown-error" }])
		expect(run.sleepCalls).toEqual([25])
		expect(run.agent("flaky").sessions).toBe(2) // a retry opens a fresh session
	})

	it("scripts invalid output, driving in-session steering before the corrected reply", async () => {
		const steered = createAgentStep({ name: "steered", output: planSchema, prompt: () => "go" })
		const workflow = createWorkflow({ name: "agent-steer" }).then(steered).commit()

		const run = await createTestRun(workflow, {
			agents: { steered: [raw("not json at all"), reply({ steps: ["recovered"] })] },
		})

		expect(run.status).toBe("completed")
		expect(run.eventsOf("agent-steer")).toHaveLength(1)
		expect(run.agent("steered").sessions).toBe(1) // steering stays within ONE session
	})

	it("counts scripted token usage against the step budget", async () => {
		const greedy = createAgentStep({ name: "greedy", output: planSchema, maxTokens: 10, prompt: () => "go" })
		const workflow = createWorkflow({ name: "agent-tokens" }).then(greedy).commit()

		const run = await createTestRun(workflow, {
			agents: { greedy: [usage(reply({ steps: ["x"] }), 50)] },
		})

		expect(run.status).toBe("crashed")
		expect(run.error).toMatch(/token budget/)
	})
})

describe("agent script validation (fails at construction, not mid-run)", () => {
	const plain = createAgentStep({ name: "plain", output: planSchema, prompt: () => "go" })
	const plainWorkflow = createWorkflow({ name: "plain-agent" }).then(plain).commit()

	it("rejects a script naming a step that is not an agent step", async () => {
		await expect(createTestRun(plainWorkflow, { agents: { nope: [reply({ steps: [] })] } })).rejects.toThrow(
			/no agent step with that name/,
		)
	})

	it("rejects ask() against a step that cannot block", async () => {
		await expect(createTestRun(plainWorkflow, { agents: { plain: [ask(oneQuestion)] } })).rejects.toThrow(
			/requires a step declared asks: true/,
		)
	})

	it("reports an agent step that ran with nothing scripted", async () => {
		await expect(createTestRun(plainWorkflow)).rejects.toThrow(/no replies were scripted/)
	})
})

describe("questionnaire step answer matrix (spec §2.4)", () => {
	const form = createQuestionnaireStep({ name: "form", output: formSchema })
	const greet = createStep({
		name: "greet",
		input: formSchema,
		output: Type.Object({ message: Type.String() }),
		run: ({ input }) => ({ message: `${input.name} → ${input.environment}` }),
	})
	const workflow = createWorkflow({ name: "form-matrix" }).then(form).then(greet).commit()

	it("blocks with the derived questionnaire, and no violation on the first ask", async () => {
		const blocked = await createTestRun(workflow)
		expect(blocked.status).toBe("blocked")
		expect(blocked.path).toBe("form")
		expect(blocked.questionKeys()).toEqual(["name", "environment"])
		expect(blocked.violation).toBeUndefined()
	})

	it("completes on full, valid answers", async () => {
		const blocked = await createTestRun(workflow)
		const done = await blocked.answer({ name: "Ada", environment: "prod" })
		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ message: "Ada → prod" })
	})

	it("re-blocks with a violation naming the unanswered mandatory question", async () => {
		const blocked = await createTestRun(workflow)
		const again = await blocked.answer({ name: "Ada" })

		expect(again.status).toBe("blocked")
		expect(again.violation).toMatch(/environment/)
		expect(again.questionKeys()).toEqual(["name", "environment"]) // the same batch comes back
	})

	it("re-blocks with a violation when an answer is outside the declared options", async () => {
		const blocked = await createTestRun(workflow)
		const again = await blocked.answer({ name: "Ada", environment: "staging" })

		expect(again.status).toBe("blocked")
		expect(again.violation).toMatch(/environment/)
	})

	it("re-blocks naming every missing question when nothing is answered", async () => {
		const blocked = await createTestRun(workflow)
		const again = await blocked.answer({})

		expect(again.status).toBe("blocked")
		expect(again.violation).toMatch(/name/)
		expect(again.violation).toMatch(/environment/)
	})

	it("stays answerable after a re-block: a corrected answer completes the run", async () => {
		const blocked = await createTestRun(workflow)
		const rejected = await blocked.answer({ name: "Ada" })
		const done = await rejected.answer({ name: "Ada", environment: "dev" })

		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ message: "Ada → dev" })
	})

	it("dismissal is not an engine event: an unanswered block appends nothing and stays answerable", async () => {
		const blocked = await createTestRun(workflow)
		// Dismissing the form (spec §10.2) never reaches the engine — the host simply does not resume.
		expect(blocked.eventsOf("answers-provided")).toHaveLength(0)
		expect(blocked.eventsOf("questionnaire-asked")).toHaveLength(1)

		const done = await blocked.answer({ name: "Ada", environment: "dev" })
		expect(done.status).toBe("completed")
	})
})

describe("cancellation (spec §8.6) — function/agent steps only", () => {
	const calls = { a: 0, b: 0 }
	const buildWorkflow = () => {
		calls.a = 0
		calls.b = 0
		const a = createStep({
			name: "a",
			output: Type.Object({ a: Type.Number() }),
			run: () => {
				calls.a += 1
				return { a: 1 }
			},
		})
		const b = createStep({
			name: "b",
			input: Type.Object({ a: Type.Number() }),
			output: Type.Object({ b: Type.Number() }),
			run: ({ input }) => {
				calls.b += 1
				return { b: input.a + 1 }
			},
		})
		return createWorkflow({ name: "cancellable" }).then(a).then(b).commit()
	}

	it("cancels before the named step runs, leaving the prior step checkpointed", async () => {
		const cancelled = await createTestRun(buildWorkflow(), { cancelAt: "b" })

		expect(cancelled.status).toBe("cancelled")
		expect(calls).toEqual({ a: 1, b: 0 }) // "b" never executed
		expect(cancelled.stepOutput("a")).toEqual({ a: 1 })
		expect(cancelled.eventsOf("run-cancelled")).toHaveLength(1)
	})

	it("resumes a cancelled run node-atomically: the completed step is not re-run", async () => {
		const cancelled = await createTestRun(buildWorkflow(), { cancelAt: "b" })
		const done = await cancelled.resume()

		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ b: 2 })
		expect(calls).toEqual({ a: 1, b: 1 }) // "a" was checkpointed, only "b" ran on resume
	})
})

describe("transition guards", () => {
	const form = createQuestionnaireStep({ name: "form", output: formSchema })
	const workflow = createWorkflow({ name: "guards" }).then(form).commit()

	it("refuses answer() on a run that is not blocked", async () => {
		const blocked = await createTestRun(workflow)
		const done = await blocked.answer({ name: "Ada", environment: "dev" })
		await expect(done.answer({})).rejects.toThrow(/not blocked/)
	})

	it("refuses resume() on a blocked run and points at answer()", async () => {
		const blocked = await createTestRun(workflow)
		await expect(blocked.resume()).rejects.toThrow(/use answer\(\) instead/)
	})
})
