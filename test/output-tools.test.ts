/**
 * The output-tool contract (engine/output-tools.ts) and the host-side transcript scan that reads a
 * submission back out (host/pi-agent-messages.ts).
 */
import { Type } from "typebox"
import { describe, expect, it } from "vitest"
import {
	isOutputToolName,
	readSubmittedPayload,
	SUBMIT_QUESTIONS_TOOL,
	SUBMIT_RESULT_TOOL,
	submitQuestionsParameters,
	submitResultParameters,
} from "../src/engine/output-tools.ts"
import type { AgentMessages } from "../src/host/pi-agent-messages.ts"
import {
	createAssistantTurnReader,
	lastAssistantText,
	lastAssistantUsage,
	lastSubmittedOutput,
} from "../src/host/pi-agent-messages.ts"

// --- fixtures -------------------------------------------------------------

function text(role: "assistant" | "user", body: string, totalTokens = 1): unknown {
	return { role, content: [{ type: "text", text: body }], usage: { totalTokens } }
}

function toolCall(name: string, args: Record<string, unknown>, trailing?: string, totalTokens = 1): unknown {
	const content: unknown[] = [{ type: "toolCall", id: `call-${name}`, name, arguments: args }]
	if (trailing) content.push({ type: "text", text: trailing })
	return { role: "assistant", content, usage: { totalTokens } }
}

const messages = (...items: unknown[]) => items as AgentMessages

// --- readSubmittedPayload -------------------------------------------------

describe("readSubmittedPayload: the tool identity is the discriminator", () => {
	it("reads workflow_submit_result's `result` argument as a result", () => {
		expect(readSubmittedPayload({ tool: SUBMIT_RESULT_TOOL, arguments: { result: { grade: "A" } } })).toEqual({
			kind: "result",
			value: { grade: "A" },
		})
	})

	it("reads workflow_submit_questions' whole arguments object as a questionnaire", () => {
		const batch = { title: "Scope", questions: [{ key: "db", kind: "text", question: "Which DB?" }] }
		expect(readSubmittedPayload({ tool: SUBMIT_QUESTIONS_TOOL, arguments: batch })).toEqual({
			kind: "questions",
			value: batch,
		})
	})

	it("reports a workflow_submit_result with no `result` key as malformed, not as a result of undefined", () => {
		// `undefined` VALIDATES against a permissive contract, so reporting it as a result would record an
		// empty call as the step's output, indistinguishable from a step that produced nothing.
		expect(readSubmittedPayload({ tool: SUBMIT_RESULT_TOOL, arguments: {} })).toEqual({
			kind: "malformed",
			tool: SUBMIT_RESULT_TOOL,
			reason: "called without a `result` argument",
		})
	})

	it("distinguishes an explicit `result: undefined` from an absent key", () => {
		expect(readSubmittedPayload({ tool: SUBMIT_RESULT_TOOL, arguments: { result: undefined } })).toEqual({
			kind: "result",
			value: undefined,
		})
	})

	it("ignores a tool this contract does not own", () => {
		expect(readSubmittedPayload({ tool: "bash", arguments: { command: "ls" } })).toBeUndefined()
		expect(readSubmittedPayload(undefined)).toBeUndefined()
	})

	it("names exactly the two output tools", () => {
		expect(isOutputToolName(SUBMIT_RESULT_TOOL)).toBe(true)
		expect(isOutputToolName(SUBMIT_QUESTIONS_TOOL)).toBe(true)
		expect(isOutputToolName("write")).toBe(false)
	})
})

describe("tool parameter schemas", () => {
	it("wraps the step's schema under `result`, so a non-object contract is still legal tool parameters", () => {
		const params = submitResultParameters(Type.String()) as { type: string; properties: Record<string, unknown> }
		expect(params.type).toBe("object")
		expect(params.properties.result).toEqual({ type: "string" })
	})

	it("survives the JSON round-trip the child-process handoff depends on", () => {
		const original = submitResultParameters(Type.Object({ grade: Type.String() }))
		expect(JSON.parse(JSON.stringify(original))).toEqual(original)
	})

	it("uses the framework-owned questionnaire schema unchanged", () => {
		expect(submitQuestionsParameters()).toMatchObject({ type: "object" })
	})
})

