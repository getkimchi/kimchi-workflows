import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { WorkflowDefinition } from "../flow/types.ts"
import { resolveValidationToolchain, type ValidationToolchain } from "../verification/toolchain.ts"
import { loadWorkflowFile } from "./load-workflow.ts"

const COMMAND_STDOUT_LIMIT = 1024 * 1024
const COMMAND_DIAGNOSTIC_LIMIT = 16 * 1024
const COMMAND_TIMEOUT_MS = 30_000

export type ValidationStage = "typescript" | "runtime" | "conformance"

export interface WorkflowCandidateValidation {
	readonly workflow: WorkflowDefinition
	readonly checks: {
		readonly typescript: "passed"
		readonly runtime: "passed"
		readonly conformance: "passed" | "skipped"
	}
	readonly summary: string
}

export interface ValidateWorkflowCandidateOptions {
	readonly source: string
	/** Intended final path. The temporary candidate is written beside it so relative imports resolve identically. */
	readonly targetPath: string
	readonly projectRoot: string
	/** Prepared workflow package whose installed versions define the authoring type environment. */
	readonly packageRoot: string
	readonly signal?: AbortSignal
	/** Optional caller-owned semantic/structural check over the workflow that successfully loaded. */
	readonly conformance?: (workflow: WorkflowDefinition) => string | undefined
	/** Test seam; production uses a bounded, non-shell child process. */
	readonly runCommand?: CommandRunner
}

export interface ValidateWorkflowFileOptions {
	/** Absolute path to the workflow entry module already written on disk. Imported files are followed by TypeScript. */
	readonly entryPath: string
	readonly projectRoot: string
	/** Prepared workflow package whose installed versions define the authoring type environment. */
	readonly packageRoot: string
	readonly signal?: AbortSignal
	/** Optional caller-owned semantic/structural check over the workflow that successfully loaded. */
	readonly conformance?: (workflow: WorkflowDefinition) => string | undefined
	/** Test seam; production uses a bounded, non-shell child process. */
	readonly runCommand?: CommandRunner
}

export class WorkflowCandidateValidationError extends Error {
	constructor(
		readonly stage: ValidationStage,
		message: string,
	) {
		super(`${stageLabel(stage)} validation failed:\n${message}`)
		this.name = "WorkflowCandidateValidationError"
	}
}

interface CommandRequest {
	readonly command: string
	readonly args: readonly string[]
	readonly cwd: string
	readonly input?: string
	readonly signal?: AbortSignal
}

