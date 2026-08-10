import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
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
	role: "user" | "assistant" | "tool"
	content: string | null
	tool_calls?: ChatToolCall[]
	tool_call_id?: string
}

interface ChatToolCall {
	id: string
	type: "function"
	function: { name: string; arguments: string }
}

/** An OpenAI-shaped tool definition, as the gateway expects it. */
interface ChatTool {
	type: "function"
	function: { name: string; description: string; parameters: unknown }
}

export interface KimiAgentStarterOptions {
	/** Enable the test gateway's minimal read/write tools, confined to this root. */
	readonly fileToolsRoot?: string
	/** Optional record of files written through the test gateway, useful for integration cleanup. */
	readonly writtenFiles?: Set<string>
	/** Existing files the test agent is explicitly allowed to edit (normally the reserved entry scaffold). */
	readonly overwriteFiles?: ReadonlySet<string>
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
export function createKimiAgentStarter(
	apiKey: string,
	options: KimiAgentStarterOptions = {},
): (request: AgentRequest) => AgentSession {
	return (request) => {
		const modelId = toModelId(request.model)
		const conversation: ChatMessage[] = [...((request.history ?? []) as readonly ChatMessage[])]
		const engineConversation = [...(request.history ?? [])]
		return {
			async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
				conversation.push({ role: "user", content: message })
				engineConversation.push({ role: "user", content: message })
				const turn = await callKimiWithTools(apiKey, modelId, conversation, request, options)
				// The submission is echoed into the engine-facing conversation so an answer-resume or output
				// steering repair sees what the model reported without depending on provider-specific tool syntax.
				engineConversation.push({
					role: "assistant",
					content: turn.submitted ? JSON.stringify(turn.submitted.arguments) : turn.text,
				})
				return {
					text: turn.text,
					submitted: turn.submitted,
					usage: turn.totalTokens === undefined ? undefined : { totalTokens: turn.totalTokens },
				}
			},
			getConversation() {
				return engineConversation
			},
			dispose() {
				/* no persistent resources */
			},
		}
	}
}

const MAX_TOOL_ROUNDS = 20

async function callKimiWithTools(
	apiKey: string,
	modelId: string,
	conversation: ChatMessage[],
	request: AgentRequest,
	options: KimiAgentStarterOptions,
): Promise<{ text: string; submitted?: SubmittedOutput; totalTokens?: number }> {
	const tools = [...(outputTools(request) ?? []), ...fileTools(options)]
	let totalTokens = 0
	let sawUsage = false

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const response = await callKimiChatResponse(apiKey, modelId, conversation, tools)
		if (response.totalTokens !== undefined) {
			totalTokens += response.totalTokens
			sawUsage = true
		}

		const calls = response.toolCalls ?? []
		if (calls.length === 0) {
			conversation.push({ role: "assistant", content: response.text })
			return { text: response.text, totalTokens: sawUsage ? totalTokens : undefined }
		}

		conversation.push({ role: "assistant", content: response.text || null, tool_calls: calls })
		let submitted: SubmittedOutput | undefined
		for (const call of calls) {
			const outputSubmission = submittedOutput(call)
			if (outputSubmission) submitted = outputSubmission
			const content = outputSubmission ? "Submission received." : await executeFileTool(call, options)
			conversation.push({ role: "tool", tool_call_id: call.id, content })
		}

		if (submitted) {
			return {
				text: response.text,
				submitted,
				totalTokens: sawUsage ? totalTokens : undefined,
			}
		}
	}

	throw new Error(`kimi gateway exceeded ${MAX_TOOL_ROUNDS} tool rounds`)
}

function fileTools(options: KimiAgentStarterOptions): ChatTool[] {
	if (!options.fileToolsRoot) return []
	return [
		{
			type: "function",
			function: {
				name: "read_file",
				description: "Read a UTF-8 text file. Paths must be inside the project root.",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
					additionalProperties: false,
				},
			},
		},
		{
			type: "function",
			function: {
				name: "write_file",
				description: "Write complete UTF-8 text content to a file. Paths must be inside the project root.",
				parameters: {
					type: "object",
					properties: { path: { type: "string" }, content: { type: "string" } },
					required: ["path", "content"],
					additionalProperties: false,
				},
			},
		},
	]
}

