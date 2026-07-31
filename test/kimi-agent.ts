import { readFileSync } from "node:fs"
import path from "node:path"
import {
	SUBMIT_QUESTIONS_TOOL,
	SUBMIT_RESULT_TOOL,
	submitQuestionsParameters,
	submitResultParameters,
} from "../src/engine/output-tools.ts"
import type { AgentRequest, AgentSession, AgentTurn, SubmittedOutput } from "../src/engine/types.ts"

/**
 * Shared helpers for the gated integration tests: resolve the kimchi API key and build a real
 * `startAgent` backed by the kimchi OpenAI-compatible gateway (one call per turn). Not a `.test.ts`
 * file, so vitest does not collect it as a test.
 */
const KIMI_CHAT_URL = "https://llm.kimchi.dev/openai/v1/chat/completions"

/** Resolve KIMCHI_API_KEY from the environment or `../kimchi-dev/.env`; undefined when unavailable. */
export function resolveKimiApiKey(): string | undefined {
	if (process.env.KIMCHI_API_KEY) return process.env.KIMCHI_API_KEY
	try {
		const envPath = path.resolve(import.meta.dirname, "../../kimchi-dev/.env")
		for (const line of readFileSync(envPath, "utf8").split("\n")) {
			const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
			if (match && match[1] === "KIMCHI_API_KEY") {
				return match[2]?.replace(/^["']|["']$/g, "").trim()
			}
		}
	} catch {
		// .env not readable — treated as "no key"; callers self-skip.
	}
	return undefined
}

interface ChatMessage {
	role: "user" | "assistant"
	content: string
}

/** An OpenAI-shaped tool definition, as the gateway expects it. */
interface ChatTool {
	type: "function"
	function: { name: string; description: string; parameters: unknown }
}

/**
 * The output tools this step may call, in the gateway's own shape.
 *
 * A step under a contract reports ONLY through these (engine/output-tools.ts), so the integration
 * tests have to offer them for real — the gateway is where the schema is actually enforced, which is
 * the property these tests exist to check against a live model.
 */
function outputTools(request: AgentRequest): ChatTool[] | undefined {
	if (!request.outputSchema) return undefined
	const tools: ChatTool[] = [
		{
			type: "function",
			function: {
				name: SUBMIT_RESULT_TOOL,
				description: "Submit this step's result as the `result` argument.",
				parameters: submitResultParameters(request.outputSchema),
			},
		},
	]
	if (request.asks) {
		tools.push({
			type: "function",
			function: {
				name: SUBMIT_QUESTIONS_TOOL,
				description: "Ask the user for information instead of submitting a result. Batch every question into one call.",
				parameters: submitQuestionsParameters(),
			},
		})
	}
	return tools
}

/**
 * A `startAgent` backed by real kimi chat completions. The gateway is stateless, so each turn sends
 * the FULL accumulated conversation (seeded with `history` on a resumed session) — this is what lets
 * a blocked Q&A step's answer turn carry the prior question's context (spec §8.4).
 */
export function createKimiAgentStarter(apiKey: string): (request: AgentRequest) => AgentSession {
	return (request) => {
		const modelId = toModelId(request.model)
		const conversation: ChatMessage[] = [...((request.history ?? []) as readonly ChatMessage[])]
		return {
			async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
				conversation.push({ role: "user", content: message })
				const { text, submitted, totalTokens } = await callKimiChat(apiKey, modelId, conversation, outputTools(request))
				// The submission is echoed into the conversation so a steering repair sees what it is correcting.
				conversation.push({ role: "assistant", content: submitted ? JSON.stringify(submitted.arguments) : text })
				return { text, submitted, usage: totalTokens === undefined ? undefined : { totalTokens } }
			},
			getConversation() {
				return conversation
			},
			dispose() {
				/* no persistent resources */
			},
		}
	}
}

export async function callKimiChat(
	apiKey: string,
	modelId: string,
	messages: readonly ChatMessage[],
	tools?: readonly ChatTool[],
): Promise<{ text: string; submitted?: SubmittedOutput; totalTokens?: number }> {
	const response = await fetch(KIMI_CHAT_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: modelId, messages, temperature: 0, ...(tools?.length ? { tools } : {}) }),
	})
	if (!response.ok) {
		throw new Error(`kimi gateway HTTP ${response.status}: ${await response.text()}`)
	}
	const data = (await response.json()) as {
		choices?: Array<{
			message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }
		}>
		usage?: { total_tokens?: number }
	}
	const message = data.choices?.[0]?.message
	return {
		text: message?.content ?? "",
		submitted: lastToolCall(message?.tool_calls),
		totalTokens: data.usage?.total_tokens,
	}
}

/** The last output-tool call in a response — last write wins, exactly as the host readers do. */
function lastToolCall(calls: Array<{ function?: { name?: string; arguments?: string } }> | undefined) {
	if (!calls) return undefined
	for (let i = calls.length - 1; i >= 0; i--) {
		const name = calls[i]?.function?.name
		if (name !== SUBMIT_RESULT_TOOL && name !== SUBMIT_QUESTIONS_TOOL) continue
		try {
			const args = JSON.parse(calls[i]?.function?.arguments ?? "{}") as Record<string, unknown>
			return { tool: name, arguments: args }
		} catch {
			return { tool: name, arguments: {} }
		}
	}
	return undefined
}

export function toModelId(model: string | undefined): string {
	if (!model) return "kimi-k2.7"
	return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
}
