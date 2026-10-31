/**
 * Live step activity (inspection, specs/progress-ui.md §14) — the process-local channel between the
 * two capture sites (the bridge's shared listeners for in-session turns, the subagent's NDJSON stream
 * for isolated ones) and whichever surface is watching.
 *
 * Pure bookkeeping and parsing only, so everything here runs offline: the bus's subscription and
 * bounding rules, the summary bounding (a chatty tool must not cost the panel a paragraph), the stream
 * normalizer's tolerance of both event spellings, and — through the real bridge, against the fake
 * subagent and a fake PI — that attribution follows the step whose turn is actually in flight.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createPiAgentBridge } from "../src/host/pi-agent.ts"
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts"
import {
	activityFromStreamEvent,
	createActivityBus,
	type StepActivity,
	summarizeHead,
	summarizeTail,
	summarizeToolArguments,
	summarizeToolResult,
} from "../src/host/step-activity.ts"
import { loadStepTranscript, renderStepTranscript } from "../src/host/step-transcript.ts"
import { scriptedSubagent } from "./fake-subagent.ts"
import { agentRequest, tempSessionsDir } from "./helpers.ts"

/** Where the bridge under test writes its step sessions (the real host binds the harness's own session dir). */
const sessionsDir = tempSessionsDir()

const IDENTITY = { runId: "workflow-test-1a2b3c4d", path: "build", attempt: 1 }
const AT = "2026-10-30T00:00:00.000Z"

describe("activity bus (inspection §14)", () => {
	it("delivers published activity to the run's subscribers, oldest first", () => {
		const bus = createActivityBus()
		const seen: StepActivity[] = []
		const unsubscribe = bus.subscribe(IDENTITY.runId, (activity) => seen.push(activity))

		const first: StepActivity = { ...IDENTITY, at: AT, kind: "tool-start", toolName: "bash" }
		const second: StepActivity = { ...IDENTITY, at: AT, kind: "tool-end", toolName: "bash" }
		bus.publish(first)
		bus.publish(second)

		expect(seen).toEqual([first, second])
		expect(bus.recent(IDENTITY.runId)).toEqual([first, second])
		unsubscribe()
	})

	it("keeps one run's activity away from another run's subscribers", () => {
		const bus = createActivityBus()
		const seen: string[] = []
		bus.subscribe("run-a", (activity) => seen.push(activity.path))

		bus.publish({ runId: "run-a", path: "step-a", attempt: 1, at: AT, kind: "tool-start", toolName: "bash" })
		bus.publish({ runId: "run-b", path: "step-b", attempt: 1, at: AT, kind: "tool-start", toolName: "bash" })

		expect(seen).toEqual(["step-a"])
	})

	it("stops delivering after the unsubscribe, and a re-subscriber replays the ring", () => {
		const bus = createActivityBus()
		const seen: StepActivity[] = []
		const unsubscribe = bus.subscribe(IDENTITY.runId, (activity) => seen.push(activity))
		const one: StepActivity = { ...IDENTITY, at: AT, kind: "tool-start", toolName: "bash" }
		bus.publish(one)
		unsubscribe()
		bus.publish({ ...IDENTITY, at: AT, kind: "tool-end", toolName: "bash" })

		expect(seen).toEqual([one])
		// The ring is what a view opened mid-step replays before going live — it outlives the subscriber.
		expect(bus.recent(IDENTITY.runId).map((activity) => activity.kind)).toEqual(["tool-start", "tool-end"])
	})

	it("bounds the ring: the 201st entry drops the oldest, and clear() empties it", () => {
		const bus = createActivityBus()
		for (let i = 0; i < 201; i++) {
			bus.publish({ ...IDENTITY, at: AT, kind: "tool-start", summary: String(i) })
		}
		const recent = bus.recent(IDENTITY.runId)
		expect(recent).toHaveLength(200)
		expect(recent[0]?.summary).toBe("1") // index 0 was dropped, not the newest

		bus.clear(IDENTITY.runId)
		expect(bus.recent(IDENTITY.runId)).toEqual([])
	})

	it("drops an unwatched run's ring once nine runs have published — never a watched one's", () => {
		const bus = createActivityBus()
		const unsubscribeOldest = bus.subscribe("run-0", () => {}) // someone is watching run-0
		for (let i = 0; i < 9; i++) {
			bus.publish({ runId: `run-${i}`, path: "step", attempt: 1, at: AT, kind: "tool-start", toolName: "bash" })
		}
		// run-1 (the oldest with NO subscriber) went, not run-0 — a run someone is watching keeps its
		// replayable history for a view opened mid-step.
		expect(bus.recent("run-0")).toHaveLength(1)
		expect(bus.recent("run-1")).toEqual([])
		expect(bus.recent("run-8")).toHaveLength(1)
		unsubscribeOldest()
	})

	it("never lets a throwing listener break the publish", () => {
		const bus = createActivityBus()
		bus.subscribe(IDENTITY.runId, () => {
			throw new Error("a display callback must not break the agent stream")
		})
		const seen: StepActivity[] = []
		bus.subscribe(IDENTITY.runId, (activity) => seen.push(activity))

		const one: StepActivity = { ...IDENTITY, at: AT, kind: "tool-start", toolName: "bash" }
		expect(() => bus.publish(one)).not.toThrow()
		expect(seen).toEqual([one])
	})
})