// --- transcript scanning --------------------------------------------------

describe("lastSubmittedOutput: last write wins", () => {
	it("takes the LAST submission when the model submits more than once", () => {
		const seen = lastSubmittedOutput(
			messages(
				toolCall(SUBMIT_RESULT_TOOL, { result: "first" }),
				text("assistant", "on reflection…"),
				toolCall(SUBMIT_RESULT_TOOL, { result: "second" }),
			),
		)
		expect(seen).toEqual({ tool: SUBMIT_RESULT_TOOL, arguments: { result: "second" } })
	})

	it("takes the last output tool within a single message carrying several calls", () => {
		const both = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "a", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "b", name: SUBMIT_RESULT_TOOL, arguments: { result: 1 } },
			],
			usage: { totalTokens: 1 },
		}
		expect(lastSubmittedOutput(messages(both))).toEqual({ tool: SUBMIT_RESULT_TOOL, arguments: { result: 1 } })
	})

	it("is not fooled by an unrelated tool the model happened to call last", () => {
		const seen = lastSubmittedOutput(
			messages(toolCall(SUBMIT_RESULT_TOOL, { result: "kept" }), toolCall("bash", { command: "ls" })),
		)
		expect(seen).toEqual({ tool: SUBMIT_RESULT_TOOL, arguments: { result: "kept" } })
	})

	it("is undefined when nothing was submitted", () => {
		expect(lastSubmittedOutput(messages(text("assistant", "just prose")))).toBeUndefined()
		expect(lastSubmittedOutput(messages())).toBeUndefined()
	})

	it("recovers arguments delivered as a JSON string, as some gateways do", () => {
		const stringArgs = {
			role: "assistant",
			content: [{ type: "toolCall", id: "a", name: SUBMIT_RESULT_TOOL, arguments: '{"result":{"grade":"A"}}' }],
			usage: { totalTokens: 1 },
		}
		expect(lastSubmittedOutput(messages(stringArgs))).toEqual({
			tool: SUBMIT_RESULT_TOOL,
			arguments: { result: { grade: "A" } },
		})
	})

	it("never throws on a malformed assistant message — a throw here would hang the run", () => {
		expect(lastSubmittedOutput(messages({ role: "assistant" }))).toBeUndefined()
		expect(lastSubmittedOutput(messages({ role: "assistant", content: "not-an-array" }))).toBeUndefined()
	})

	it("survives every malformed shape a child's stdout can deliver", () => {
		// `"role" in x` throws on a primitive. On the in-session path that throw happens while building the
		// value a turn resolves with, so the turn never settles; on the background path it escapes a stream
		// listener as an uncaughtException. Every reader has to tolerate the same inputs.
		const shapes: unknown[] = [
			"junk",
			42,
			null,
			undefined,
			{ role: "assistant" },
			{ role: "assistant", content: "text" },
			{ role: "assistant", content: [null, undefined] },
			{ role: "assistant", content: [], usage: "nope" },
		]
		for (const shape of shapes) {
			expect(() => lastAssistantText(messages(shape))).not.toThrow()
			expect(() => lastAssistantUsage(messages(shape))).not.toThrow()
			expect(() => lastSubmittedOutput(messages(shape))).not.toThrow()
			// A good message AFTER a malformed one: the scan must reach past the junk without throwing.
			expect(() => lastSubmittedOutput(messages(shape, text("assistant", "ok")))).not.toThrow()
			expect(() => lastSubmittedOutput(messages(text("assistant", "ok"), shape))).not.toThrow()
		}
		for (const notAnArray of [undefined, null, "messages"] as unknown[]) {
			expect(() => lastAssistantText(notAnArray as never)).not.toThrow()
			expect(() => lastAssistantUsage(notAnArray as never)).not.toThrow()
			expect(() => lastSubmittedOutput(notAnArray as never)).not.toThrow()
		}
	})

	it("does not let a primitive message off a subagent's stdout hang the reader", () => {
		// `runSubagent` calls push() from a stream `data` listener — a throw there is an uncaughtException
		// and the step never settles.
		const reader = createAssistantTurnReader()
		expect(() => {
			reader.push(`${JSON.stringify({ type: "message_end", message: "assistant said this" })}\n`)
			reader.push(`${JSON.stringify({ type: "message_end", message: 7 })}\n`)
			reader.push(`${JSON.stringify({ type: "message_end", message: null })}\n`)
		}).not.toThrow()
		expect(reader.end().text).toBe("")
	})

	it("tolerates a malformed arguments payload rather than throwing", () => {
		const broken = {
			role: "assistant",
			content: [{ type: "toolCall", id: "a", name: SUBMIT_RESULT_TOOL, arguments: "not-an-object" }],
			usage: { totalTokens: 1 },
		}
		expect(lastSubmittedOutput(messages(broken))).toEqual({ tool: SUBMIT_RESULT_TOOL, arguments: {} })
	})
})

