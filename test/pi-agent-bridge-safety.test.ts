import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { describe, expect, it, vi } from "vitest"
import { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "../src/engine/output-tools.ts"
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createAgentStep, createWorkflow } from "../src/flow/index.ts"
import { createPiAgentBridge, type PiAgentControl } from "../src/host/pi-agent.ts"
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts"
import { scriptedSubagent } from "./fake-subagent.ts"
import { agentRequest, createTestHost, tempSessionsDir } from "./helpers.ts"

/** Where the bridge under test writes its step sessions (the real host binds the harness's own session dir). */
const sessionsDir = tempSessionsDir()

/**
 * The bridge's cross-talk safety (spec §2.2), driven directly against a fake PI — no engine, no
 * workflow, just `createPiAgentBridge` and a scriptable `agent_end`/`sendMessage`.
 *
 * Before this fix, `createPiAgentBridge` kept ONE shared mutable `pending` resolver: a second
 * `sendAndAwaitEnd` call while a first was still in flight silently OVERWROTE it, so the single
 * `agent_end` that eventually fired resolved whichever caller happened to be `pending` last — the
 * FIRST caller's promise never settled at all (hung forever), and the SECOND caller was handed a reply
 * that was never its own. These tests reconstruct exactly that interleaving and prove the fix: the
 * second attempt is rejected before it can touch anything shared, and the first is completely unaffected.
 */

/** The shape of a fired `context` event's result — same as `ContextEventResult` (`{ messages?: AgentMessage[] }`). */
type ContextResult = { messages?: unknown[] } | undefined
type SendMessageArgs = Parameters<ExtensionAPI["sendMessage"]>
type SentMessage = {
	message: SendMessageArgs[0]
	options: SendMessageArgs[1]
}
type UserMessage = Parameters<ExtensionAPI["sendUserMessage"]>[0]

function fakePi(scriptedTurns: readonly unknown[] = []): {
	pi: ExtensionAPI
	fireAgentEnd: (text: string) => void
	fireMessageUpdate: (totalTokens: number) => void
	fireContext: (messages: unknown[]) => ContextResult
	sentMessages: SentMessage[]
	userMessages: UserMessage[]
	registeredTools: string[]
	activeTools: () => string[]
} {
	let endHandler: ((event: AgentEndEvent) => void) | undefined
	let messageUpdateHandler: ((event: { message: unknown }) => void) | undefined
	let contextHandler: ((event: { type: "context"; messages: unknown[] }) => ContextResult) | undefined
	const sentMessages: SentMessage[] = []
	const userMessages: UserMessage[] = []
	const registeredTools: string[] = []
	let activeTools: string[] = ["bash", "read"]
	let scriptedTurn = 0
	const pi = {
		on: (event: string, h: (event: never) => unknown) => {
			if (event === "agent_end") endHandler = h as (event: AgentEndEvent) => void
			if (event === "message_update") messageUpdateHandler = h as (event: { message: unknown }) => void
			if (event === "context") contextHandler = h as (event: { type: "context"; messages: unknown[] }) => ContextResult
		},
		sendMessage: (...[message, options]: SendMessageArgs) => {
			sentMessages.push({ message, options })
			const assistant = scriptedTurns[scriptedTurn++]
			if (assistant !== undefined) {
				endHandler?.({
					type: "agent_end",
					messages: [{ role: "custom", ...message, timestamp: Date.now() }, assistant],
				} as unknown as AgentEndEvent)
			}
		},
		sendUserMessage: (message: UserMessage) => {
			userMessages.push(message)
		},
		setModel: async () => true,
		registerTool: (tool: { name: string }) => {
			registeredTools.push(tool.name)
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names]
		},
	} as unknown as ExtensionAPI

	return {
		pi,
		registeredTools,
		activeTools: () => [...activeTools],
		fireAgentEnd: (text: string) => {
			if (!endHandler) throw new Error("test bug: no agent_end handler was registered")
			endHandler({
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text }], usage: { totalTokens: 1 } }],
			} as unknown as AgentEndEvent)
		},
		fireMessageUpdate: (totalTokens: number) => {
			if (!messageUpdateHandler) throw new Error("test bug: no message_update handler was registered")
			messageUpdateHandler({
				message: { role: "assistant", content: [], usage: { totalTokens } },
			})
		},
		fireContext: (messages: unknown[]) => {
			if (!contextHandler) throw new Error("test bug: no context handler was registered")
			return contextHandler({ type: "context", messages })
		},
		sentMessages,
		userMessages,
	}
}

