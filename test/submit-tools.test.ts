/**
 * End-to-end: a step's output submitted through `workflow_submit_result`/`workflow_submit_questions`, and the text
 * fallback underneath it.
 *
 * The bug these close: the engine used to read a step's output from the LAST assistant message, so any
 * harness message injected mid-run provoked one more message that displaced the payload — measured at 81
 * of 159 nudged step sessions on a benchmark run.
 */
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createAgentStep, createWorkflow } from "../src/flow/index.ts"
import { ask, createAgentDouble, createTestRun, raw, reply, submitRaw } from "../src/testing/index.ts"
import { createTestHost } from "./helpers.ts"

const gradeSchema = Type.Object({ grade: Type.String(), rationale: Type.String() })
const GRADE = { grade: "B", rationale: "tests missing" }

/** The prose a todo nudge leaves behind — valid English, not valid JSON. */
const NUDGE_REPLY = "I have delivered the grade above. Let me know if you would like anything else."

function gradeWorkflow(options: { asks?: boolean; retry?: number; repairs?: number } = {}) {
	const step = createAgentStep({
		name: "grade",
		output: gradeSchema,
		...(options.asks ? { asks: true as const } : {}),
		...(options.retry ? { retry: { maxRetry: options.retry } } : {}),
		// Default 2 repairs would consume further scripted turns; violation tests want the first verdict.
		maxOutputRepairs: options.repairs ?? 0,
		prompt: () => "Grade the work.",
	})
	return { step, workflow: createWorkflow({ name: "grading" }).then(step).commit() }
}

async function run(
	workflow: ReturnType<typeof gradeWorkflow>["workflow"],
	scripts: Parameters<typeof createAgentDouble>[1],
) {
	const agent = createAgentDouble(workflow.nodes, scripts)
	const { host, store } = createTestHost({ startAgent: agent.startAgent })
	return { result: await runWorkflow(workflow, undefined, host), store, agent }
}

// --- workflow_submit_result --------------------------------------------------------

describe("workflow_submit_result carries the step's output", () => {
	it("takes the submitted payload as the step output", async () => {
		const { workflow } = gradeWorkflow()
		const { result } = await run(workflow, { grade: [reply(GRADE)] })

		expect(result.status).toBe("completed")
		expect(result.output).toEqual(GRADE)
	})

	it("survives trailing prose that would have displaced a text reply", async () => {
		const { workflow } = gradeWorkflow()
		const { result } = await run(workflow, { grade: [reply(GRADE, NUDGE_REPLY)] })

		expect(result.status).toBe("completed")
		expect(result.output).toEqual(GRADE)
	})

	it("validates the submitted payload against the step's schema", async () => {
		const { workflow } = gradeWorkflow()
		const { result } = await run(workflow, { grade: [reply({ grade: "B" })] }) // rationale missing

		expect(result.status).toBe("crashed")
		expect(result.error).toMatch(/workflow_submit_result/)
		expect(result.error).toMatch(/rationale/)
	})

	it("reports a submission with no `result` argument rather than falling back to the prose beside it", async () => {
		const { workflow } = gradeWorkflow()
		const { result } = await run(workflow, { grade: [submitRaw("workflow_submit_result", {}, NUDGE_REPLY)] })

		expect(result.status).toBe("crashed")
		expect(result.error).toMatch(/workflow_submit_result/)
	})

	it("fails a turn that spoke but submitted nothing", async () => {
		const { workflow } = gradeWorkflow()
		const { result } = await run(workflow, { grade: [raw(`Here you go: ${JSON.stringify(GRADE)}`)] })

		// Text is not an output channel any more, however well-formed it looks.
		expect(result.status).toBe("crashed")
		expect(result.error).toMatch(/without calling workflow_submit_result/)
	})

	it("names both tools when an asking step submits nothing", async () => {
		const { workflow } = gradeWorkflow({ asks: true })
		const { result } = await run(workflow, { grade: [raw("thinking out loud")] })

		expect(result.error).toMatch(/without calling workflow_submit_result or workflow_submit_questions/)
	})

	it("never mistakes another tool for a submission, even beside a valid-looking text reply", async () => {
		const { workflow } = gradeWorkflow()
		const { result } = await run(workflow, { grade: [submitRaw("bash", { command: "ls" }, JSON.stringify(GRADE))] })

		// Text is not an output channel: JSON in the transcript is not a submission.
		expect(result.status).toBe("crashed")
		expect(result.error).toMatch(/without calling workflow_submit_result/)
	})
})

