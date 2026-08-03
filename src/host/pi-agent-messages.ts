/**
 * Pure message/model helpers for the PI agent bridge (spec §2.2), split out from `pi-agent.ts` so they
 * are unit-testable offline. Every PI reference here is *type-only* (erased at runtime), so importing
 * this module pulls no PI/host/network code.
 */
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isOutputToolName } from "../engine/output-tools.ts"
import type {
	AgentTurnError,
	AgentTurnErrorKind,
	ConversationMessage,
	SubmittedOutput,
	TokenUsage,
} from "../engine/types.ts"

/** The PI model registry (from the extension context) — referenced structurally for `find`. */
export type ModelRegistry = ExtensionContext["modelRegistry"]
/** The assistant/user message list carried by an `agent_end` event. */
export type AgentMessages = AgentEndEvent["messages"]

/** Resolve a `provider/modelId` string to a registry model; undefined if there is no slash or no hit. */
export function resolveModel(
	modelRegistry: Pick<ModelRegistry, "find">,
	modelString: string,
): ReturnType<ModelRegistry["find"]> {
	const slash = modelString.indexOf("/")
	if (slash === -1) return undefined
	return modelRegistry.find(modelString.slice(0, slash), modelString.slice(slash + 1))
}

/**
 * Whether `value` is an assistant message this module can read.
 *
 * `"role" in value` THROWS on a primitive, and every scan below runs over a child process's stdout or an
 * `agent_end` payload — neither is trusted input. A throw on the in-session path happens while building
 * the value a turn resolves with (`inFlight` already cleared, so the turn never settles); on the
 * background path it escapes a stream `data` listener as an uncaughtException. Both hang the run.
 */
function isAssistantMessage(value: unknown): value is { content: unknown; usage?: { totalTokens?: unknown } } {
	return typeof value === "object" && value !== null && (value as { role?: unknown }).role === "assistant"
}

/** The last assistant message's concatenated text content (`""` when there is no assistant message). */
export function lastAssistantText(messages: AgentMessages): string {
	if (!Array.isArray(messages)) return ""
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (isAssistantMessage(message)) {
			if (!Array.isArray(message.content)) return ""
			let text = ""
			for (const part of message.content as { type?: string; text?: string }[]) {
				if (part?.type === "text" && part.text) text += part.text
			}
			return text
		}
	}
	return ""
}

/**
 * The last output-tool call in a conversation, or undefined if there was none.
 *
 * Last-write-wins: a model that submits twice has its final submission taken. Scanning backwards is
 * what makes that free.
 */
export function lastSubmittedOutput(messages: AgentMessages): SubmittedOutput | undefined {
	if (!Array.isArray(messages)) return undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (!isAssistantMessage(message)) continue
		const submitted = submittedFromMessage(message)
		if (submitted) return submitted
	}
	return undefined
}

/** The last output-tool call within a single assistant message (a turn may carry several tool calls). */
export function submittedFromMessage(message: AgentMessages[number]): SubmittedOutput | undefined {
	if (!isAssistantMessage(message)) return undefined
	const content = message.content
	if (!Array.isArray(content)) return undefined
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i] as { type?: string; name?: string; arguments?: unknown } | undefined
		if (part?.type !== "toolCall" || !part.name || !isOutputToolName(part.name)) continue
		return { tool: part.name, arguments: toArguments(part.arguments) }
	}
	return undefined
}

/**
 * Normalise a tool call's arguments to an object.
 *
 * `ToolCall.arguments` is typed as an object, but that is a property of the providers pi has been used
 * with, not a guarantee: an OpenAI-compatible gateway may pass the raw JSON string through. Dropping it
 * would turn every submission into "the turn ended without calling submit_result" — a violation blaming
 * the model for the transport's shape.
 */
function toArguments(args: unknown): Record<string, unknown> {
	if (typeof args === "object" && args !== null) return args as Record<string, unknown>
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args)
			if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
		} catch {
			// An unparseable argument string is reported as an empty submission, which the engine turns
			// into a named violation rather than a silent non-submission.
		}
	}
	return {}
}

/**
 * The failure the last assistant message records, if it records one.
 *
 * PI writes a refused request as an ordinary assistant message: `content: []`, zero usage,
 * `stopReason: "error"`, and the provider's raw body in `errorMessage`. The turn then ends normally,
 * which is what makes this worth extracting: nothing downstream can otherwise tell it apart from a model
 * that said nothing. Both host paths read the harness's own message objects, so one reader serves both.
 *
 * `stopReason` is the only signal used. Empty content is NOT one on its own — a turn that ends on a tool
 * call alone legitimately carries no text.
 */
