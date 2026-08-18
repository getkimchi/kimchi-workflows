import { describe, expect, it } from "vitest"
import {
	type AgentMessages,
	createAssistantTurnReader,
	lastAssistantText,
	lastAssistantUsage,
	lastAssistantWasAborted,
	type ModelRegistry,
	parseNdjsonMessages,
	resolveModel,
	seedHistory,
} from "../src/host/pi-agent-messages.ts"

// The real PI `AgentMessage` / `Model` types carry many fields these pure readers never touch. We feed
// them minimal fixtures via one localized assertion each (no `any`); the readers only read the fields
// asserted below.
const asMessages = (items: readonly object[]): AgentMessages => items as unknown as AgentMessages
type FoundModel = ReturnType<ModelRegistry["find"]>

// -- resolveModel (fake ModelRegistry) --------------------------------------------------------------

describe("resolveModel", () => {
	const hit = { id: "kimchi-dev/kimi-k2.7" } as unknown as FoundModel
	function fakeRegistry() {
		const calls: [string, string][] = []
		const find = (provider: string, modelId: string): FoundModel => {
			calls.push([provider, modelId])
			return provider === "kimchi-dev" && modelId === "kimi-k2.7" ? hit : undefined
		}
		return { calls, find }
	}

	it("splits provider/modelId and returns the registry hit", () => {
		const registry = fakeRegistry()
		expect(resolveModel(registry, "kimchi-dev/kimi-k2.7")).toBe(hit)
		expect(registry.calls).toEqual([["kimchi-dev", "kimi-k2.7"]])
	})

	it("returns undefined for an unresolvable model (registry miss)", () => {
		const registry = fakeRegistry()
		expect(resolveModel(registry, "kimchi-dev/nope")).toBeUndefined()
	})

	it("returns undefined without querying the registry when there is no slash", () => {
		const registry = fakeRegistry()
		expect(resolveModel(registry, "kimi-k2.7")).toBeUndefined()
		expect(registry.calls).toEqual([])
	})
})

// -- lastAssistantText ------------------------------------------------------------------------------

describe("lastAssistantText", () => {
	it("returns empty string when there is no assistant message", () => {
		expect(lastAssistantText(asMessages([]))).toBe("")
		expect(lastAssistantText(asMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }]))).toBe("")
	})

	it("concatenates multi-part text content, ignoring non-text parts", () => {
		const messages = asMessages([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Hello " },
					{ type: "tool_use", id: "1" },
					{ type: "text", text: "world" },
				],
				usage: { totalTokens: 5 },
			},
		])
		expect(lastAssistantText(messages)).toBe("Hello world")
	})

	it("picks the LAST assistant message among mixed roles", () => {
		const messages = asMessages([
			{ role: "assistant", content: [{ type: "text", text: "first" }], usage: { totalTokens: 1 } },
			{ role: "user", content: [{ type: "text", text: "middle" }] },
			{ role: "assistant", content: [{ type: "text", text: "second" }], usage: { totalTokens: 2 } },
		])
		expect(lastAssistantText(messages)).toBe("second")
	})
})

// -- lastAssistantUsage -----------------------------------------------------------------------------

describe("lastAssistantUsage", () => {
	it("returns the last assistant message's totalTokens when present", () => {
		const messages = asMessages([
			{ role: "assistant", content: [{ type: "text", text: "a" }], usage: { totalTokens: 10 } },
			{ role: "assistant", content: [{ type: "text", text: "b" }], usage: { totalTokens: 42 } },
		])
		expect(lastAssistantUsage(messages)).toEqual({ totalTokens: 42 })
	})

	it("returns undefined when there is no assistant message", () => {
		expect(lastAssistantUsage(asMessages([]))).toBeUndefined()
		expect(lastAssistantUsage(asMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }]))).toBeUndefined()
	})
})

