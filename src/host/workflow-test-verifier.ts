import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { isWorkflowVerificationResult, type WorkflowVerificationSuccess } from "../verification/protocol.ts"
import { checkWorkflowPrerequisites } from "./workflow-prerequisites.ts"

const OUTPUT_LIMIT = 64 * 1024
const VERIFICATION_TIMEOUT_MS = 90_000

interface CommandResult {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

export class WorkflowTestVerificationError extends Error {
	constructor(
		message: string,
		readonly errors: readonly string[] = [],
	) {
		super(message)
		this.name = "WorkflowTestVerificationError"
	}
}

export class WorkflowTestInfrastructureError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WorkflowTestInfrastructureError"
	}
}

/** Invoke the workflow package's reproducible verifier without resolving its dependencies in Kimchi. */
export async function verifyWorkflowTest(options: {
	readonly entryPath: string
	readonly testPath: string
	readonly packageRoot: string
	readonly signal?: AbortSignal
	/** Test seam; production probes the external Node and pnpm commands. */
	readonly checkPrerequisites?: (signal: AbortSignal | undefined) => Promise<void>
}): Promise<WorkflowVerificationSuccess> {
	const packageRoot = path.resolve(options.packageRoot)
	try {
		await (options.checkPrerequisites ?? checkWorkflowPrerequisites)(options.signal)
	} catch (error) {
		throw new WorkflowTestInfrastructureError(describe(error))
	}
	const resultDirectory = await mkdtemp(path.join(tmpdir(), "kimchi-workflow-verification-result-"))
	const resultPath = path.join(resultDirectory, "result.json")
	try {
		const command = await runCommand(
			[
				"--dir",
				packageRoot,
				"--ignore-workspace",
				"--silent",
				"run",
				"verify:workflow",
				"--",
				"--entry",
				path.resolve(options.entryPath),
				"--test",
				path.resolve(options.testPath),
				"--package-root",
				packageRoot,
				"--result-file",
				resultPath,
			],
			packageRoot,
			options.signal,
		)
		let raw: string
		try {
			raw = await readFile(resultPath, "utf8")
		} catch (error) {
			throw new WorkflowTestInfrastructureError(
				`workflow verifier exited with code ${command.code} without a result: ${describe(error)}${commandDiagnostic(command)}`,
			)
		}
		let result: unknown
		try {
			result = JSON.parse(raw)
		} catch (error) {
			throw new WorkflowTestInfrastructureError(`workflow verifier produced invalid JSON: ${describe(error)}`)
		}
		if (!isWorkflowVerificationResult(result)) {
			throw new WorkflowTestInfrastructureError("workflow verifier produced an unsupported result")
		}
		const expectedCode = result.ok ? 0 : result.kind === "verification" ? 1 : 2
		if (command.code !== expectedCode) {
			throw new WorkflowTestInfrastructureError(
				`workflow verifier result expected exit ${expectedCode}, but the command exited ${command.code}${commandDiagnostic(command)}`,
			)
		}
		if (result.ok) return result
		if (result.kind === "infrastructure") throw new WorkflowTestInfrastructureError(result.summary)
		throw new WorkflowTestVerificationError(result.summary, result.errors)
	} finally {
		await rm(resultDirectory, { recursive: true, force: true })
	}
}

function runCommand(args: readonly string[], cwd: string, signal: AbortSignal | undefined): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal))
			return
		}
		const ownsProcessGroup = process.platform !== "win32"
		const child = spawn("pnpm", [...args], {
			cwd,
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
		const timeout = setTimeout(() => {
			terminate(new WorkflowTestInfrastructureError(`workflow verification exceeded ${VERIFICATION_TIMEOUT_MS}ms`))
		}, VERIFICATION_TIMEOUT_MS)
		const onAbort = () => terminate(abortReason(signal))
		signal?.addEventListener("abort", onAbort, { once: true })

		child.stdout.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk.toString())
		})
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk.toString())
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

		function finish(error?: Error, result?: CommandResult): void {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			if (forceKill) clearTimeout(forceKill)
			signal?.removeEventListener("abort", onAbort)
			if (error) {
				reject(
					error instanceof WorkflowTestInfrastructureError
						? error
						: new WorkflowTestInfrastructureError(`could not start workflow verifier: ${describe(error)}`),
				)
			} else if (result) resolve(result)
			else reject(new WorkflowTestInfrastructureError("workflow verifier ended without a process result"))
		}
	})
}

function commandDiagnostic(command: CommandResult): string {
	const diagnostic = [command.stderr.trim(), command.stdout.trim()].filter(Boolean).join("\n")
	return diagnostic ? `\n${diagnostic}` : ""
}

function appendBounded(current: string, addition: string): string {
	return (current + addition).slice(-OUTPUT_LIMIT)
}

function abortReason(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("workflow test verification aborted")
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