export function lastAssistantError(messages: AgentMessages): AgentTurnError | undefined {
	if (!Array.isArray(messages)) return undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (!isAssistantMessage(message)) continue
		return errorFromMessage(message)
	}
	return undefined
}

/** {@link lastAssistantError} for a single message — the incremental reader's entry point. */
export function errorFromMessage(message: unknown): AgentTurnError | undefined {
	if (!isAssistantMessage(message)) return undefined
	const failed = message as { stopReason?: unknown; errorMessage?: unknown }
	if (failed.stopReason !== "error") return undefined
	const raw = typeof failed.errorMessage === "string" ? failed.errorMessage : ""
	return { kind: classifyAgentError(raw), message: raw || "the provider reported an error with no message" }
}

/**
 * Which failure a provider's error body describes.
 *
 * Matched on text because that is all there is: the body is passed through from whatever gateway served
 * the request, and none of them agree on a machine-readable code. The patterns cover the phrasings seen
 * in real transcripts — a named `ContextWindowExceededError` and a plain "the input is longer than the
 * model's context length". Anything unrecognized stays `provider-error`, the conservative answer: it
 * retries rather than declaring a run over, which is right for the socket closes, 503s and overload
 * responses that make up the rest.
 */
export function classifyAgentError(raw: string): AgentTurnErrorKind {
	return /context[ _-]?window|context length|too many tokens|prompt is too long|maximum context/i.test(raw)
		? "context-window-exceeded"
		: "provider-error"
}

/** The last assistant message's token usage (chat-completions `usage.totalTokens`), for token budgeting (spec §9.3). */
export function lastAssistantUsage(messages: AgentMessages): TokenUsage | undefined {
	if (!Array.isArray(messages)) return undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (isAssistantMessage(message)) {
			const total = message.usage?.totalTokens
			return typeof total === "number" ? { totalTokens: total } : undefined
		}
	}
	return undefined
}

/**
 * Parse a `pi --mode json` subprocess's NDJSON stdout into the same assistant/user message list an
 * interactive `agent_end` event carries (spec §2.2, background subagents — see pi-agent.ts), so
 * `lastAssistantText`/`lastAssistantUsage` above serve both paths unchanged instead of duplicating their
 * logic. Pure: no process/host access, so it is unit-testable offline against captured fixture lines —
 * PI's own `examples/extensions/subagent` reads the identical `{ type: "message_end", message }` shape
 * off a spawned `pi` process's stdout. Malformed JSON or an unrecognized event type is skipped rather
 * than failing the whole parse: a real transcript interleaves other event types (`tool_call`,
 * `turn_start`, …) this reader has no need of.
 */
export function parseNdjsonMessages(ndjson: string): AgentMessages {
	const messages: AgentMessages = []
	for (const line of ndjson.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		let event: unknown
		try {
			event = JSON.parse(trimmed)
		} catch {
			continue
		}
		if (isMessageEndEvent(event)) messages.push(event.message as AgentMessages[number])
	}
	return messages
}

function isMessageEndEvent(value: unknown): value is { type: "message_end"; message: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "message_end" &&
		"message" in value
	)
}

/** What the streaming reader recovers from a subagent's stdout — the {@link AgentTurn} fields a background step can supply. */
export interface ReadAssistantTurn {
	text: string
	usage?: TokenUsage
	submitted?: SubmittedOutput
	error?: AgentTurnError
}

/** An incremental reader over a subagent's NDJSON stdout — see {@link createAssistantTurnReader}. */
export interface AssistantTurnReader {
	/** Feed the next decoded stdout chunk. Complete lines are read and dropped; a partial one is held. */
	push(chunk: string): void
	/** Read whatever partial line is left and return the last assistant turn seen (empty if there was none). */
	end(): ReadAssistantTurn
}

