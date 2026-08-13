import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import type { WorkflowDefinition } from "../flow/types.ts"
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

interface ValidateWorkflowModuleOptions extends ValidateWorkflowFileOptions {
	readonly diagnosticPath: string
}

async function validateWorkflowModule(options: ValidateWorkflowModuleOptions): Promise<WorkflowCandidateValidation> {
	const runner = options.runCommand ?? runCommand
	const directory = path.dirname(options.entryPath)
	const nonce = randomUUID()
	const config = path.join(directory, `.pi-create-typecheck-${nonce}.json`)

	if (!existsSync(options.entryPath)) {
		throw new WorkflowCandidateValidationError("typescript", `entry file does not exist: ${options.diagnosticPath}`)
	}

	await mkdir(directory, { recursive: true })
	try {
		let toolchain: ValidationToolchain
		try {
			toolchain = await resolveValidationToolchain(options.packageRoot)
		} catch (error) {
			throw validationError("typescript", error)
		}
		await writeFile(config, `${JSON.stringify(typeScriptConfig(options.entryPath, toolchain), null, 2)}\n`, "utf8")
		await validateTypeScript(
			runner,
			toolchain.compiler,
			config,
			options.entryPath,
			options.diagnosticPath,
			options.projectRoot,
			options.signal,
		)

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
	} finally {
		await rm(config, { force: true })
	}
}

interface ValidationToolchain {
	readonly compiler: string
	readonly nodeTypesRoot: string
	readonly paths: Readonly<Record<string, readonly string[]>>
}

interface InstalledPackage {
	readonly name: string
	readonly directory: string
	readonly manifestPath: string
	readonly manifest: PackageManifest
}

interface PackageManifest {
	readonly name?: unknown
	readonly types?: unknown
	readonly typings?: unknown
	readonly exports?: unknown
	readonly typesVersions?: unknown
}

/**
 * Build the static-validation environment exclusively from the package prepared for this project.
 * This keeps the quick candidate gate on the same public declarations and versions as package
 * verification, without duplicating either Kimchi, TypeBox, or PI types inside the validator.
 */
async function resolveValidationToolchain(packageRoot: string): Promise<ValidationToolchain> {
	const [framework, typebox, pi, node, typescript] = await Promise.all([
		readInstalledPackage(packageRoot, "@kimchi-dev/kimchi-workflows"),
		readInstalledPackage(packageRoot, "typebox"),
		readInstalledPackage(packageRoot, "@earendil-works/pi-coding-agent"),
		readInstalledPackage(packageRoot, "@types/node"),
		readInstalledPackage(packageRoot, "typescript"),
	])
	return {
		compiler: typeScriptCompiler(typescript.manifestPath),
		nodeTypesRoot: path.dirname(path.dirname(node.manifestPath)),
		paths: {
			...frameworkTypePaths(framework),
			...declarationPaths(typebox),
			...declarationPaths(pi),
		},
	}
}

function frameworkTypePaths(pkg: InstalledPackage): Record<string, readonly string[]> {
	try {
		return declarationPaths(pkg)
	} catch (declarationError) {
		// Published packages provide dist declarations. A local `file:` install intentionally skips
		// lifecycle scripts, so a clean checkout may contain only the equally authoritative TS source.
		const paths: Record<string, readonly string[]> = {}
		for (const [exportKey] of packageExportEntries(pkg.manifest.exports)) {
			const layer = exportKey === "." ? "flow" : exportKey.slice(2)
			const source = path.join(pkg.directory, "src", layer, "index.ts")
			if (!existsSync(source)) throw declarationError
			const specifier = exportKey === "." ? pkg.name : `${pkg.name}${exportKey.slice(1)}`
			paths[specifier] = [source]
		}
		if (!paths[pkg.name]) throw declarationError
		return paths
	}
}

async function readInstalledPackage(packageRoot: string, name: string): Promise<InstalledPackage> {
	const directory = path.join(path.resolve(packageRoot), "node_modules", ...name.split("/"))
	const manifestPath = path.join(directory, "package.json")
	let manifest: PackageManifest
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest
	} catch (error) {
		throw new Error(`prepared workflow package is missing ${name} at ${manifestPath}: ${describe(error)}`)
	}
	if (manifest.name !== name) {
		throw new Error(`prepared workflow package entry ${manifestPath} identifies itself as ${String(manifest.name)}`)
	}
	return { name, directory, manifestPath, manifest }
}

