/** Automatic retries must retain the step's completion tool until the entire run settles. */
import type { AgentEndEvent, AgentSettledEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { SUBMIT_RESULT_TOOL } from "../src/engine/output-tools.ts"
import type { AgentRequest, AgentTurn } from "../src/engine/types.ts"
import { createPiAgentBridge } from "../src/host/pi-agent.ts"
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts"

const outputSchema = Type.Object({ grade: Type.String() })

/** Scriptable PI lifecycle used to separate loop completion from run settlement. */
function fakePi() {
	const handlers = new Map<string, (event: never) => void>()
	let active: string[] = ["bash", "read"]
	const pi = {
		on: (event: string, h: (event: never) => void) => {
			handlers.set(event, h)
		},
		sendMessage: () => {},
		setModel: async () => true,
		// PI activates a tool when it is registered.
		registerTool: (tool: { name: string }) => {
			if (!active.includes(tool.name)) active.push(tool.name)
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names]
		},
	} as unknown as ExtensionAPI

	const fire = (event: string, payload: unknown) => {
		const handler = handlers.get(event)
		if (!handler) throw new Error(`test bug: no ${event} handler was registered`)
		handler(payload as never)
	}

	return {
		pi,
		active: () => [...active],
		start: createPiAgentBridge(pi)({ find: () => undefined } as unknown as ModelRegistry, "/tmp/agent-settled-retry"),
		fireAgentEnd: (messages: unknown[]) =>
			fire("agent_end", {
				type: "agent_end",
				messages: messages as AgentEndEvent["messages"],
			} satisfies AgentEndEvent),
		fireAgentSettled: () => fire("agent_settled", { type: "agent_settled" } satisfies AgentSettledEvent),
	}
}

const request = (over: Partial<AgentRequest> = {}): AgentRequest =>
	({
		stepName: "grade",
		runId: "r",
		workflowName: "w",
		path: "grade",
		attempt: 1,
		outputSchema,
		...over,
	}) as AgentRequest

/** PI's assistant-message shape for a retryable transport failure. */
const failedAttempt = (errorMessage: string) => ({
	role: "assistant",
	content: [],
	usage: { totalTokens: 0 },
	stopReason: "error",
	errorMessage,
	timestamp: Date.now(),
})

const okAttempt = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	usage: { totalTokens: 5 },
	stopReason: "stop",
	timestamp: Date.now(),
})

const submittedAttempt = (grade: string) => ({
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "submit-after-retry",
			name: SUBMIT_RESULT_TOOL,
			arguments: { result: { grade } },
		},
	],
	usage: { totalTokens: 5 },
	stopReason: "toolUse",
	timestamp: Date.now(),
})

/** Observe settlement without adding timing races to the assertions. */
function watch(promise: Promise<AgentTurn>) {
	let state: { status: "pending" } | { status: "resolved"; turn: AgentTurn } = { status: "pending" }
	void promise.then((turn) => {
		state = { status: "resolved", turn }
	})
	return {
		get pending() {
			return state.status === "pending"
		},
		get turn() {
			return state.status === "resolved" ? state.turn : undefined
		},
	}
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("the in-session bridge across an automatic retry", () => {
	it("keeps the turn — and the step's completion tool — alive until the run settles", async () => {
		const { start, active, fireAgentEnd, fireAgentSettled } = fakePi()
		const session = start(request())
		const turn = watch(session.sendAndAwaitEnd("go"))
		await flush()
		expect(active()).toContain(SUBMIT_RESULT_TOOL)

		// `agent_end` alone must not release the turn or its scoped tool.
		fireAgentEnd([failedAttempt("The socket connection was closed unexpectedly")])
		await flush()

		expect(turn.pending).toBe(true)
		expect(active()).toContain(SUBMIT_RESULT_TOOL)

		// The retried submission becomes authoritative only when the run settles.
		fireAgentEnd([submittedAttempt("A")])
		fireAgentSettled()
		await flush()

		expect(turn.pending).toBe(false)
		expect(turn.turn?.submitted).toEqual({ tool: SUBMIT_RESULT_TOOL, arguments: { result: { grade: "A" } } })
		expect(turn.turn?.error).toBeUndefined()
		expect(active()).toContain(SUBMIT_RESULT_TOOL)

		// Disposal after settlement restores the caller's original tool set.
		session.dispose()
		expect(active()).toEqual(["bash", "read"])
	})

	it("reports a terminal failure from the LAST attempt, only once retries are exhausted", async () => {
		const { start, fireAgentEnd, fireAgentSettled } = fakePi()
		const session = start(request())
		const turn = watch(session.sendAndAwaitEnd("go"))
		await flush()

		fireAgentEnd([failedAttempt("first attempt: socket closed")])
		await flush()
		expect(turn.pending).toBe(true)

		fireAgentEnd([failedAttempt("final attempt: socket closed again")])
		fireAgentSettled()
		await flush()

		expect(turn.pending).toBe(false)
		expect(turn.turn?.error?.message).toContain("final attempt")
	})

	it("still resolves an uneventful turn when its run settles", async () => {
		const { start, fireAgentEnd, fireAgentSettled } = fakePi()
		const session = start(request())
		const turn = watch(session.sendAndAwaitEnd("go"))
		await flush()

		fireAgentEnd([okAttempt("plain answer")])
		fireAgentSettled()
		await flush()

		expect(turn.turn?.text).toBe("plain answer")
	})
})