describe("lastAssistantWasAborted", () => {
	it("recognizes PI's Escape/interrupt stop reason on the last assistant message", () => {
		expect(
			lastAssistantWasAborted(
				asMessages([{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" }]),
			),
		).toBe(true)
		expect(lastAssistantWasAborted(asMessages([{ role: "assistant", content: [], stopReason: "stop" }]))).toBe(false)
	})
})

// -- parseNdjsonMessages (background subagent stdout, spec §2.2) -----------------------------------
//
// Fixture lines shaped exactly like PI's own `--mode json` output (the same `message_end` envelope
// PI's bundled examples/extensions/subagent/index.ts parses off a spawned `pi` process's stdout).

const messageEndLine = (message: object) => JSON.stringify({ type: "message_end", message })
const assistantLine = (text: string, totalTokens: number) =>
	messageEndLine({ role: "assistant", content: [{ type: "text", text }], usage: { totalTokens } })

describe("parseNdjsonMessages", () => {
	it("extracts the message from each message_end line, in order", () => {
		const ndjson = [assistantLine("first", 3), assistantLine("second", 7)].join("\n")

		const messages = parseNdjsonMessages(ndjson)

		expect(lastAssistantText(messages)).toBe("second")
		expect(lastAssistantUsage(messages)).toEqual({ totalTokens: 7 })
	})

	it("ignores non-message_end event types interleaved in the stream", () => {
		const ndjson = [
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({ type: "tool_call", id: "1" }),
			assistantLine("done", 4),
			JSON.stringify({ type: "turn_end" }),
		].join("\n")

		expect(lastAssistantText(parseNdjsonMessages(ndjson))).toBe("done")
	})

	it("skips blank lines and lines that are not valid JSON, rather than failing the whole parse", () => {
		const ndjson = ["", "   ", "not json at all {", assistantLine("ok", 1), ""].join("\n")

		expect(lastAssistantText(parseNdjsonMessages(ndjson))).toBe("ok")
	})

	it("skips a JSON line with no message_end shape (missing type, missing message, or a different type)", () => {
		const ndjson = [
			JSON.stringify({ hello: "world" }),
			JSON.stringify({ type: "message_end" }),
			JSON.stringify(null),
			assistantLine("survives", 2),
		].join("\n")

		expect(lastAssistantText(parseNdjsonMessages(ndjson))).toBe("survives")
	})

	it("returns an empty message list for empty stdout", () => {
		expect(parseNdjsonMessages("")).toEqual([])
	})
})

// -- seedHistory (cross-restart context injection, spec §8.4) --------------------------------------
//
// The pure core of pi-agent.ts's `context`-event history seed: given a blocked step's stored prior
// conversation and the messages a fresh session is about to send (in practice, just the user's answer
// turn — a fresh process's own session has nothing before that), prepend the stored conversation so the
// model sees the whole exchange, not a bare answer with no idea what it is answering.

describe("seedHistory", () => {
	const priorConversation = asMessages([
		{ role: "user", content: [{ type: "text", text: "Plan the task. Ask first if anything is unclear." }] },
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: '{"questions":[{"key":"backend","header":"Backend","question":"Which cache backend?","kind":"text"}]}',
				},
			],
			usage: { totalTokens: 12 },
		},
	])
	const answerTurn = asMessages([
		{ role: "user", content: [{ type: "text", text: 'The user answered your questionnaire:\n- backend: "Redis"' }] },
	])

	it("prepends the stored conversation onto the current turn's messages, given a conversation and an answer", () => {
		const seeded = seedHistory(priorConversation, answerTurn)

		expect(seeded).toEqual([...priorConversation, ...answerTurn])
	})

	it("returns undefined (no-op) when there is no history — a fresh, never-blocked resume is unchanged", () => {
		expect(seedHistory(undefined, answerTurn)).toBeUndefined()
	})

	it("returns undefined (no-op) for an empty stored conversation, same as undefined", () => {
		expect(seedHistory([], answerTurn)).toBeUndefined()
	})
})