describe("activity summaries (inspection §14): one bounded line, whatever the tool said", () => {
	it("quotes a preferred argument field on its own", () => {
		expect(summarizeToolArguments({ file_path: "src/engine/step-runner.ts", mode: "read" })).toBe(
			"src/engine/step-runner.ts",
		)
		expect(summarizeToolArguments({ command: "npm test", cwd: "." })).toBe("npm test")
		expect(summarizeToolArguments("a bare string argument")).toBe("a bare string argument")
	})

	it("falls back to compact JSON when no preferred field is present", () => {
		expect(summarizeToolArguments({ nested: { deep: true } })).toBe('{"nested":{"deep":true}}')
		expect(summarizeToolArguments(undefined)).toBeUndefined()
		expect(summarizeToolArguments(null)).toBeUndefined()
	})

	it("collapses whitespace and bounds the head at 200 characters", () => {
		const long = `${"a".repeat(250)}`
		const bounded = summarizeToolArguments({ command: long })
		expect(bounded).toHaveLength(200)
		expect(bounded?.endsWith("…")).toBe(true)
		expect(summarizeHead(`one\n\ttwo   three`)).toBe("one two three")
		expect(summarizeTail(long)).toHaveLength(200)
		expect(summarizeTail(long)?.startsWith("…")).toBe(true) // the tail, not the head
	})

	it("summarizes a result's output field, or its JSON, on one line", () => {
		expect(summarizeToolResult({ output: "3 files changed" })).toBe("3 files changed")
		expect(summarizeToolResult({ exit: 0, stdout: "ok" })).toBe('{"exit":0,"stdout":"ok"}')
		expect(summarizeToolResult("plain")).toBe("plain")
		expect(summarizeToolResult(undefined)).toBeUndefined()
	})

	it("bounds a result at the TAIL — a failure's detail is at the end, where it lands", () => {
		const long = `${"ok ".repeat(100)}then: exit 1, EACCES denied`
		const summary = summarizeToolResult(long)
		expect(summary?.startsWith("…")).toBe(true)
		expect(summary?.endsWith("then: exit 1, EACCES denied")).toBe(true)
	})

	it("strips the control bytes a terminal would execute — an ESC in tool output is not ours to pass on", () => {
		const evil = "clean \u001b]52;c;aGF4ZWQ=\u0007 also \u001b[31mred\u001b[0m and \u0007bel"
		expect(summarizeHead(evil)).not.toContain("\u001b")
		expect(summarizeTail(evil)).not.toContain("\u001b")
		expect(summarizeHead(evil)).not.toContain("\u0007")
		expect(summarizeToolResult(evil)).toBe("clean ]52;c;aGF4ZWQ= also [31mred[0m and bel")
	})
})

