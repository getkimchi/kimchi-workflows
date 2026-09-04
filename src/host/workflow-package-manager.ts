import { spawn } from "node:child_process"
import { distribution } from "./distribution.ts"

const MIN_NODE_MAJOR = 22
const MIN_NODE_MINOR = 19
const COMMAND_PROBE_TIMEOUT_MS = 10_000
const PACKAGE_MANAGER_BOOTSTRAP_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 4 * 1024
const PROBE_FAILURE_DETAIL_LIMIT = 512

export interface WorkflowPackageManagerCommand {
	readonly command: string
	/** Arguments placed before the pnpm operation, such as Corepack's pinned package-manager selector. */
	readonly args: readonly string[]
}

export interface WorkflowPackageManagerInvocation {
	readonly command: string
	readonly args: readonly string[]
}

export interface WorkflowPackageManagerProbe {
	readonly command: string
	readonly args: readonly string[]
	readonly timeoutMs: number
	readonly signal?: AbortSignal
}

export interface WorkflowPackageManagerCommandResult {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

export interface RunWorkflowPackageManagerOptions {
	readonly cwd: string
	readonly signal?: AbortSignal
	readonly timeoutMs: number
	readonly timeoutError: () => Error
	readonly abortError?: () => Error
	readonly outputLimit: number
}

export type WorkflowPackageManagerProbeRunner = (
	request: WorkflowPackageManagerProbe,
) => Promise<WorkflowPackageManagerCommandResult>

export class WorkflowPackageManagerError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WorkflowPackageManagerError"
	}
}

/** Resolve the pinned pnpm launcher used by project package installation and verification. */
export async function resolveWorkflowPackageManager(
	signal?: AbortSignal,
	runProbe: WorkflowPackageManagerProbeRunner = runPackageManagerProbe,
): Promise<WorkflowPackageManagerCommand> {
	const node = await requireCommand(
		{ command: "node", args: ["--version"], timeoutMs: COMMAND_PROBE_TIMEOUT_MS, signal },
		"Node.js",
		nodeRecovery(),
		runProbe,
	)
	const nodeVersion = parseNodeVersion(node.stdout)
	if (!nodeVersion || !supportsNode(nodeVersion)) {
		const current = nodeVersion
			? `${nodeVersion.major}.${nodeVersion.minor}.${nodeVersion.patch}`
			: node.stdout.trim() || "unknown"
		throw new WorkflowPackageManagerError(
			`workflow packages require external Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ (current: ${current}). ${nodeRecovery()}`,
		)
	}

	const candidates: readonly WorkflowPackageManagerCommand[] = [
		{ command: packageManagerExecutable("corepack"), args: [distribution.packageManager] },
		{ command: packageManagerExecutable("pnpm"), args: [] },
		{
			command: packageManagerExecutable("npm"),
			args: ["exec", "--yes", `--package=${distribution.packageManager}`, "--", "pnpm"],
		},
	]
	const failures: string[] = []
	for (const candidate of candidates) {
		const attempt = await probePackageManager(candidate, signal, runProbe)
		if (attempt.ok) return candidate
		failures.push(`${formatWorkflowPackageManagerCommand(candidate)}: ${summarizeProbeFailure(attempt.error)}`)
	}

	throw new WorkflowPackageManagerError(
		`could not start the pinned workflow package manager (${distribution.packageManager}). ${failures.join("; ")}. ${pnpmRecovery()}`,
	)
}

/** Append a pnpm operation to a resolved command without making its callers understand the wrapper. */
export function workflowPackageManagerInvocation(
	packageManager: WorkflowPackageManagerCommand,
	args: readonly string[],
): WorkflowPackageManagerInvocation {
	return { command: packageManager.command, args: [...packageManager.args, ...args] }
}

/** Render the exact command users can retry, deriving display text from the executable arguments. */
export function formatWorkflowPackageManagerCommand(
	packageManager: WorkflowPackageManagerCommand,
	args: readonly string[] = [],
): string {
	const invocation = workflowPackageManagerInvocation(packageManager, args)
	return [invocation.command, ...invocation.args].map(quoteArgument).join(" ")
}

/** Run a resolved pnpm launcher with bounded output, timeout, abort, and descendant cleanup. */
export function runWorkflowPackageManager(
	packageManager: WorkflowPackageManagerCommand,
	args: readonly string[],
	options: RunWorkflowPackageManagerOptions,
): Promise<WorkflowPackageManagerCommandResult> {
	return runCommand(workflowPackageManagerInvocation(packageManager, args), options)
}

async function probePackageManager(
	packageManager: WorkflowPackageManagerCommand,
	signal: AbortSignal | undefined,
	runProbe: WorkflowPackageManagerProbeRunner,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
	const invocation = workflowPackageManagerInvocation(packageManager, ["--version"])
	let result: WorkflowPackageManagerCommandResult
	try {
		result = await runProbe({ ...invocation, timeoutMs: PACKAGE_MANAGER_BOOTSTRAP_TIMEOUT_MS, signal })
	} catch (error) {
		if (signal?.aborted) throw error
		return { ok: false, error: isMissingCommand(error) ? "not installed" : describe(error) }
	}
	if (result.code !== 0) return { ok: false, error: `exit ${result.code}${commandDiagnostic(result)}` }
	const version = parsePackageManagerVersion(result.stdout)
	if (version !== pinnedPnpmVersion()) {
		return { ok: false, error: `reported ${version ?? (result.stdout.trim() || "an unknown version")}` }
	}
	return { ok: true }
}