function declarationPaths(pkg: InstalledPackage): Record<string, readonly string[]> {
	const entries = packageExportEntries(pkg.manifest.exports)
	const paths: Record<string, readonly string[]> = {}
	for (const [exportKey, exported] of entries) {
		const target =
			findTypesCondition(exported) ??
			findTypesVersionTarget(pkg.manifest.typesVersions, exportKey) ??
			(exportKey === "." ? (stringValue(pkg.manifest.types) ?? stringValue(pkg.manifest.typings)) : undefined)
		if (!target) continue
		const declaration = path.resolve(pkg.directory, target)
		if (!existsSync(declaration)) {
			throw new Error(`${pkg.name} declares types for ${exportKey} at a missing path: ${declaration}`)
		}
		const specifier = exportKey === "." ? pkg.name : `${pkg.name}${exportKey.slice(1)}`
		paths[specifier] = [declaration]
	}
	if (!paths[pkg.name]) {
		const target = stringValue(pkg.manifest.types) ?? stringValue(pkg.manifest.typings)
		if (target) {
			const declaration = path.resolve(pkg.directory, target)
			if (!existsSync(declaration)) throw new Error(`${pkg.name} declares a missing types entry: ${declaration}`)
			paths[pkg.name] = [declaration]
		}
	}
	if (!paths[pkg.name]) throw new Error(`${pkg.name} does not expose a resolvable root type declaration`)
	return paths
}

function packageExportEntries(exportsField: unknown): ReadonlyArray<readonly [string, unknown]> {
	if (isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith("."))) {
		return Object.entries(exportsField)
	}
	return [[".", exportsField]]
}

function findTypesCondition(value: unknown): string | undefined {
	if (typeof value === "string") return isDeclarationPath(value) ? value : undefined
	if (Array.isArray(value)) {
		for (const item of value) {
			const target = findTypesCondition(item)
			if (target) return target
		}
		return undefined
	}
	if (!isRecord(value)) return undefined
	const direct = stringValue(value.types)
	if (direct) return direct
	for (const nested of Object.values(value)) {
		if (!isRecord(nested) && !Array.isArray(nested)) continue
		const target = findTypesCondition(nested)
		if (target) return target
	}
	return undefined
}

function findTypesVersionTarget(typesVersions: unknown, exportKey: string): string | undefined {
	if (!isRecord(typesVersions)) return undefined
	const key = exportKey === "." ? "." : exportKey.slice(2)
	for (const versionMap of Object.values(typesVersions)) {
		if (!isRecord(versionMap)) continue
		const targets = versionMap[key]
		if (Array.isArray(targets)) {
			const first = targets.find((target): target is string => typeof target === "string")
			if (first) return first
		}
	}
	return undefined
}

function isDeclarationPath(value: string): boolean {
	return /\.d\.(?:ts|mts|cts)$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
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

/**
 * Resolve TypeScript 7's platform compiler directly instead of launching its JavaScript shim through
 * `process.execPath`. A packaged Kimchi process is a Bun-compiled executable, so `process.execPath`
 * names the Kimchi CLI itself; passing `--project` to it fails before TypeScript ever sees the candidate.
 */
function typeScriptCompiler(packageManifest: string): string {
	// npm commonly hoists optional platform packages, while pnpm links them beside TypeScript in its
	// content-addressed store. Resolving from the real package location lets Node support both layouts.
	const packageRequire = createRequire(realpathSync(packageManifest))
	const nativePackage = `@typescript/typescript-${process.platform}-${process.arch}`
	let nativeManifest: string
	try {
		nativeManifest = packageRequire.resolve(`${nativePackage}/package.json`)
	} catch {
		throw new Error(`TypeScript compiler package ${nativePackage} is unavailable`)
	}
	const executable = path.join(path.dirname(nativeManifest), "lib", process.platform === "win32" ? "tsc.exe" : "tsc")
	if (!existsSync(executable)) throw new Error(`TypeScript compiler executable is unavailable at ${executable}`)
	return executable
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

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
