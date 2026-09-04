import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { isWorkflowVerificationResult, type WorkflowVerificationSuccess } from "../verification/protocol.ts"
import {
	resolveWorkflowPackageManager,
	runWorkflowPackageManager,
	type WorkflowPackageManagerCommand,
} from "./workflow-package-manager.ts"

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
	/** Test seam; production resolves the pinned pnpm launcher. */
	readonly resolvePackageManager?: (signal: AbortSignal | undefined) => Promise<WorkflowPackageManagerCommand>
}): Promise<WorkflowVerificationSuccess> {
	const packageRoot = path.resolve(options.packageRoot)
	let packageManager: WorkflowPackageManagerCommand
	try {
		packageManager = await (options.resolvePackageManager ?? resolveWorkflowPackageManager)(options.signal)
	} catch (error) {
		throw new WorkflowTestInfrastructureError(describe(error))
	}
	const resultDirectory = await mkdtemp(path.join(tmpdir(), "kimchi-workflow-verification-result-"))
	const resultPath = path.join(resultDirectory, "result.json")
	try {
		const command = await runCommand(
			packageManager,
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

async function runCommand(
	packageManager: WorkflowPackageManagerCommand,
	args: readonly string[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<CommandResult> {
	try {
		return await runWorkflowPackageManager(packageManager, args, {
			cwd,
			signal,
			timeoutMs: VERIFICATION_TIMEOUT_MS,
			timeoutError: () =>
				new WorkflowTestInfrastructureError(`workflow verification exceeded ${VERIFICATION_TIMEOUT_MS}ms`),
			abortError: () => new WorkflowTestInfrastructureError("workflow verification aborted"),
			outputLimit: OUTPUT_LIMIT,
		})
	} catch (error) {
		throw error instanceof WorkflowTestInfrastructureError
			? error
			: new WorkflowTestInfrastructureError(`could not start workflow verifier: ${describe(error)}`)
	}
}

function commandDiagnostic(command: CommandResult): string {
	const diagnostic = [command.stderr.trim(), command.stdout.trim()].filter(Boolean).join("\n")
	return diagnostic ? `\n${diagnostic}` : ""
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
