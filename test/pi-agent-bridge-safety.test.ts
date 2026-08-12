import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "../src/engine/output-tools.ts"
import { resumeWithAnswer } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import { createAgentStep, createWorkflow } from "../src/flow/index.ts"
import { createPiAgentBridge } from "../src/host/pi-agent.ts"
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
	fireContext: (messages: unknown[]) => ContextResult
	sentMessages: SentMessage[]
	userMessages: UserMessage[]
	registeredTools: string[]
	activeTools: () => string[]
} {
	let endHandler: ((event: AgentEndEvent) => void) | undefined
	let contextHandler: ((event: { type: "context"; messages: unknown[] }) => ContextResult) | undefined
	const sentMessages: SentMessage[] = []
	const userMessages: UserMessage[] = []
	const registeredTools: string[] = []
	let activeTools: string[] = ["bash", "read"]
	let scriptedTurn = 0
	const pi = {
		on: (event: string, h: (event: AgentEndEvent | { type: "context"; messages: unknown[] }) => unknown) => {
			if (event === "agent_end") endHandler = h as (event: AgentEndEvent) => void
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