/**
 * Read the last assistant turn out of a subagent's NDJSON stdout AS IT ARRIVES, keeping neither the
 * stream nor the conversation.
 *
 * A background step needs exactly two things from a whole subprocess conversation: the final assistant
 * text and its usage (`getConversation()` returns `[]` for these — a one-shot subagent is never resumed
 * with seeded history). Both of the obvious ways to get there cost the parent the child's whole output,
 * and both were measured doing it:
 *
 *   1. Parsing every message to take the last one. On the `write-compressor` task that killed its
 *      container three runs running, the parent grew **324MB -> 1.91GB in about two minutes while
 *      reading 367KB**, with the subagent already exited — parsed JS objects run an order of magnitude
 *      or more above the text they came from.
 *   2. Holding the stdout string whole (what `pi.exec` hands back) and scanning its tail. Cheap in
 *      objects, but the parent still pays one byte for every byte the child ever printed, and a chatty
 *      subagent prints hundreds of MB.
 *
 * So this reads forwards, one line at a time, and retains only the most recent assistant `message_end`
 * it has decoded into `{ text, usage }` — the same two fields the caller will ask for. Steady-state cost
 * is one message's text plus the partial line straddling the current chunk boundary; the transient peak
 * adds one line and the object `JSON.parse` makes of it, which is unavoidable for anything that must
 * read that message at all. Nothing here scales with how long the conversation ran.
 *
 * Pure (no process/stream access — the caller owns the pipe), so it is unit-testable offline against
 * captured fixture lines, chunked at arbitrary boundaries. Malformed JSON and unrecognized event types
 * are skipped rather than failing the read, exactly as `parseNdjsonMessages` above skips them: a real
 * transcript interleaves `tool_call`/`turn_start`/… lines this reader has no need of, and a killed child
 * leaves a truncated final line.
 */
export function createAssistantTurnReader(): AssistantTurnReader {
	let pending = "" // the tail of the last chunk, up to the next newline — never a whole stream
	let last: { text: string; usage?: TokenUsage } | undefined
	// Replaced, never appended — last write wins, and one submission costs the same as any number.
	let submitted: SubmittedOutput | undefined
	// Also last-write-wins, and deliberately CLEARED by a later healthy message: pi retries some failures
	// on its own (`auto_retry_start`/`auto_retry_end`), so an error mid-stream that the child recovered
	// from is not this turn's outcome. Only a failure the turn actually ended on reaches the engine.
	let error: AgentTurnError | undefined

	const readLine = (line: string): void => {
		const trimmed = line.trim()
		if (!trimmed) return
		let event: unknown
		try {
			event = JSON.parse(trimmed)
		} catch {
			return // a partial or non-JSON line, same tolerance parseNdjsonMessages has
		}
		if (!isMessageEndEvent(event)) return
		const message = event.message as AgentMessages[number]
		if (!isAssistantMessage(message)) return
		// Decode to the fields we keep and let the parsed message go — never retaining the message itself.
		const text = lastAssistantText([message])
		const usage = lastAssistantUsage([message])
		// A tool-call-only message contributes its usage but NOT a text: carrying the previous message's
		// text forward would hand a contract-free step stale mid-turn prose as its output (that step's
		// output IS `turn.text`).
		if (text) {
			last = { text, usage }
		} else if (usage) {
			last = { text: "", usage }
		}
		const call = submittedFromMessage(message)
		if (call) submitted = call
		error = errorFromMessage(message)
	}

	return {
		push(chunk: string): void {
			pending += chunk
			let start = 0
			for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n", start)) {
				readLine(pending.slice(start, newline))
				start = newline + 1
			}
			if (start > 0) pending = pending.slice(start)
		},
		end(): ReadAssistantTurn {
			if (pending) {
				const rest = pending
				pending = ""
				readLine(rest)
			}
			return { text: last?.text ?? "", usage: last?.usage, submitted, error }
		},
	}
}

/**
 * Prepend a resumed session's stored prior conversation onto the messages PI is about to send the
 * model (spec §8.4) — the pure core of pi-agent.ts's `context`-event history seed.
 *
 * PI's `context` extension event is the one documented mechanism for injecting messages into an
 * outgoing LLM call (`docs/extensions.md`: "Fired before each LLM call... Injecting context from
 * external sources"; wired straight into `AgentLoopConfig.transformContext` in `core/sdk.ts`, which the
 * low-level agent loop applies just before `convertToLlm`). That is exactly what a resume needs after
 * the harness process itself restarted: the fresh process's PI session has none of the pre-restart
 * turns, so without this the model would see only the bare answer text with no memory of what it asked
 * or why (spec §8.4's "same agent loop resumes... context intact" would silently not hold).
 *
 * Returns `undefined` — a no-op — when there is nothing to seed, so the impure caller can skip
 * overriding PI's own messages entirely on the far more common fresh/no-history turn, and so a
 * present-but-empty `history` (never actually produced today, but not ruled out by the type) behaves
 * identically to an absent one rather than degenerating into "seed with an empty prefix".
 */
export function seedHistory(
	history: readonly ConversationMessage[] | undefined,
	messages: AgentMessages,
): AgentMessages | undefined {
	if (!history || history.length === 0) return undefined
	return [...(history as AgentMessages), ...messages]
}
