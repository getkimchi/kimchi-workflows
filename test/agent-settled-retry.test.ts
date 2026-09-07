/** Automatic retries must retain the step's completion tool until the entire run settles. */
import type { AgentEndEvent, AgentSettledEvent, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "../src/engine/output-tools.ts"
import type { AgentRequest, AgentTurn } from "../src/engine/types.ts"
import { createPiAgentBridge } from "../src/host/pi-agent.ts"
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts"
import { fakeSessionManager } from "./fake-session-manager.ts"

const outputSchema = Type.Object({ grade: Type.String() })

/** Scriptable PI lifecycle used to separate loop completion from run settlement. */
function fakePi(options: { joinRunningLoop?: boolean } = {}) {
	const handlers = new Map<string, (event: never, ctx: never) => void>()
	const tools = new Map<string, ToolDefinition>()
	let active: string[] = ["bash", "read"]
	const sessionManager = fakeSessionManager()
	let nextToolCall = 0
	const context = { sessionManager }
	const pi = {
		on: (event: string, h: (event: never, ctx: never) => void) => {
			handlers.set(event, h)
		},
		sendMessage: (message: object) => {
			// PI steers messages into an existing loop without emitting another agent_start.
			if (!options.joinRunningLoop) fire("agent_start", { type: "agent_start" })
			sessionManager.appendMessage({ role: "custom", ...message })
		},
		setModel: async () => true,
		// PI activates a tool when it is registered.
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool)
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
		handler(payload as never, context as never)
	}
	const submit = async (toolName: string, args: Record<string, unknown>) => {
		const tool = tools.get(toolName)
		if (!tool) throw new Error(`test bug: ${toolName} was not registered`)
		const id = `call-${++nextToolCall}`
		const result = await tool.execute(id, args, undefined, undefined, context as never)
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName,
			content: result.content,
			details: result.details,
			isError: false,
		})
	}

	// Production binds the invoking command context, including its live session manager.
	const control = options.joinRunningLoop
		? {
				sessionManager,
				abort: () => {},
				isIdle: () => false,
				hasPendingMessages: () => true,
				waitForIdle: () => new Promise<void>(() => {}),
			}
		: undefined
	return {
		pi,
		active: () => [...active],
		start: createPiAgentBridge(pi)(
			{ find: () => undefined } as unknown as ModelRegistry,
			"/tmp/agent-settled-retry",
			control,
		),
		sessionManager,
		submit,
		fireAgentStart: () => fire("agent_start", { type: "agent_start" }),
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

describe("workflow prompts queued into an existing PI loop", () => {
	it.each([SUBMIT_RESULT_TOOL, SUBMIT_QUESTIONS_TOOL])("recovers %s without a new agent_start", async (tool) => {
		const fake = fakePi({ joinRunningLoop: true })
		fake.fireAgentStart() // The ordinary PI response began before the workflow had an in-flight turn.
		const session = fake.start(request({ asks: true }))
		const turn = watch(session.sendAndAwaitEnd("go"))
		const args =
			tool === SUBMIT_RESULT_TOOL
				? { result: { grade: "A" } }
				: { questions: [{ key: "grade", header: "Grade", question: "Which grade?", kind: "text" }] }
		await fake.submit(tool, args)
		fake.fireAgentEnd([okAttempt("done")])
		await flush()
		expect(turn.pending).toBe(true)
		expect(fake.active()).toContain(tool)
		fake.fireAgentSettled()
		await flush()
		expect(turn.turn?.submitted).toEqual({ tool, arguments: args })
		session.dispose()
		expect(fake.active()).toEqual(["bash", "read"])
	})

	it("excludes earlier submissions and refreshes the boundary for every queued turn", async () => {
		const fake = fakePi({ joinRunningLoop: true })
		fake.fireAgentStart()
		const session = fake.start(request())
		// Written after binding; capture must happen when sending.
		fake.sessionManager.appendSubmission("result", request(), { result: { grade: "stale" } })
		const first = session.sendAndAwaitEnd("go")
		await fake.submit(SUBMIT_RESULT_TOOL, { result: { grade: "A" } })
		fake.fireAgentEnd([okAttempt("done")])
		fake.fireAgentSettled()
		expect((await first).submitted?.arguments).toEqual({ result: { grade: "A" } })

		fake.fireAgentStart() // A different ordinary response is streaming when the next turn is sent.
		const repair = session.sendAndAwaitEnd("repair")
		fake.fireAgentEnd([okAttempt("no submission this time")])
		fake.fireAgentSettled()
		expect((await repair).submitted).toBeUndefined()
		session.dispose()
	})

	it("does not advance the queued turn's cursor when PI later starts a retry", async () => {
		const fake = fakePi({ joinRunningLoop: true })
		fake.fireAgentStart()
		const session = fake.start(request())
		const turn = session.sendAndAwaitEnd("go")
		await fake.submit(SUBMIT_RESULT_TOOL, { result: { grade: "A" } })
		fake.fireAgentEnd([failedAttempt("a continuation failed")])
		fake.fireAgentStart()
		fake.fireAgentEnd([okAttempt("retry completed")])
		fake.fireAgentSettled()
		expect((await turn).submitted?.arguments).toEqual({ result: { grade: "A" } })
		session.dispose()
	})
})

describe("the in-session bridge across an automatic retry", () => {
	it("keeps the turn — and the step's completion tool — alive until the run settles", async () => {
		const { start, active, submit, fireAgentStart, fireAgentEnd, fireAgentSettled } = fakePi()
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
		fireAgentStart()
		await submit(SUBMIT_RESULT_TOOL, { result: { grade: "A" } })
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
		const { start, active, fireAgentStart, fireAgentEnd, fireAgentSettled } = fakePi()
		const session = start(request())
		const turn = watch(session.sendAndAwaitEnd("go"))
		await flush()

		fireAgentEnd([failedAttempt("first attempt: socket closed")])
		await flush()
		expect(turn.pending).toBe(true)

		fireAgentStart()
		fireAgentEnd([failedAttempt("final attempt: socket closed again")])
		fireAgentSettled()
		await flush()

		expect(turn.pending).toBe(false)
		expect(turn.turn?.error?.message).toContain("final attempt")
		expect(turn.turn?.submitted).toBeUndefined()
		session.dispose()
		expect(active()).toEqual(["bash", "read"])
	})

	it("still resolves an uneventful turn when its run settles", async () => {
		const { start, active, fireAgentEnd, fireAgentSettled } = fakePi()
		const session = start(request({ outputSchema: undefined }))
		const turn = watch(session.sendAndAwaitEnd("go"))
		await flush()

		fireAgentEnd([okAttempt("plain answer")])
		fireAgentSettled()
		await flush()

		expect(turn.turn?.text).toBe("plain answer")
		expect(turn.turn?.usage).toEqual({ totalTokens: 5 })
		expect(turn.turn?.submitted).toBeUndefined()
		session.dispose()
		expect(active()).toEqual(["bash", "read"])
	})

	it("keeps a submission when a later continuation finishes without another one", async () => {
		const fake = fakePi()
		const session = fake.start(request())
		const turn = session.sendAndAwaitEnd("go")
		await fake.submit(SUBMIT_RESULT_TOOL, { result: { grade: "A" } })
		fake.fireAgentEnd([submittedAttempt("A"), failedAttempt("mixed-tool continuation failed")])
		fake.fireAgentStart()
		fake.fireAgentEnd([okAttempt("retry completed")])
		fake.fireAgentSettled()

		expect(await turn).toMatchObject({
			text: "retry completed",
			submitted: { tool: SUBMIT_RESULT_TOOL, arguments: { result: { grade: "A" } } },
		})
		expect((await turn).error).toBeUndefined()
		session.dispose()
		expect(fake.active()).toEqual(["bash", "read"])
	})

	it("takes the latest persisted submission across continuations", async () => {
		const fake = fakePi()
		const session = fake.start(request())
		const turn = watch(session.sendAndAwaitEnd("go"))
		await fake.submit(SUBMIT_RESULT_TOOL, { result: { grade: "B" } })
		fake.fireAgentEnd([okAttempt("first submission")])
		fake.fireAgentStart()
		await fake.submit(SUBMIT_RESULT_TOOL, { result: { grade: "A" } })
		fake.fireAgentEnd([okAttempt("revised submission")])
		await flush()
		expect(turn.pending).toBe(true)
		fake.fireAgentSettled()
		await flush()

		expect(turn.turn?.submitted?.arguments).toEqual({ result: { grade: "A" } })
		session.dispose()
		expect(fake.active()).toEqual(["bash", "read"])
	})

	it("does not reuse an invalid result when a repair with the same identity submits nothing", async () => {
		const fake = fakePi()
		const session = fake.start(request())
		const first = session.sendAndAwaitEnd("go")
		await fake.submit(SUBMIT_RESULT_TOOL, { result: { grade: "not an allowed grade" } })
		fake.fireAgentEnd([okAttempt("first submission")])
		fake.fireAgentSettled()
		expect((await first).submitted).toBeDefined()

		// The engine may reject the submitted value through a post-schema assertion and request repair.
		const repair = session.sendAndAwaitEnd("Grade must be A or B; try again.")
		fake.fireAgentEnd([okAttempt("no submission this time")])
		fake.fireAgentSettled()
		expect((await repair).submitted).toBeUndefined()
		session.dispose()
		expect(fake.active()).toEqual(["bash", "read"])
	})

	it("settles cancellation during retry backoff without surfacing the transient provider error", async () => {
		const fake = fakePi()
		const controller = new AbortController()
		const session = fake.start(request({ signal: controller.signal }))
		const turn = watch(session.sendAndAwaitEnd("go"))
		fake.fireAgentEnd([failedAttempt("socket closed")])
		controller.abort()
		await flush()
		expect(turn.pending).toBe(true)
		expect(fake.active()).toContain(SUBMIT_RESULT_TOOL)
		fake.fireAgentSettled()
		await flush()

		expect(turn.turn?.cancelled).toBe(true)
		expect(turn.turn?.error).toBeUndefined()
		expect(turn.turn?.submitted).toBeUndefined()
		session.dispose()
		expect(fake.active()).toEqual(["bash", "read"])
	})
})