describe("stream normalization (inspection §14): both event spellings, unknown lines ignored", () => {
	it("maps tool_execution_start to a tool-start with its arguments summarized", () => {
		expect(
			activityFromStreamEvent(
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { file_path: "src/x.ts" } },
				IDENTITY,
				AT,
			),
		).toEqual({ ...IDENTITY, at: AT, kind: "tool-start", toolName: "read", summary: "src/x.ts" })
	})

	it("accepts the tool_call spelling and its name/arguments fields", () => {
		expect(
			activityFromStreamEvent({ type: "tool_call", name: "bash", arguments: { command: "ls" } }, IDENTITY, AT),
		).toEqual({ ...IDENTITY, at: AT, kind: "tool-start", toolName: "bash", summary: "ls" })
	})

	it("maps tool_execution_end and tool_result to a tool-end carrying the error flag", () => {
		expect(
			activityFromStreamEvent(
				{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "exit 1", isError: true },
				IDENTITY,
				AT,
			),
		).toEqual({ ...IDENTITY, at: AT, kind: "tool-end", toolName: "bash", summary: "exit 1", isError: true })
		expect(
			activityFromStreamEvent({ type: "tool_result", name: "bash", result: "ok", isError: false }, IDENTITY, AT)
				?.isError,
		).toBe(false)
	})

	it("maps an assistant message_end to a bounded text tail, and ignores everything else", () => {
		expect(
			activityFromStreamEvent(
				{
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "all done" }] },
				},
				IDENTITY,
				AT,
			),
		).toEqual({ ...IDENTITY, at: AT, kind: "assistant-text", summary: "all done" })
		expect(
			activityFromStreamEvent({ type: "message_end", message: { role: "toolResult", content: [] } }, IDENTITY, AT),
		).toBeUndefined()
		expect(activityFromStreamEvent({ type: "turn_start", turnIndex: 1 }, IDENTITY, AT)).toBeUndefined()
		expect(activityFromStreamEvent("not an event", IDENTITY, AT)).toBeUndefined()
		expect(activityFromStreamEvent(null, IDENTITY, AT)).toBeUndefined()
	})
})

// -- Through the real bridge ------------------------------------------------------------------------------------

/** A fixed invocation so assertions stay independent of the live test runner's own process. */
const fixedResolver = (args: readonly string[]) => ({ command: "pi", args })

const noopPi = { on: () => {} } as unknown as ExtensionAPI

function fakeModelRegistry(): ModelRegistry {
	return { find: () => undefined } as unknown as ModelRegistry
}

describe("background step activity through the real bridge (inspection §14)", () => {
	it("publishes the subprocess's tool calls and assistant text under the step's identity", async () => {
		const bus = createActivityBus()
		const stdout = [
			'{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":{"file_path":"src/x.ts"}}',
			'{"type":"tool_execution_end","toolCallId":"t1","toolName":"read","result":{"output":"contents"}}',
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"totalTokens":5}}}',
			"",
		].join("\n")
		const { spawn } = scriptedSubagent(stdout)
		const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn, bus)(fakeModelRegistry(), sessionsDir)

		const request = agentRequest({ stepName: "bg", background: true })
		const turn = await startAgent(request).sendAndAwaitEnd("do the task")
		expect(turn.text).toBe("done") // the reader's real job is untouched by the hook

		expect(bus.recent(request.runId).map((activity) => [activity.kind, activity.toolName])).toEqual([
			["tool-start", "read"],
			["tool-end", "read"],
			["assistant-text", undefined],
		])
		for (const activity of bus.recent(request.runId)) {
			expect(activity.path).toBe("bg")
			expect(activity.attempt).toBe(1)
		}
	})

	it("captures nothing when no bus is bound — every pre-existing behaviour unchanged", async () => {
		const { spawn, calls } = scriptedSubagent(
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
		)
		const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry(), sessionsDir)

		const turn = await startAgent(agentRequest({ stepName: "bg", background: true })).sendAndAwaitEnd("go")
		expect(turn.text).toBe("ok")
		expect(calls.length).toBe(1)
	})
})

/**
 * The smallest fake PI an in-session turn needs: `on` captures the shared listeners the bridge
 * registers (the ones under test are `tool_execution_start`/`tool_execution_end`/`message_update`),
 * `sendMessage` accepts the prompt, and the test settles the turn through `agent_end`/`agent_settled`.
 */
function fakeSessionPi() {
	const handlers = new Map<string, (event: never) => void>()
	const pi = {
		on: (event: string, handler: (event: never) => void) => {
			handlers.set(event, handler)
		},
		sendMessage: vi.fn(),
		setModel: vi.fn(async () => true),
		registerTool: vi.fn(),
		setActiveTools: vi.fn(),
		getActiveTools: () => [],
	}
	return {
		pi: pi as unknown as ExtensionAPI,
		fire: (event: string, payload: never) => handlers.get(event)?.(payload),
	}
}