interface CommandResult {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

type CommandRunner = (request: CommandRequest) => Promise<CommandResult>

/**
 * Validate one generated workflow through static tooling and the real runtime loader.
 *
 * TypeScript, runtime loading, and caller-provided conformance are mandatory. Formatting is not a
 * correctness gate: rejecting valid generated code for style would spend another model turn without
 * making the workflow safer.
 */
export async function validateWorkflowCandidate(
	options: ValidateWorkflowCandidateOptions,
): Promise<WorkflowCandidateValidation> {
	const directory = path.dirname(options.targetPath)
	const nonce = randomUUID()
	const probe = path.join(directory, `.pi-create-candidate-${nonce}.ts`)

	await mkdir(directory, { recursive: true })
	try {
		await writeFile(probe, options.source, "utf8")
		return await validateWorkflowModule({
			entryPath: probe,
			diagnosticPath: options.targetPath,
			projectRoot: options.projectRoot,
			packageRoot: options.packageRoot,
			signal: options.signal,
			conformance: options.conformance,
			runCommand: options.runCommand,
		})
	} finally {
		await rm(probe, { force: true })
	}
}

/**
 * Validate a workflow entry module in place.
 *
 * Unlike {@link validateWorkflowCandidate}, this does not copy source into a one-file probe. TypeScript
 * starts at the real entry module and follows its relative imports, and the runtime loader evaluates the
 * same module graph. That makes this the validation boundary for workflows authored as multiple files.
 */
export async function validateWorkflowFile(options: ValidateWorkflowFileOptions): Promise<WorkflowCandidateValidation> {
	return validateWorkflowModule({ ...options, diagnosticPath: options.entryPath })
}

/**
 * Type-check an existing workflow against the central prepared project package without evaluating
 * its module. Run resolution may already have loaded the file; resume/status preflight deliberately
 * calls this first so invalid source cannot execute top-level side effects.
 */
export async function validateWorkflowTypeScript(options: {
	readonly entryPath: string
	readonly projectRoot: string
	readonly packageRoot: string
	readonly signal?: AbortSignal
	/** Test seam; production uses the bounded native TypeScript runner. */
	readonly runCommand?: CommandRunner
}): Promise<void> {
	await typecheckWorkflowEntry({
		entryPath: options.entryPath,
		projectRoot: options.projectRoot,
		signal: options.signal,
		diagnosticPath: options.entryPath,
		packageRoot: options.packageRoot,
		runner: options.runCommand ?? runCommand,
		artifactPrefix: ".pi-run-typecheck",
	})
}

interface ValidateWorkflowModuleOptions extends ValidateWorkflowFileOptions {
	readonly diagnosticPath: string
}

async function validateWorkflowModule(options: ValidateWorkflowModuleOptions): Promise<WorkflowCandidateValidation> {
	const runner = options.runCommand ?? runCommand
	await typecheckWorkflowEntry({
		entryPath: options.entryPath,
		diagnosticPath: options.diagnosticPath,
		projectRoot: options.projectRoot,
		packageRoot: options.packageRoot,
		signal: options.signal,
		runner,
		artifactPrefix: ".pi-create-typecheck",
	})

	let workflow: WorkflowDefinition
	try {
		workflow = await loadWorkflowFile(options.entryPath)
	} catch (error) {
		throw validationError("runtime", error)
	}

	if (options.conformance) {
		let issue: string | undefined
		try {
			issue = options.conformance(workflow)
		} catch (error) {
			throw validationError("conformance", error)
		}
		if (issue) throw new WorkflowCandidateValidationError("conformance", issue)
	}

	const checks = {
		typescript: "passed" as const,
		runtime: "passed" as const,
		conformance: options.conformance ? ("passed" as const) : ("skipped" as const),
	}
	return {
		workflow,
		checks,
		summary: `TypeScript passed; runtime load passed; conformance ${checks.conformance}`,
	}
}

async function typecheckWorkflowEntry(options: {
	readonly entryPath: string
	readonly diagnosticPath: string
	readonly projectRoot: string
	readonly packageRoot: string
	readonly signal?: AbortSignal
	readonly runner: CommandRunner
	readonly artifactPrefix: string
}): Promise<void> {
	if (!existsSync(options.entryPath)) {
		throw new WorkflowCandidateValidationError("typescript", `entry file does not exist: ${options.diagnosticPath}`)
	}

	const config = path.join(path.dirname(options.entryPath), `${options.artifactPrefix}-${randomUUID()}.json`)
	try {
		let toolchain: ValidationToolchain
		try {
			toolchain = await resolveValidationToolchain(options.packageRoot)
		} catch (error) {
			throw validationError("typescript", error)
		}
		await writeFile(config, `${JSON.stringify(typeScriptConfig(options.entryPath, toolchain), null, 2)}\n`, "utf8")
		await validateTypeScript(
			options.runner,
			toolchain.compiler,
			config,
			options.entryPath,
			options.diagnosticPath,
			options.projectRoot,
			options.signal,
		)
	} finally {
		await rm(config, { force: true })
	}
}

function typeScriptConfig(probe: string, toolchain: ValidationToolchain): object {
	return {
		compilerOptions: {
			target: "ES2023",
			lib: ["ES2023", "DOM"],
			module: "ESNext",
			moduleResolution: "Bundler",
			moduleDetection: "force",
			allowImportingTsExtensions: true,
			verbatimModuleSyntax: true,
			strict: true,
			noUncheckedIndexedAccess: true,
			noImplicitOverride: true,
			noEmit: true,
			skipLibCheck: true,
			types: ["node"],
			typeRoots: [toolchain.nodeTypesRoot],
			paths: toolchain.paths,
		},
		files: [probe],
	}
}

async function validateTypeScript(
	runner: CommandRunner,
	compiler: string,
	config: string,
	probe: string,
	targetPath: string,
	projectRoot: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	let result: CommandResult
	try {
		result = await runner({
			command: compiler,
			args: ["--project", config, "--pretty", "false"],
			cwd: projectRoot,
			signal,
		})
	} catch (error) {
		throw validationError("typescript", error)
	}
	if (result.code !== 0) {
		const diagnostic = commandDiagnostic(result)
			.replaceAll(probe, targetPath)
			.replaceAll(config, "<validation-tsconfig>")
		throw new WorkflowCandidateValidationError("typescript", diagnostic || `compiler exited with code ${result.code}`)
	}
}

async function runCommand(request: CommandRequest): Promise<CommandResult> {
	if (request.signal?.aborted) throw abortReason(request.signal)

	return new Promise((resolve, reject) => {
		const child = spawn(request.command, [...request.args], {
			cwd: request.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		let settled = false

		const timeout = setTimeout(() => {
			child.kill("SIGKILL")
			finish(new Error(`validation command exceeded ${COMMAND_TIMEOUT_MS}ms`))
		}, COMMAND_TIMEOUT_MS)
		const onAbort = () => {
			child.kill("SIGTERM")
			finish(abortReason(request.signal))
		}
		request.signal?.addEventListener("abort", onAbort, { once: true })

		child.stdout.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk.toString(), COMMAND_STDOUT_LIMIT)
		})
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk.toString(), COMMAND_DIAGNOSTIC_LIMIT)
		})
		child.once("error", finish)
		child.once("close", (code) => finish(undefined, { code: code ?? 1, stdout, stderr }))

		if (request.input === undefined) child.stdin.end()
		else child.stdin.end(request.input)

		function finish(error?: Error, result?: CommandResult): void {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			request.signal?.removeEventListener("abort", onAbort)
			if (error) reject(error)
			else if (result) resolve(result)
			else reject(new Error("validation command ended without a result"))
		}
	})
}

function commandDiagnostic(result: CommandResult): string {
	return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(-COMMAND_DIAGNOSTIC_LIMIT)
}

function appendBounded(current: string, addition: string, limit: number): string {
	return (current + addition).slice(-limit)
}

function validationError(stage: ValidationStage, error: unknown): WorkflowCandidateValidationError {
	return error instanceof WorkflowCandidateValidationError
		? error
		: new WorkflowCandidateValidationError(stage, error instanceof Error ? error.message : String(error))
}

function stageLabel(stage: ValidationStage): string {
	if (stage === "typescript") return "TypeScript"
	if (stage === "runtime") return "Runtime"
	return "Blueprint conformance"
}

function abortReason(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("workflow validation aborted")
}
