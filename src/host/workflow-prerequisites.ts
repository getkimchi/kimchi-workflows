import { spawn } from "node:child_process"
import { distribution } from "./distribution.ts"

const MIN_NODE_MAJOR = 22
const MIN_NODE_MINOR = 19
const PROBE_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 4 * 1024

export interface WorkflowPrerequisiteCommand {
	readonly command: string
	readonly args: readonly string[]
	readonly signal?: AbortSignal
}

export interface WorkflowPrerequisiteCommandResult {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

export type WorkflowPrerequisiteCommandRunner = (
	request: WorkflowPrerequisiteCommand,
) => Promise<WorkflowPrerequisiteCommandResult>

export class WorkflowPrerequisiteError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WorkflowPrerequisiteError"
	}
}

/** Check the external Node/pnpm toolchain used by the physical project package, not Bun itself. */
export async function checkWorkflowPrerequisites(
	signal?: AbortSignal,
	runCommand: WorkflowPrerequisiteCommandRunner = runPrerequisiteCommand,
): Promise<void> {
	const node = await probeCommand({
		command: "node",
		args: ["--version"],
		label: "Node.js",
		recovery: nodeRecovery(),
		runCommand,
		signal,
	})
	const version = parseNodeVersion(node.stdout)
	if (!version || !supportsNode(version)) {
		const current = version ? `${version.major}.${version.minor}.${version.patch}` : node.stdout.trim() || "unknown"
		throw new WorkflowPrerequisiteError(
			`workflow packages require external Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ (current: ${current}). ${nodeRecovery()}`,
		)
	}

	await probeCommand({
		command: "pnpm",
		args: ["--version"],
		label: "pnpm",
		recovery: pnpmRecovery(),
		runCommand,
		signal,
	})
}

async function probeCommand(options: {
	readonly command: string
	readonly args: readonly string[]
	readonly label: string
	readonly recovery: string
	readonly runCommand: WorkflowPrerequisiteCommandRunner
	readonly signal?: AbortSignal
}): Promise<WorkflowPrerequisiteCommandResult> {
	let result: WorkflowPrerequisiteCommandResult
	try {
		result = await options.runCommand({ command: options.command, args: options.args, signal: options.signal })
	} catch (error) {
		if (options.signal?.aborted) throw error
		if (isMissingCommand(error)) {
			throw new WorkflowPrerequisiteError(`${options.label} is required for workflow packages. ${options.recovery}`)
		}
		throw new WorkflowPrerequisiteError(`could not inspect ${options.label}: ${describe(error)}. ${options.recovery}`)
	}
	if (result.code !== 0) {
		throw new WorkflowPrerequisiteError(
			`${options.label} could not run (exit ${result.code})${commandDiagnostic(result)}. ${options.recovery}`,
		)
	}
	return result
}

function parseNodeVersion(
	value: string,
): { readonly major: number; readonly minor: number; readonly patch: number } | undefined {
	const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim())
	if (!match) return undefined
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3] ?? 0),
	}
}

function supportsNode(version: { readonly major: number; readonly minor: number }): boolean {
	return version.major > MIN_NODE_MAJOR || (version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR)
}

function nodeRecovery(): string {
	return `Install or update Node.js from https://nodejs.org/en/download, then run: node --version`
}

function pnpmRecovery(): string {
	return `Install it with: npm install --global ${distribution.packageManager}`
}

function runPrerequisiteCommand(request: WorkflowPrerequisiteCommand): Promise<WorkflowPrerequisiteCommandResult> {
	return new Promise((resolve, reject) => {
		if (request.signal?.aborted) {
			reject(abortReason(request.signal))
			return
		}
		const child = spawn(request.command, [...request.args], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		})
		let stdout = ""
		let stderr = ""
		let settled = false
		const timeout = setTimeout(
			() => finish(new Error(`${request.command} probe exceeded ${PROBE_TIMEOUT_MS}ms`)),
			PROBE_TIMEOUT_MS,
		)
		const onAbort = () => finish(abortReason(request.signal))
		request.signal?.addEventListener("abort", onAbort, { once: true })

		child.stdout.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk.toString())
		})
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk.toString())
		})
		child.once("error", finish)
		child.once("close", (code) => finish(undefined, { code: code ?? 1, stdout, stderr }))

		function finish(error?: Error, result?: WorkflowPrerequisiteCommandResult): void {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			request.signal?.removeEventListener("abort", onAbort)
			if (!child.killed && error) child.kill("SIGTERM")
			if (error) reject(error)
			else if (result) resolve(result)
			else reject(new Error(`${request.command} probe ended without a result`))
		}
	})
}

function isMissingCommand(error: unknown): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function commandDiagnostic(result: WorkflowPrerequisiteCommandResult): string {
	const diagnostic = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n")
	return diagnostic ? `: ${diagnostic}` : ""
}

function appendBounded(current: string, addition: string): string {
	return (current + addition).slice(-OUTPUT_LIMIT)
}

function abortReason(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("workflow prerequisite check aborted")
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
