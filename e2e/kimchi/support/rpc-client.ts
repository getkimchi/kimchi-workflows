import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"

export interface RpcRecord {
	readonly type: string
	readonly [key: string]: unknown
}

export interface RpcResponse extends RpcRecord {
	readonly type: "response"
	readonly id?: string
	readonly command: string
	readonly success: boolean
	readonly data?: unknown
	readonly error?: string
}

export interface ExtensionUiRequest extends RpcRecord {
	readonly type: "extension_ui_request"
	readonly id: string
	readonly method: string
	readonly message?: string
	readonly title?: string
	readonly options?: readonly string[]
}

export type ExtensionUiResponse =
	| { readonly cancelled: true }
	| { readonly value: string }
	| { readonly confirmed: boolean }

export type DialogResponder = (request: ExtensionUiRequest) => ExtensionUiResponse

export interface KimchiRpcOptions {
	readonly binaryPath: string
	readonly cwd: string
	readonly env: NodeJS.ProcessEnv
}

interface PendingRequest {
	readonly resolve: (response: RpcResponse) => void
	readonly reject: (error: Error) => void
	readonly timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 120_000
const STARTUP_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 3_000
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"])

/** Strict JSONL client for the compiled harness's RPC mode. */
export class KimchiRpcClient {
	readonly messages: RpcRecord[] = []
	readonly dialogRequests: ExtensionUiRequest[] = []
	stderr = ""
	dialogResponder: DialogResponder | undefined

	private readonly child: ChildProcessWithoutNullStreams
	private readonly pending = new Map<string, PendingRequest>()
	private nextId = 1
	private stopping = false
	private readonly exited: Promise<void>

	private constructor(options: KimchiRpcOptions) {
		this.child = spawn(
			options.binaryPath,
			["--provider", "fake", "--model", "basic", "--mode", "rpc", "--no-session"],
			{ cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] },
		)
		this.child.stdout.setEncoding("utf8")
		this.child.stderr.setEncoding("utf8")
		this.child.stderr.on("data", (chunk: string) => {
			this.stderr += chunk
		})

		let stdout = ""
		this.child.stdout.on("data", (chunk: string) => {
			stdout += chunk
			for (;;) {
				const newline = stdout.indexOf("\n")
				if (newline < 0) break
				const line = stdout.slice(0, newline)
				stdout = stdout.slice(newline + 1)
				if (line.trim()) this.receive(line)
			}
		})

		this.exited = new Promise((resolve) => {
			this.child.once("exit", (code, signal) => {
				const failure = new Error(
					`Kimchi RPC process exited (code=${String(code)}, signal=${String(signal)})${this.stderr ? `\n${this.stderr}` : ""}`,
				)
				if (!this.stopping) this.rejectPending(failure)
				resolve()
			})
		})
		this.child.once("error", (error) => this.rejectPending(error))
	}

	static async start(options: KimchiRpcOptions): Promise<KimchiRpcClient> {
		const client = new KimchiRpcClient(options)
		try {
			const commands = await client.request("get_commands", {}, STARTUP_TIMEOUT_MS)
			if (!commands.success) throw new Error(commands.error ?? "get_commands failed")
			if (!hasWorkflowCommand(commands.data)) {
				throw new Error(
					`compiled Kimchi did not load the workflow package command${client.stderr ? `\n${client.stderr}` : ""}`,
				)
			}
			return client
		} catch (error) {
			await client.stop()
			throw error
		}
	}

	/** Begin a prompt without awaiting its command handler; needed to cancel an in-flight workflow. */
	beginPrompt(message: string): Promise<RpcResponse> {
		return this.request("prompt", { message })
	}

	async prompt(message: string): Promise<void> {
		const response = await this.beginPrompt(message)
		if (!response.success) throw new Error(response.error ?? `Kimchi rejected prompt: ${message}`)
	}

	get messageCount(): number {
		return this.messages.length
	}

	notificationsSince(index: number): ExtensionUiRequest[] {
		return this.messages
			.slice(index)
			.filter((message): message is ExtensionUiRequest => isExtensionUiRequest(message) && message.method === "notify")
	}

	async stop(): Promise<void> {
		if (this.stopping) {
			await this.exited
			return
		}
		this.stopping = true
		if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM")
		const stopped = await Promise.race([
			this.exited.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
		])
		if (!stopped && this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill("SIGKILL")
			await this.exited
		}
		this.rejectPending(new Error("Kimchi RPC process stopped"))
	}

	private request(type: string, fields: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<RpcResponse> {
		const id = `kimchi-workflows-e2e-${this.nextId++}`
		const response = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return
				reject(new Error(`Kimchi RPC ${type} request exceeded ${timeoutMs}ms${this.stderr ? `\n${this.stderr}` : ""}`))
			}, timeoutMs)
			this.pending.set(id, { resolve, reject, timer })
		})
		this.send({ id, type, ...fields })
		return response
	}

	private send(message: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`)
	}

	private receive(line: string): void {
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch (error) {
			this.rejectPending(new Error(`Kimchi RPC emitted non-JSON stdout: ${line}`, { cause: error }))
			return
		}
		if (!isRpcRecord(parsed)) {
			this.rejectPending(new Error(`Kimchi RPC emitted an invalid record: ${line}`))
			return
		}
		this.messages.push(parsed)
		if (isRpcResponse(parsed) && parsed.id) {
			const pending = this.pending.get(parsed.id)
			if (pending) {
				this.pending.delete(parsed.id)
				clearTimeout(pending.timer)
				pending.resolve(parsed)
			}
		}
		if (isExtensionUiRequest(parsed)) this.handleUi(parsed)
	}

	private handleUi(request: ExtensionUiRequest): void {
		if (!DIALOG_METHODS.has(request.method)) return
		this.dialogRequests.push(request)
		const response = this.dialogResponder?.(request) ?? { cancelled: true }
		this.send({ type: "extension_ui_response", id: request.id, ...response })
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer)
			pending.reject(error)
		}
		this.pending.clear()
	}
}

function isRpcRecord(value: unknown): value is RpcRecord {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
}

function isRpcResponse(value: RpcRecord): value is RpcResponse {
	return (
		value.type === "response" &&
		typeof value.command === "string" &&
		typeof value.success === "boolean" &&
		(value.id === undefined || typeof value.id === "string")
	)
}

function isExtensionUiRequest(value: RpcRecord): value is ExtensionUiRequest {
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string"
}

function hasWorkflowCommand(data: unknown): boolean {
	if (typeof data !== "object" || data === null || !("commands" in data) || !Array.isArray(data.commands)) return false
	return data.commands.some(
		(command) => typeof command === "object" && command !== null && "name" in command && command.name === "workflow",
	)
}