describe("in-session step activity through the real bridge (inspection §14)", () => {
	it("attributes tool events and text to the in-flight turn only", async () => {
		const bus = createActivityBus()
		const { pi, fire } = fakeSessionPi()
		const startAgent = createPiAgentBridge(pi, fixedResolver, undefined, bus)(fakeModelRegistry(), sessionsDir)

		const request = agentRequest({ stepName: "inline" })
		const session = startAgent(request)
		const turnPromise = session.sendAndAwaitEnd("do the work")

		// The prompt's own message_end — the agent loop emits one per prompt — starts the sidecar.
		fire("message_end", {
			message: { role: "custom", customType: "kimchi-workflow-agent", content: "do the work", display: false },
		} as never)
		fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "npm test" },
		} as never)
		fire("message_update", {
			message: { role: "assistant", content: [{ type: "text", text: "running the tests" }] },
		} as never)
		fire("message_end", {
			message: { role: "assistant", content: [{ type: "text", text: "running the tests" }] },
		} as never)
		fire("agent_end", { messages: [] } as never)
		fire("agent_settled", { type: "agent_settled" } as never)
		const turn = await turnPromise

		expect(turn.text).toBe("")
		expect(bus.recent(request.runId).map((activity) => activity.kind)).toEqual(["tool-start", "assistant-text"])
		expect(bus.recent(request.runId)[0]).toMatchObject({ toolName: "bash", summary: "npm test", path: "inline" })

		// The turn has settled: a tool event now is the user's own activity, not ours to attribute.
		fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "read",
			args: { file_path: "y.ts" },
		} as never)
		expect(bus.recent(request.runId).map((activity) => activity.kind)).toEqual(["tool-start", "assistant-text"])
		session.dispose()

		// The transcript sidecar (step-transcript.ts): the prompt and the turn's messages, in the same
		// session-file shape an isolated step's subprocess writes, under the trace naming rule.
		const transcript = loadStepTranscript({
			dir: sessionsDir,
			workflowName: request.workflowName,
			runId: request.runId,
			path: request.path,
			attempt: request.attempt,
		})
		expect(transcript.ok).toBe(true)
		if (transcript.ok) {
			expect(renderStepTranscript(transcript.entries, { width: 60 })).toEqual([
				"  ● prompt     do the work",
				"  ● assistant  running the tests",
			])
		}
	})
})

describe("terminal poke + keyed sidecar stand-down (review round 2)", () => {
	it("clear() delivers one `end` activity to the run's subscribers before dropping the ring", () => {
		const bus = createActivityBus()
		const seen: string[] = []
		bus.subscribe(IDENTITY.runId, (activity) => seen.push(activity.kind))
		bus.publish({ ...IDENTITY, at: AT, kind: "tool-start", toolName: "bash" })

		bus.clear(IDENTITY.runId)

		// The watcher heard the run end, and the ring is gone — a view opened afterwards replays nothing.
		expect(seen).toEqual(["tool-start", "end"])
		expect(bus.recent(IDENTITY.runId)).toEqual([])
	})

	it("a second in-session session on the same resume key stands its sidecar down, and reports why", async () => {
		const bus = createActivityBus()
		const { pi, fire } = fakeSessionPi()
		const startAgent = createPiAgentBridge(pi, fixedResolver, undefined, bus)(fakeModelRegistry(), sessionsDir)

		const first = startAgent(agentRequest({ stepName: "worker", resumeKey: "worker" }))
		const firstTurn = first.sendAndAwaitEnd("do the work")

		// A second session on the SAME key, while the first still holds the claim: no sidecar for it,
		// and the watcher is told why rather than left with a silent gap.
		const second = startAgent(agentRequest({ stepName: "worker", resumeKey: "worker" }))
		expect(
			bus
				.recent("workflow-test-1a2b3c4d")
				.some((a) => a.kind === "notice" && a.summary?.includes("in use by another execution")),
		).toBe(true)

		fire("message_end", {
			message: { role: "custom", customType: "kimchi-workflow-agent", content: "first session", display: false },
		} as never)
		fire("agent_end", { messages: [] } as never)
		fire("agent_settled", { type: "agent_settled" } as never)
		await firstTurn
		first.dispose()
		second.dispose()

		// The claim was released with the first session: a later execution writes the keyed file again.
		const third = startAgent(agentRequest({ stepName: "worker", resumeKey: "worker", attempt: 2 }))
		const thirdTurn = third.sendAndAwaitEnd("round two")
		fire("message_end", {
			message: { role: "custom", customType: "kimchi-workflow-agent", content: "third session", display: false },
		} as never)
		fire("agent_end", { messages: [] } as never)
		fire("agent_settled", { type: "agent_settled" } as never)
		await thirdTurn
		third.dispose()

		const load = loadStepTranscript({
			dir: sessionsDir,
			workflowName: "test",
			runId: "workflow-test-1a2b3c4d",
			path: "worker",
			attempt: 2,
			resumeKey: "worker",
		})
		expect(load.ok).toBe(true)
		if (load.ok) {
			const text = JSON.stringify(load.entries)
			expect(text).toContain("first session")
			expect(text).toContain("third session")
			expect(text).not.toContain("second") // the stood-down session wrote nothing
		}
	})
})