// --- workflow_submit_questions -----------------------------------------------------

describe("workflow_submit_questions blocks the run on a batch", () => {
	const questionnaire = {
		title: "Scope",
		questions: [{ key: "db", header: "Database", kind: "text" as const, question: "Which database?" }],
	}

	it("blocks the run and surfaces the submitted batch", async () => {
		const { workflow } = gradeWorkflow({ asks: true })
		const blocked = await createTestRun(workflow, { agents: { grade: [ask(questionnaire)] } })

		expect(blocked.status).toBe("blocked")
		expect(blocked.questionnaire?.questions[0]?.question).toBe("Which database?")
	})

	it("blocks even when the model kept talking after the call", async () => {
		const { workflow } = gradeWorkflow({ asks: true })
		const blocked = await createTestRun(workflow, {
			agents: { grade: [ask(questionnaire, "Let me know when you have answered.")] },
		})

		expect(blocked.status).toBe("blocked")
	})

	it("resumes to a submitted result once answered", async () => {
		const { workflow } = gradeWorkflow({ asks: true })
		const blocked = await createTestRun(workflow, {
			agents: { grade: [ask(questionnaire), reply(GRADE)] },
		})
		const done = await blocked.answer({ db: "postgres" })

		expect(done.status).toBe("completed")
		expect(done.output).toEqual(GRADE)
	})

	it("rejects a batch that does not match the questionnaire schema", async () => {
		const { workflow } = gradeWorkflow({ asks: true })
		const { result } = await run(workflow, {
			grade: [submitRaw("workflow_submit_questions", { questions: "not-an-array" })],
		})

		expect(result.status).toBe("crashed")
		expect(result.error).toMatch(/workflow_submit_questions/)
	})

	it("is rejected at script construction for a step that cannot block", async () => {
		const { workflow } = gradeWorkflow() // no asks
		expect(() => createAgentDouble(workflow.nodes, { grade: [ask(questionnaire)] })).toThrow(/asks: true/)
	})
})

// --- interaction with the surrounding machinery ---------------------------

describe("submissions and the rest of the step machinery", () => {
	it("a schema-invalid submission is retryable, and a later attempt can succeed", async () => {
		const { workflow } = gradeWorkflow({ retry: 1 })
		const { result } = await run(workflow, { grade: [reply({ grade: "B" }), reply(GRADE)] })

		expect(result.status).toBe("completed")
		expect(result.output).toEqual(GRADE)
	})

	it("an in-session repair can follow an invalid submission with a valid one", async () => {
		const step = createAgentStep({
			name: "grade",
			output: gradeSchema,
			maxOutputRepairs: 1,
			prompt: () => "Grade the work.",
		})
		const workflow = createWorkflow({ name: "grading-repair" }).then(step).commit()
		const { result, agent } = await run(workflow, { grade: [reply({ grade: "B" }), reply(GRADE)] })

		expect(result.status).toBe("completed")
		expect(result.output).toEqual(GRADE)
		expect(agent.record("grade").messages).toHaveLength(2) // prompt, then the correction
		expect(agent.record("grade").messages[1]).toMatch(/did not submit a valid result/)
	})

	it("counts a submitting turn's tokens against the step budget", async () => {
		const step = createAgentStep({
			name: "grade",
			output: gradeSchema,
			maxTokens: 10,
			prompt: () => "Grade the work.",
		})
		const workflow = createWorkflow({ name: "grading-budget" }).then(step).commit()
		const submission = { ...reply(GRADE), totalTokens: 99 }
		const { result } = await run(workflow, { grade: [submission] })

		expect(result.status).toBe("crashed")
		expect(result.error).toMatch(/token budget/)
	})
})