const hiddenMessage = (content: string): SentMessage => ({
	message: { customType: "kimchi-workflow-agent", content, display: false },
	options: { triggerTurn: true },
})

function fakeAgentControl(initialIdle = false) {
	let idle = initialIdle
	let pendingMessages = false
	let abortCalls = 0
	const idleWaiters: Array<() => void> = []
	const control = {
		abort: () => {
			abortCalls++
		},
		hasPendingMessages: () => pendingMessages,
		isIdle: () => idle,
		waitForIdle: () =>
			new Promise<void>((resolve) => {
				idleWaiters.push(resolve)
			}),
	} satisfies PiAgentControl

	return {
		control,
		abortCalls: () => abortCalls,
		setIdle: (value: boolean) => {
			idle = value
		},
		setPendingMessages: (value: boolean) => {
			pendingMessages = value
		},
		resolveWait: (index: number) => {
			const resolve = idleWaiters[index]
			if (!resolve) throw new Error(`test bug: no waitForIdle call at index ${index}`)
			resolve()
		},
		waitCount: () => idleWaiters.length,
	}
}

describe("createPiAgentBridge in-session visibility: framework traffic is model-visible but transcript-hidden", () => {
	it("hides the engine's initial prompt, questionnaire resume, and output repair", async () => {
		const question = {
			questions: [{ key: "backend", header: "Backend", question: "Which backend?", kind: "text" }],
		}
		const assistant = (content: unknown) => ({
			role: "assistant",
			content,
			usage: { totalTokens: 1 },
		})
		const { pi, sentMessages, userMessages } = fakePi([
			assistant([{ type: "toolCall", id: "ask", name: SUBMIT_QUESTIONS_TOOL, arguments: question }]),
			assistant([{ type: "text", text: "I forgot to submit the result." }]),
			assistant([
				{ type: "toolCall", id: "result", name: SUBMIT_RESULT_TOOL, arguments: { result: { backend: "Redis" } } },
			]),
		])
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)
		const output = Type.Object({ backend: Type.String() })
		const workflow = createWorkflow({ name: "hidden-traffic" })
			.then(createAgentStep({ name: "plan", output, asks: true, prompt: () => "Plan the backend." }))
			.commit()
		const { host, store } = createTestHost({ startAgent })

		const blocked = await runWorkflow(workflow, undefined, host)
		expect(blocked.status).toBe("blocked")
		const done = await resumeWithAnswer(workflow, await store.loadEvents(blocked.runId), { backend: "Redis" }, host)

		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ backend: "Redis" })
		expect(sentMessages).toHaveLength(3)
		expect(sentMessages[0]).toEqual(hiddenMessage(expect.stringContaining("Plan the backend.")))
		expect(sentMessages[0]?.message.content).toContain(SUBMIT_QUESTIONS_TOOL)
		expect(sentMessages[1]).toEqual(hiddenMessage(expect.stringContaining("The user answered your questionnaire:")))
		expect(sentMessages[2]).toEqual(
			hiddenMessage(expect.stringContaining("Your previous turn did not submit a valid result.")),
		)
		expect(userMessages).toEqual([])
	})
})

describe("createPiAgentBridge in-session usage updates", () => {
	it("reports each distinct confirmed cumulative snapshot and leaves final usage authoritative", async () => {
		const { pi, fireAgentEnd, fireMessageUpdate } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)
		const session = startAgent(agentRequest({ stepName: "streaming" }))
		const observed: number[] = []

		const turn = session.sendAndAwaitEnd("go", { onUsage: (usage) => observed.push(usage.totalTokens) })
		fireMessageUpdate(0)
		fireMessageUpdate(100)
		fireMessageUpdate(100)
		fireMessageUpdate(120)
		fireAgentEnd("done")

		await expect(turn).resolves.toEqual({ text: "done", usage: { totalTokens: 1 } })
		expect(observed).toEqual([100, 120])
	})

	it("does not let a usage observer failure interrupt the PI turn", async () => {
		const { pi, fireAgentEnd, fireMessageUpdate } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)
		const session = startAgent(agentRequest({ stepName: "streaming" }))

		const turn = session.sendAndAwaitEnd("go", {
			onUsage: () => {
				throw new Error("display failed")
			},
		})
		expect(() => fireMessageUpdate(100)).not.toThrow()
		fireAgentEnd("done")
		await expect(turn).resolves.toEqual({ text: "done", usage: { totalTokens: 1 } })
	})
})

