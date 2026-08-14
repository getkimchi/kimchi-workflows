/**
 * A turn that failed at the PROVIDER, and how far that fact travels (spec §9.3's `agent-error`).
 *
 * The failure mode this exists for: a request the provider refuses still completes a turn. PI records an
 * assistant message with `content: []`, zero usage and `stopReason: "error"`, then ends the loop — which
 * at the engine's boundary is shaped exactly like a model that chose not to call `workflow_submit_result`. Read
 * as the latter it produces a violation the model never committed, a steering correction sent into a
 * session that cannot answer, and a step failure whose stated cause is wrong.
 *
 * `contextWindowBody` is a real error body, kept verbatim: the gateway wraps the provider's own JSON in
 * more JSON, and a hand-written fixture would not have.
 */
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { RunEvent } from "../src/engine/types.ts"
import { createAgentStep, createWorkflow } from "../src/flow/index.ts"
import type { AgentMessages } from "../src/host/pi-agent-messages.ts"
import {
	classifyAgentError,
	createAssistantTurnReader,
	lastAssistantError,
	parseNdjsonMessages,
} from "../src/host/pi-agent-messages.ts"
import { createTestHost } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

const outputSchema = Type.Object({ summary: Type.String() })
const valid = '{"summary":"ok"}'

const contextWindowBody =
	'{"detail":"ContextWindowExceededError: Hosted_vllmException - {\\"object\\":\\"error\\",\\"message\\":\\"The input (295660 tokens) is longer than the model\'s context length (262144 tokens).\\",\\"type\\":\\"BadRequestError\\",\\"param\\":null,\\"code\\":400}"}'

/** An assistant message shaped as PI writes a refused request. */
const failedMessage = (errorMessage: string) => ({
	role: "assistant",
	content: [],
	usage: { input: 0, output: 0, totalTokens: 0 },
	stopReason: "error",
	errorMessage,
})

const healthyMessage = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	usage: { totalTokens: 11 },
	stopReason: "stop",
})

const asMessages = (items: readonly object[]): AgentMessages => items as unknown as AgentMessages

function agentErrors(events: readonly RunEvent[]): Extract<RunEvent, { type: "agent-error" }>[] {
	return events.filter((event): event is Extract<RunEvent, { type: "agent-error" }> => event.type === "agent-error")
}

describe("classifyAgentError", () => {
	it("recognizes a context overflow through the gateway wrapping it", () => {
		expect(classifyAgentError(contextWindowBody)).toBe("context-window-exceeded")
	})

	it("recognizes the other phrasings the same gateway produces for it", () => {
		for (const body of [
			'{"error":{"type":"invalid_request_error","message":"The input exceeds the maximum context length"}}',
			"prompt is too long: 300000 tokens > 262144 maximum",
			"too many tokens in request",
		]) {
			expect(classifyAgentError(body)).toBe("context-window-exceeded")
		}
	})

	it("leaves anything it does not recognize retryable", () => {
		// The conservative direction: an unrecognized failure retries rather than declaring a run over.
		expect(classifyAgentError('{"error":{"message":"rate limit exceeded"}}')).toBe("provider-error")
		expect(classifyAgentError("upstream connect error")).toBe("provider-error")
		expect(classifyAgentError("")).toBe("provider-error")
	})
})

describe("lastAssistantError", () => {
	it("reads the provider's message off a failed turn", () => {
		const error = lastAssistantError(asMessages([failedMessage(contextWindowBody)]))

		expect(error).toEqual({ kind: "context-window-exceeded", message: contextWindowBody })
	})

	it("reports nothing for a healthy turn, however empty its content", () => {
		// A turn that ends on a tool call alone carries no text and no error — emptiness is not failure.
		expect(lastAssistantError(asMessages([healthyMessage("")]))).toBeUndefined()
		expect(lastAssistantError(asMessages([{ role: "assistant", content: [] }]))).toBeUndefined()
		expect(lastAssistantError(asMessages([]))).toBeUndefined()
	})

	it("names the failure even when the provider sent no message with it", () => {
		const error = lastAssistantError(asMessages([{ role: "assistant", content: [], stopReason: "error" }]))

		expect(error?.kind).toBe("provider-error")
		expect(error?.message).toMatch(/no message/)
	})

	it("reads the LAST turn, so a failure the session already recovered from is not reported", () => {
		const messages = asMessages([failedMessage(contextWindowBody), healthyMessage("recovered")])

		expect(lastAssistantError(messages)).toBeUndefined()
	})
})

describe("the background reader (subprocess stdout)", () => {
	const line = (message: object) => `${JSON.stringify({ type: "message_end", message })}\n`

	it("carries the failure out of the NDJSON stream", () => {
		const reader = createAssistantTurnReader()
		reader.push(line(failedMessage(contextWindowBody)))

		expect(reader.end().error).toEqual({ kind: "context-window-exceeded", message: contextWindowBody })
	})

	it("drops it once a later message succeeds — pi retries some failures on its own", () => {
		const reader = createAssistantTurnReader()
		reader.push(line(failedMessage("upstream timeout")))
		reader.push(line(healthyMessage("second try worked")))

		const turn = reader.end()
		expect(turn.error).toBeUndefined()
		expect(turn.text).toBe("second try worked")
	})

	it("agrees with the whole-stream parser on the same bytes", () => {
		const ndjson = line(failedMessage(contextWindowBody))
		const reader = createAssistantTurnReader()
		reader.push(ndjson)

		expect(reader.end().error).toEqual(lastAssistantError(parseNdjsonMessages(ndjson)))
	})
})