// --- the streaming reader -------------------------------------------------

describe("createAssistantTurnReader: submissions off a subagent's stdout", () => {
	const line = (message: unknown) => JSON.stringify({ type: "message_end", message })

	function readChunked(ndjson: string, size: number) {
		const reader = createAssistantTurnReader()
		for (let i = 0; i < ndjson.length; i += size) reader.push(ndjson.slice(i, i + size))
		return reader.end()
	}

	it("recovers a submission made before displacing prose", () => {
		const ndjson = [
			line(toolCall(SUBMIT_RESULT_TOOL, { result: { grade: "B" } }, undefined, 4)),
			line(text("assistant", "I have submitted the grade.", 2)),
		].join("\n")

		const turn = readChunked(ndjson, 1000)
		expect(turn.submitted).toEqual({ tool: SUBMIT_RESULT_TOOL, arguments: { result: { grade: "B" } } })
		expect(turn.text).toBe("I have submitted the grade.")
	})

	it("gives the same submission however the stream is chopped up", () => {
		const ndjson = [
			line(toolCall(SUBMIT_QUESTIONS_TOOL, { questions: [{ key: "k", kind: "text", question: "?" }] }, undefined, 3)),
			line(text("assistant", "waiting ✓ ünïcøde", 1)),
		].join("\n")

		for (const size of [1, 2, 7, 64, 4096]) {
			expect(readChunked(ndjson, size).submitted).toEqual({
				tool: SUBMIT_QUESTIONS_TOOL,
				arguments: { questions: [{ key: "k", kind: "text", question: "?" }] },
			})
		}
	})

	it("keeps the LAST submission and a bounded tail of texts, whatever came before", () => {
		const noise = Array.from({ length: 5_000 }, (_, i) => line(text("assistant", `turn ${i}`, 1)))
		const ndjson = [
			line(toolCall(SUBMIT_RESULT_TOOL, { result: "early" })),
			...noise,
			line(toolCall(SUBMIT_RESULT_TOOL, { result: "final" })),
			line(text("assistant", "done", 1)),
		].join("\n")

		const turn = readChunked(ndjson, 4096)
		expect(turn.submitted).toEqual({ tool: SUBMIT_RESULT_TOOL, arguments: { result: "final" } })
		expect(turn.text).toBe("done")
	})

	it("reports no submission when the subagent only ever spoke in text", () => {
		expect(readChunked(line(text("assistant", "plain", 1)), 4096).submitted).toBeUndefined()
	})

	it("reports no text for a tool-call-only final message, never the previous message's", () => {
		// A contract-free step's output IS turn.text, so carrying earlier prose forward would hand a child
		// killed mid-tool-call some stale mid-turn commentary as its result.
		const ndjson = [
			line(text("assistant", "thinking out loud", 3)),
			line(toolCall(SUBMIT_RESULT_TOOL, { result: 1 }, undefined, 4)),
		].join("\n")

		expect(readChunked(ndjson, 4096).text).toBe("")
	})

	it("keeps a tool-call-only message's usage, so the token budget still sees it", () => {
		const turn = readChunked(line(toolCall(SUBMIT_RESULT_TOOL, { result: 1 }, undefined, 42)), 4096)
		expect(turn.usage).toEqual({ totalTokens: 42 })
	})
})