function fakeModelRegistry(): ModelRegistry {
	return { find: () => undefined } as unknown as ModelRegistry
}

describe("createPiAgentBridge in-session safety (spec §2.2): two concurrent turns can never cross-talk", () => {
	it("a second in-session turn attempted while one is in flight is rejected loudly and specifically, never silently swapped in", async () => {
		const { pi, fireAgentEnd, sentMessages } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)

		const stepA = startAgent(agentRequest({ stepName: "step-a" }))
		const stepB = startAgent(agentRequest({ stepName: "step-b" }))

		// Step A starts its in-session turn through a hidden custom message and stays pending.
		const turnA = stepA.sendAndAwaitEnd("prompt from A")

		// Step B attempts a SECOND in-session turn while A's is still in flight — the exact interleaving the
		// old shared `pending` variable could not survive.
		await expect(stepB.sendAndAwaitEnd("prompt from B")).rejects.toThrow(/step "step-b".*step "step-a".*in flight/s)

		// B's message was never sent to PI at all — the rejection happens before any side effect, so PI
		// itself never sees a second concurrent hidden message.
		expect(sentMessages).toEqual([hiddenMessage("prompt from A")])

		// A's turn is completely unaffected: firing the ONE real `agent_end` resolves A with A's OWN reply.
		fireAgentEnd("reply for A")
		await expect(turnA).resolves.toEqual({ text: "reply for A", usage: { totalTokens: 1 } })
	})

	it("never resolves one step's turn with another step's reply, regardless of send order", async () => {
		const { pi, fireAgentEnd } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)

		const stepA = startAgent(agentRequest({ stepName: "step-a" }))
		const stepB = startAgent(agentRequest({ stepName: "step-b" }))

		const turnA = stepA.sendAndAwaitEnd("prompt from A")
		const rejectedTurnB = stepB.sendAndAwaitEnd("prompt from B").catch((err: Error) => err)

		fireAgentEnd("reply for A")

		const [resolvedA, resultB] = await Promise.all([turnA, rejectedTurnB])
		expect(resolvedA).toEqual({ text: "reply for A", usage: { totalTokens: 1 } })
		expect(resultB).toBeInstanceOf(Error) // B never got A's reply — it got its own clear rejection instead
	})

	it("after A's turn settles, a fresh in-session turn is accepted normally (the guard is not sticky)", async () => {
		const { pi, fireAgentEnd, sentMessages } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)

		const stepA = startAgent(agentRequest({ stepName: "step-a" }))
		const turnA = stepA.sendAndAwaitEnd("prompt from A")
		fireAgentEnd("reply for A")
		await expect(turnA).resolves.toEqual({ text: "reply for A", usage: { totalTokens: 1 } })

		const stepB = startAgent(agentRequest({ stepName: "step-b" }))
		const turnB = stepB.sendAndAwaitEnd("prompt from B")
		fireAgentEnd("reply for B")
		await expect(turnB).resolves.toEqual({ text: "reply for B", usage: { totalTokens: 1 } })

		expect(sentMessages).toEqual([hiddenMessage("prompt from A"), hiddenMessage("prompt from B")])
	})

	it("dispose() only clears a session's OWN in-flight turn, never a sibling's", async () => {
		const { pi, fireAgentEnd } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)

		const stepA = startAgent(agentRequest({ stepName: "step-a" }))
		const stepB = startAgent(agentRequest({ stepName: "step-b" })) // never starts a turn

		const turnA = stepA.sendAndAwaitEnd("prompt from A")
		stepB.dispose() // must be a no-op w.r.t. A's in-flight turn

		fireAgentEnd("reply for A")
		await expect(turnA).resolves.toEqual({ text: "reply for A", usage: { totalTokens: 1 } })
	})

	it("background and isolated requests never touch the shared in-session guard (both go through the subprocess path)", async () => {
		const { pi, sentMessages } = fakePi()
		const { spawn, calls } = scriptedSubagent("")
		const startAgent = createPiAgentBridge(
			pi,
			(args) => ({ command: "pi", args }),
			spawn,
		)(fakeModelRegistry(), sessionsDir)

		await startAgent(agentRequest({ stepName: "bg", background: true })).sendAndAwaitEnd("go")
		await startAgent(agentRequest({ stepName: "fan", isolated: true })).sendAndAwaitEnd("go")

		expect(calls).toHaveLength(2) // both routed to the subprocess path
		expect(sentMessages).toEqual([]) // neither ever called `pi.sendUserMessage`
	})
})