async function requireCommand(
	probe: WorkflowPackageManagerProbe,
	label: string,
	recovery: string,
	runProbe: WorkflowPackageManagerProbeRunner,
): Promise<WorkflowPackageManagerCommandResult> {
	let result: WorkflowPackageManagerCommandResult
	try {
		result = await runProbe(probe)
	} catch (error) {
		if (probe.signal?.aborted) throw error
		if (isMissingCommand(error)) throw new WorkflowPackageManagerError(`${label} is required. ${recovery}`)
		throw new WorkflowPackageManagerError(`could not inspect ${label}: ${describe(error)}. ${recovery}`)
	}
	if (result.code !== 0) {
		throw new WorkflowPackageManagerError(
			`${label} could not run (exit ${result.code})${commandDiagnostic(result)}. ${recovery}`,
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

function parsePackageManagerVersion(value: string): string | undefined {
	const version = value.trim()
	return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version) ? version : undefined
}

function pinnedPnpmVersion(): string {
	return distribution.packageManager.slice("pnpm@".length)
}

function nodeRecovery(): string {
	return "Install or update Node.js from https://nodejs.org/en/download, then run: node --version"
}

function pnpmRecovery(): string {
	return `Install it with: npm install --global ${distribution.packageManager}`
}

function runPackageManagerProbe(request: WorkflowPackageManagerProbe): Promise<WorkflowPackageManagerCommandResult> {
	return runCommand(
		{ command: request.command, args: request.args },
		{
			cwd: process.cwd(),
			signal: request.signal,
			timeoutMs: request.timeoutMs,
			timeoutError: () => new Error(`${request.command} probe exceeded ${request.timeoutMs}ms`),
			abortError: () => new Error("workflow package manager probe aborted"),
			outputLimit: OUTPUT_LIMIT,
		},
	)
}

function runCommand(
	invocation: WorkflowPackageManagerInvocation,
	options: RunWorkflowPackageManagerOptions,
): Promise<WorkflowPackageManagerCommandResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(abortReason(options.signal, options.abortError))
			return
		}
		const ownsProcessGroup = process.platform !== "win32"
		const child = spawn(invocation.command, [...invocation.args], {
			cwd: options.cwd,
			detached: ownsProcessGroup,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		})
		let stdout = ""
		let stderr = ""
		let settled = false
		let terminationError: Error | undefined
		let forceKill: ReturnType<typeof setTimeout> | undefined
		const timeout = setTimeout(() => terminate(options.timeoutError()), options.timeoutMs)
		const onAbort = () => terminate(abortReason(options.signal, options.abortError))
		options.signal?.addEventListener("abort", onAbort, { once: true })

		child.stdout.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk.toString(), options.outputLimit)
		})
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk.toString(), options.outputLimit)
		})
		child.once("error", (error) => finish(terminationError ?? error))
		child.once("close", (code) => {
			if (terminationError) finish(terminationError)
			else finish(undefined, { code: code ?? 1, stdout, stderr })
		})

		function terminate(error: Error): void {
			if (settled || terminationError) return
			terminationError = error
			killChild("SIGTERM")
			forceKill = setTimeout(() => killChild("SIGKILL"), 1_000)
		}

		function killChild(signalName: NodeJS.Signals): void {
			try {
				if (ownsProcessGroup && child.pid) process.kill(-child.pid, signalName)
				else child.kill(signalName)
			} catch {
				// The process may have exited between the close check and signal delivery.
			}
		}

		function finish(error?: Error, result?: WorkflowPackageManagerCommandResult): void {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			if (forceKill) clearTimeout(forceKill)
			options.signal?.removeEventListener("abort", onAbort)
			if (error) reject(error)
			else if (result) resolve(result)
			else reject(new Error(`${invocation.command} ended without a result`))
		}
	})
}

function quoteArgument(argument: string): string {
	return /^[\w./:@=-]+$/.test(argument) ? argument : JSON.stringify(argument)
}

function isMissingCommand(error: unknown): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function commandDiagnostic(result: WorkflowPackageManagerCommandResult): string {
	const diagnostic = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n")
	return diagnostic ? `: ${diagnostic}` : ""
}

function appendBounded(current: string, addition: string, limit: number): string {
	return (current + addition).slice(-limit)
}

function abortReason(signal: AbortSignal | undefined, fallback: (() => Error) | undefined): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: (fallback?.() ?? new Error("workflow package manager aborted"))
}

function packageManagerExecutable(command: "corepack" | "pnpm" | "npm"): string {
	return process.platform === "win32" ? `${command}.cmd` : command
}

function summarizeProbeFailure(failure: string): string {
	const singleLine = failure.replace(/\s+/g, " ").trim()
	return singleLine.length <= PROBE_FAILURE_DETAIL_LIMIT
		? singleLine
		: `${singleLine.slice(0, PROBE_FAILURE_DETAIL_LIMIT - 3)}...`
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