describe("what the engine does with a failed turn", () => {
	it("does not steer it: there is no reply to correct, so the repair budget is untouched", async () => {
		const step = createAgentStep({
			name: "worker",
			output: outputSchema,
			maxOutputRepairs: 2,
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "no-steer-on-error" }).then(step).commit()
		const agent = scriptedAgent([[{ error: { kind: "provider-error", message: "upstream 503" } }]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("crashed")
		expect(agent.messages).toHaveLength(1) // the prompt, and no correction after it
		const events = await store.loadEvents(result.runId)
		expect(events.filter((event) => event.type === "agent-steer")).toHaveLength(0)
	})

	it("says what actually happened, rather than blaming the model for not submitting", async () => {
		const step = createAgentStep({ name: "worker", output: outputSchema, prompt: () => "go" })
		const workflow = createWorkflow({ name: "error-text" }).then(step).commit()
		const agent = scriptedAgent([[{ error: { kind: "provider-error", message: "upstream 503" } }]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.error).toMatch(/provider-error/)
		expect(result.error).toMatch(/upstream 503/)
		expect(result.error).not.toMatch(/workflow_submit_result/)

		const errors = agentErrors(await store.loadEvents(result.runId))
		expect(errors).toHaveLength(1)
		expect(errors[0]).toMatchObject({
			path: "worker",
			attempt: 1,
			kind: "provider-error",
			message: "upstream 503",
			terminal: false,
		})
	})

	it("retries a provider error like any other transport failure", async () => {
		const step = createAgentStep({
			name: "worker",
			output: outputSchema,
			retry: { maxRetry: 1 },
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "error-retry" }).then(step).commit()
		const agent = scriptedAgent([[{ error: { kind: "provider-error", message: "rate limited" } }], [valid]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(agent.opened).toBe(2)
		const retries = (await store.loadEvents(result.runId)).filter((event) => event.type === "step-retry")
		expect(retries).toMatchObject([{ path: "worker", reason: "agent-error" }])
	})

	it("retries a context overflow too when each attempt gets a fresh session", async () => {
		// Nothing is resumed here, so attempt 2 writes a new session file and is a genuinely smaller request.
		const step = createAgentStep({
			name: "worker",
			output: outputSchema,
			retry: { maxRetry: 1 },
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "overflow-fresh" }).then(step).commit()
		const agent = scriptedAgent([[{ error: { kind: "context-window-exceeded", message: contextWindowBody } }], [valid]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed")
		expect(agent.opened).toBe(2)
		expect(agentErrors(await store.loadEvents(result.runId))[0]).toMatchObject({ terminal: false })
	})

	it("stops immediately when a RESUMED session overflows, instead of re-sending it", async () => {
		// A resumed session names one file for every execution and each turn
		// appends to it, so the request that was already too large is a prefix of the next one. Retrying
		// spends the whole policy re-sending a transcript that cannot shrink.
		const step = createAgentStep({
			name: "orchestrator",
			output: outputSchema,
			resumable: true,
			retry: { maxRetry: 3 },
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "overflow-resumed" }).then(step).commit()
		const agent = scriptedAgent([[{ error: { kind: "context-window-exceeded", message: contextWindowBody } }]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("crashed")
		expect(agent.opened).toBe(1) // one attempt, despite maxRetry: 3
		expect(result.error).toMatch(/context-window-exceeded/)

		const events = await store.loadEvents(result.runId)
		expect(events.filter((event) => event.type === "step-retry")).toHaveLength(0)
		expect(agentErrors(events)).toMatchObject([{ kind: "context-window-exceeded", terminal: true }])
	})

	it("carries the same distinction through an optional step, which the run survives", async () => {
		const step = createAgentStep({
			name: "gates",
			output: outputSchema,
			optional: true,
			resumable: "orchestrator",
			prompt: () => "go",
		})
		const workflow = createWorkflow({ name: "overflow-optional" }).then(step).commit()
		const agent = scriptedAgent([[{ error: { kind: "context-window-exceeded", message: contextWindowBody } }]])
		const { host, store } = createTestHost({ startAgent: agent.startAgent })

		const result = await runWorkflow(workflow, undefined, host)

		expect(result.status).toBe("completed") // optional: the run carries on without the step's output
		const events = await store.loadEvents(result.runId)
		const failed = events.filter((event) => event.type === "step-failed")
		expect(failed).toHaveLength(1)
		expect(failed[0]).toMatchObject({ path: "gates" })
		expect((failed[0] as Extract<RunEvent, { type: "step-failed" }>).error).toMatch(/context-window-exceeded/)
		expect(agentErrors(events)).toMatchObject([{ terminal: true }])
	})
})