async function executeFileTool(call: ChatToolCall, options: KimiAgentStarterOptions): Promise<string> {
	if (call.function.name !== "read_file" && call.function.name !== "write_file") {
		return `Unknown tool: ${call.function.name}`
	}
	try {
		const args = JSON.parse(call.function.arguments) as { path?: unknown; content?: unknown }
		if (typeof args.path !== "string") throw new Error("path must be a string")
		const file = confinedFile(options.fileToolsRoot, args.path)
		if (call.function.name === "read_file") return await readFile(file, "utf8")
		if (typeof args.content !== "string") throw new Error("content must be a string")
		if (existsSync(file) && !options.overwriteFiles?.has(file) && !options.writtenFiles?.has(file)) {
			throw new Error(`refusing to overwrite an existing file: ${file}`)
		}
		await mkdir(path.dirname(file), { recursive: true })
		await writeFile(file, args.content, "utf8")
		options.writtenFiles?.add(file)
		return `Wrote ${file}`
	} catch (error) {
		return `Tool error: ${error instanceof Error ? error.message : String(error)}`
	}
}

function confinedFile(root: string | undefined, submittedPath: string): string {
	if (!root) throw new Error("file tools are disabled")
	const resolvedRoot = path.resolve(root)
	const file = path.isAbsolute(submittedPath) ? path.resolve(submittedPath) : path.resolve(resolvedRoot, submittedPath)
	if (file !== resolvedRoot && !file.startsWith(resolvedRoot + path.sep)) {
		throw new Error(`path escapes project root: ${submittedPath}`)
	}
	return file
}

function submittedOutput(call: ChatToolCall): SubmittedOutput | undefined {
	if (call.function.name !== SUBMIT_RESULT_TOOL && call.function.name !== SUBMIT_QUESTIONS_TOOL) return undefined
	try {
		return { tool: call.function.name, arguments: JSON.parse(call.function.arguments) as Record<string, unknown> }
	} catch {
		return { tool: call.function.name, arguments: {} }
	}
}

export async function callKimiChat(
	apiKey: string,
	modelId: string,
	messages: readonly ChatMessage[],
	tools?: readonly ChatTool[],
): Promise<{ text: string; submitted?: SubmittedOutput; totalTokens?: number }> {
	const response = await callKimiChatResponse(apiKey, modelId, messages, tools)
	return {
		text: response.text,
		submitted: lastToolCall(response.toolCalls),
		totalTokens: response.totalTokens,
	}
}

async function callKimiChatResponse(
	apiKey: string,
	modelId: string,
	messages: readonly ChatMessage[],
	tools?: readonly ChatTool[],
): Promise<{ text: string; toolCalls?: ChatToolCall[]; totalTokens?: number }> {
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
			message?: {
				content?: string
				tool_calls?: Array<{
					id?: string
					type?: string
					function?: { name?: string; arguments?: string }
				}>
			}
		}>
		usage?: { total_tokens?: number }
	}
	const message = data.choices?.[0]?.message
	const toolCalls = message?.tool_calls?.flatMap((call, index): ChatToolCall[] => {
		const name = call.function?.name
		if (!name) return []
		return [
			{
				id: call.id ?? `call-${index}`,
				type: "function",
				function: { name, arguments: call.function?.arguments ?? "{}" },
			},
		]
	})
	return {
		text: message?.content ?? "",
		toolCalls,
		totalTokens: data.usage?.total_tokens,
	}
}

/** The last output-tool call in a response — last write wins, exactly as the host readers do. */
function lastToolCall(calls: readonly ChatToolCall[] | undefined): SubmittedOutput | undefined {
	if (!calls) return undefined
	for (let i = calls.length - 1; i >= 0; i--) {
		const submitted = submittedOutput(calls[i] as ChatToolCall)
		if (submitted) return submitted
	}
	return undefined
}

export function toModelId(model: string | undefined): string {
	if (!model) return "kimi-k2.7"
	return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
}