describe("createPiAgentBridge in-session lifecycle fallback", () => {
	it("rejects and releases a turn when PI becomes idle without emitting agent_end", async () => {
		vi.useFakeTimers()
		try {
			const { pi, fireAgentEnd } = fakePi()
			const lifecycle = fakeAgentControl()
			const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir, lifecycle.control)
			const first = startAgent(agentRequest({ stepName: "missing-event" }))
			const turn = first.sendAndAwaitEnd("go")
			const rejected = expect(turn).rejects.toThrow(
				/step "missing-event" became idle without emitting agent_end.*send_message.*extension-error/s,
			)

			expect(lifecycle.waitCount()).toBe(1)
			lifecycle.setIdle(true)
			lifecycle.resolveWait(0)
			await vi.runAllTimersAsync()
			await rejected

			// The missing event cannot leave the bridge wedged: a later turn enters normally.
			lifecycle.setIdle(false)
			const next = startAgent(agentRequest({ stepName: "next" })).sendAndAwaitEnd("continue")
			fireAgentEnd("recovered")
			await expect(next).resolves.toEqual({ text: "recovered", usage: { totalTokens: 1 } })
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not mistake the previous run's idle boundary for a queued repair turn completing", async () => {
		vi.useFakeTimers()
		try {
			const { pi, fireAgentEnd } = fakePi()
			const lifecycle = fakeAgentControl()
			const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir, lifecycle.control)
			const session = startAgent(agentRequest({ stepName: "repair" }))

			const initial = session.sendAndAwaitEnd("initial")
			fireAgentEnd("invalid output")
			await initial

			// PI is still finishing the initial run when an `agent_end` handler queues the repair. The
			// repair's first wait therefore observes that old run becoming idle, then PI starts the queued
			// continuation before the next task. It must keep waiting for the repair's own lifecycle.
			const repair = session.sendAndAwaitEnd("repair")
			expect(lifecycle.waitCount()).toBe(2)
			lifecycle.resolveWait(0) // the initial turn's stale watcher cannot settle this new turn
			await Promise.resolve()
			lifecycle.setIdle(true)
			lifecycle.resolveWait(1)
			lifecycle.setIdle(false)
			await vi.runOnlyPendingTimersAsync()

			expect(lifecycle.waitCount()).toBe(3)
			const stillPending = vi.fn()
			void repair.then(stillPending, stillPending)
			await Promise.resolve()
			expect(stillPending).not.toHaveBeenCalled()

			fireAgentEnd("valid output")
			await expect(repair).resolves.toEqual({ text: "valid output", usage: { totalTokens: 1 } })
		} finally {
			vi.useRealTimers()
		}
	})

	it("aborts PI on cancellation but holds the guard until the live operation is actually idle", async () => {
		vi.useFakeTimers()
		try {
			const { pi } = fakePi()
			const lifecycle = fakeAgentControl()
			const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir, lifecycle.control)
			const abortController = new AbortController()
			const active = startAgent(agentRequest({ stepName: "cancelled", signal: abortController.signal }))
			const turn = active.sendAndAwaitEnd("go")
			const rejected = expect(turn).rejects.toThrow(/became idle without emitting agent_end/)

			abortController.abort()
			expect(lifecycle.abortCalls()).toBe(1)
			await expect(startAgent(agentRequest({ stepName: "too-early" })).sendAndAwaitEnd("overlap")).rejects.toThrow(
				/step "cancelled"'s turn is still in flight/,
			)

			lifecycle.setIdle(true)
			lifecycle.resolveWait(0)
			await vi.runAllTimersAsync()
			await rejected
		} finally {
			vi.useRealTimers()
		}
	})
})

