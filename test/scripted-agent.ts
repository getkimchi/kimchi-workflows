import { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "../src/engine/output-tools.ts"
import type { AgentRequest, AgentSession, AgentTurnError, SubmittedOutput } from "../src/engine/types.ts"

/**
 * How a scripted string reaches the engine, now that a step under a contract reports ONLY through
 * `submit_result`/`submit_questions` (engine/output-tools.ts).
 *
 * A string that parses as JSON is delivered as a SUBMISSION — the same payload the old text protocol
 * encoded, so a test that scripts `'{"summary":"x"}'` still means "the step produced that output".
 * Anything else is delivered as text with no submission, which is what drives output steering. An
 * `asks` step keeps the old union's spelling: `{questions}` becomes a `submit_questions` call and
 * `{result}` a `submit_result` one, so those tests read unchanged.
 */
function submissionFor(text: string, asks: boolean | undefined): SubmittedOutput | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	if (asks && typeof parsed === "object" && parsed !== null) {
		const record = parsed as Record<string, unknown>
		// The old union nested the WHOLE questionnaire under `questions`, so that value is the tool's
		// argument object, not a field of it.
		if ("questions" in record) {
			return { tool: SUBMIT_QUESTIONS_TOOL, arguments: record.questions as Record<string, unknown> }
		}
		if ("result" in record) return { tool: SUBMIT_RESULT_TOOL, arguments: { result: record.result } }
	}
	return { tool: SUBMIT_RESULT_TOOL, arguments: { result: parsed } }
}

/**
 * A scripted turn: a plain string reply, a thrown `Error` (transport failure, nothing came back), a reply
 * with token usage for budgeting, or `{ error }` — a turn the PROVIDER refused, which completes normally
 * but carries no reply (see `AgentTurnError`).
 */
export type ScriptedTurn = string | Error | { text: string; totalTokens: number } | { error: AgentTurnError }

export interface ScriptedAgent {
	startAgent: (request: AgentRequest) => AgentSession
	/** Every message sent (prompt + corrections + answers) across all sessions, in order. */
	readonly messages: string[]
	/** The `model` seen by each opened session, in order. */
	readonly models: (string | undefined)[]
	/** The `history` seed seen by each opened session, in order (undefined for a fresh session). */
	readonly histories: (readonly unknown[] | undefined)[]
	/** The `background` flag seen by each opened session, in order. */
	readonly backgrounds: (boolean | undefined)[]
	/** The `isolated` flag (spec §2.2, static isolation) seen by each opened session, in order. */
	readonly isolateds: (boolean | undefined)[]
	/** Number of sessions opened (one per `startAgent`, i.e. per outer attempt / resume). */
	readonly opened: number
	/** Number of `dispose()` calls. */
	readonly disposed: number
}

/**
 * A scripted `startAgent` for offline agent-step tests. Each opened session replays its own script
 * turn-by-turn: the Nth `sendAndAwaitEnd` returns (or throws) `script[N]`. An `Error` entry is
 * thrown (transport error); a `string` is returned as the reply; a `{ text, totalTokens }` entry
 * additionally reports usage (for token-budget tests).
 *
 * Pass one script per expected session: `[[a, b], [c]]` scripts a first session that replies `a`
 * then `b` (e.g. across a steering repair), and a second fresh session (after an outer retry) that
 * replies `c`.
 */
export function scriptedAgent(sessionScripts: readonly (readonly ScriptedTurn[])[]): ScriptedAgent {
	const messages: string[] = []
	const models: (string | undefined)[] = []
	const histories: (readonly unknown[] | undefined)[] = []
	const backgrounds: (boolean | undefined)[] = []
	const isolateds: (boolean | undefined)[] = []
	let opened = 0
	let disposed = 0
	let sessionIndex = 0
	/** The step whose in-session turn is currently in flight — PI allows at most one (spec §2.2). */
	let inSessionTurn: string | undefined

	const startAgent = (request: AgentRequest): AgentSession => {
		opened += 1
		models.push(request.model)
		histories.push(request.history)
		backgrounds.push(request.background)
		isolateds.push(request.isolated)
		const script = sessionScripts[sessionIndex++] ?? []
		const conversation: unknown[] = [...(request.history ?? [])]
		const sharesTheSession = request.background !== true && request.isolated !== true
		let turn = 0
		return {
			async sendAndAwaitEnd(message: string) {
				// Model PI's real constraint: a session hosts ONE conversation, so a second in-session turn
				// while another is in flight is an error there (spec §2.2). A double that quietly allows it is
				// how concurrent agent steps cross-talked in the real harness while every offline test stayed
				// green — the offline suite could not see the bug it was supposed to be guarding.
				if (sharesTheSession) {
					if (inSessionTurn) {
						throw new Error(
							`scripted agent: step "${request.stepName}" started an in-session turn while "${inSessionTurn}"'s turn was still in flight — it should have been isolated (spec §2.2)`,
						)
					}
					inSessionTurn = request.stepName
				}
				try {
					messages.push(message)
					conversation.push({ role: "user", content: message })
					const response = script[turn++]
					if (response === undefined) throw new Error("scripted session ran out of responses")
					if (response instanceof Error) throw response
					// Nothing is appended to the conversation: a refused request never reached the model.
					if (typeof response === "object" && "error" in response) return { text: "", error: response.error }
					const text = typeof response === "string" ? response : response.text
					conversation.push({ role: "assistant", content: text })
					const submitted = submissionFor(text, request.asks)
					return typeof response === "string"
						? { text, submitted }
						: { text, submitted, usage: { totalTokens: response.totalTokens } }
				} finally {
					// Every exit path, including a scripted transport error: a turn that threw is no longer in
					// flight, and the retry that follows opens a fresh session PI would happily accept.
					if (sharesTheSession) inSessionTurn = undefined
				}
			},
			getConversation() {
				return conversation
			},
			dispose() {
				disposed += 1
			},
		}
	}

	return {
		startAgent,
		messages,
		models,
		histories,
		backgrounds,
		isolateds,
		get opened() {
			return opened
		},
		get disposed() {
			return disposed
		},
	}
}