/**
 * A background step needs the final assistant turn and nothing else, and must not pay for the rest of
 * the conversation to get it — neither in parsed objects (parsing every message to take the last one
 * grew one run's parent process from 324MB to 1.91GB while it read 367KB, and the container was killed)
 * nor in raw stdout, which is why this reads the stream in pieces instead of taking one string.
 *
 * The pure half is covered here, chunked at deliberately awkward boundaries; that the bridge actually
 * feeds it a live pipe, and retains nothing while doing so, is covered in pi-agent-background.test.ts.
 */
describe("createAssistantTurnReader", () => {
	const end = (role: string, text: string, totalTokens: number) =>
		JSON.stringify({
			type: "message_end",
			message: { role, content: [{ type: "text", text }], usage: { totalTokens } },
		})

	/** The whole transcript as one chunk — a short subagent whose output arrived in a single read. */
	const readAll = (ndjson: string) => {
		const reader = createAssistantTurnReader()
		reader.push(ndjson)
		return reader.end()
	}

	/** The same transcript delivered `size` characters at a time, so lines straddle chunk boundaries. */
	const readChunked = (ndjson: string, size: number) => {
		const reader = createAssistantTurnReader()
		for (let i = 0; i < ndjson.length; i += size) reader.push(ndjson.slice(i, i + size))
		return reader.end()
	}

	it("returns the final assistant turn's text and usage", () => {
		const ndjson = [end("assistant", "first", 1), end("user", "next", 0), end("assistant", "final", 7)].join("\n")
		expect(readAll(ndjson)).toEqual({ text: "final", usage: { totalTokens: 7 } })
	})

	it("skips trailing non-assistant and unparseable lines", () => {
		const ndjson = [end("assistant", "the one", 3), end("user", "after", 0), "{not json", ""].join("\n")
		expect(readAll(ndjson)).toEqual({ text: "the one", usage: { totalTokens: 3 } })
	})

	it("agrees with the full parse it replaces, on the same input", () => {
		const ndjson = [end("assistant", "a", 1), end("assistant", "b", 2)].join("\n")
		const full = parseNdjsonMessages(ndjson)
		expect(readAll(ndjson)).toEqual({ text: lastAssistantText(full), usage: lastAssistantUsage(full) })
	})

	it("is empty when there is no assistant message at all", () => {
		expect(readAll(end("user", "hello", 0))).toEqual({ text: "", usage: undefined })
		expect(readAll("")).toEqual({ text: "", usage: undefined })
	})

	it("reads a final line that never got its newline — a killed child stops mid-stream", () => {
		const reader = createAssistantTurnReader()
		reader.push(`${end("assistant", "before", 1)}\n`)
		reader.push(end("assistant", "unterminated", 4)) // no trailing newline, and no more chunks coming
		expect(reader.end()).toEqual({ text: "unterminated", usage: { totalTokens: 4 } })
	})

	it("ignores a truncated last line rather than letting it lose the turn before it", () => {
		const ndjson = `${[end("assistant", "complete", 5), end("user", "next", 0)].join("\n")}\n{"type":"message_end","messa`
		expect(readAll(ndjson)).toEqual({ text: "complete", usage: { totalTokens: 5 } })
	})

	it("gives the same answer however the stream is chopped up, including one character at a time", () => {
		const ndjson = [end("assistant", "first", 1), end("user", "next", 0), end("assistant", "final ✓ ünïcøde", 7)].join(
			"\n",
		)
		const expected = { text: "final ✓ ünïcøde", usage: { totalTokens: 7 } }
		for (const size of [1, 2, 3, 7, 13, 64, 1000]) {
			expect(readChunked(ndjson, size)).toEqual(expected)
		}
	})

	it("keeps only the LAST assistant turn, not a list of the ones before it", () => {
		// 20k earlier messages: the answer must be the last one whatever came before, and nothing here
		// grows with the count (see pi-agent-background.test.ts for the measured version of that claim).
		const noise = Array.from({ length: 20_000 }, (_, i) => end("assistant", `turn ${i}`, i))
		const ndjson = [...noise, end("assistant", "last", 9)].join("\n")

		expect(readAll(ndjson)).toEqual({ text: "last", usage: { totalTokens: 9 } })
	})
})