/**
 * Cross-restart history seeding (spec §8.4), driven the same way: no engine, no real PI — just the
 * bridge and a scriptable `context`/`agent_end`. `pi-agent-messages.test.ts` covers `seedHistory`
 * itself (the pure array-prepend) offline; these prove the bridge actually WIRES that pure function
 * into PI's `context` event for the right session, and only for the right session.
 */
describe("createPiAgentBridge history seeding (spec §8.4): an answer-resume's stored conversation reaches the model", () => {
	const history = [
		{ role: "user", content: [{ type: "text", text: "original prompt" }] },
		{ role: "assistant", content: [{ type: "text", text: "what backend?" }] },
	]

	it("prepends the resumed session's history onto every outgoing `context` call, across repeated turns in that session", async () => {
		const { pi, fireContext, fireAgentEnd } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)

		const resumed = startAgent(agentRequest({ stepName: "plan", history }))

		const turnA = resumed.sendAndAwaitEnd("answered: Redis")
		expect(fireContext([{ role: "user", content: "answered: Redis" }])).toEqual({
			messages: [...history, { role: "user", content: "answered: Redis" }],
		})
		fireAgentEnd("planning with Redis")
		await turnA

		// A second turn in the SAME session (e.g. a steering repair) still gets the seed — PI's own
		// accumulated session state does not fold the injected prefix back in, so it must be re-applied.
		const turnB = resumed.sendAndAwaitEnd("please reply as JSON")
		expect(fireContext([{ role: "user", content: "please reply as JSON" }])).toEqual({
			messages: [...history, { role: "user", content: "please reply as JSON" }],
		})
		fireAgentEnd('{"steps":["a"]}')
		await turnB
	})

	it("leaves a fresh (no-history) session's `context` calls untouched — no regression to the common in-process path", async () => {
		const { pi, fireContext, fireAgentEnd } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)

		const fresh = startAgent(agentRequest({ stepName: "plan" })) // no `history` — the ordinary fresh-run request
		const turn = fresh.sendAndAwaitEnd("fresh prompt")

		expect(fireContext([{ role: "user", content: "fresh prompt" }])).toBeUndefined()

		fireAgentEnd("reply")
		await turn
	})

	it("stops seeding once the session disposes, so a later fresh session is never contaminated by a stale seed", async () => {
		const { pi, fireContext, fireAgentEnd } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)

		const resumed = startAgent(agentRequest({ stepName: "plan", history }))
		const turnA = resumed.sendAndAwaitEnd("answered: Redis")
		fireAgentEnd("planning with Redis")
		await turnA
		resumed.dispose()

		const next = startAgent(agentRequest({ stepName: "plan" })) // a later, unrelated fresh session
		const turnB = next.sendAndAwaitEnd("next prompt")
		expect(fireContext([{ role: "user", content: "next prompt" }])).toBeUndefined() // no leftover seed
		fireAgentEnd("reply")
		await turnB
	})

	it("dispose() only clears a session's OWN history seed, never a sibling's (mirrors the in-flight guard)", async () => {
		const { pi, fireContext, fireAgentEnd } = fakePi()
		const startAgent = createPiAgentBridge(pi)(fakeModelRegistry(), sessionsDir)

		const resumed = startAgent(agentRequest({ stepName: "plan", history }))
		const other = startAgent(agentRequest({ stepName: "other" })) // never starts a turn, has no history of its own
		other.dispose() // must be a no-op w.r.t. `resumed`'s active seed

		const turn = resumed.sendAndAwaitEnd("answered: Redis")
		expect(fireContext([{ role: "user", content: "answered: Redis" }])).toEqual({
			messages: [...history, { role: "user", content: "answered: Redis" }],
		})
		fireAgentEnd("planning with Redis")
		await turn
	})
})
