import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { WorkflowDefinition } from "../flow/types.ts"
import { loadWorkflowFile } from "./load-workflow.ts"

const require = createRequire(import.meta.url)
const FLOW_ENTRY = fileURLToPath(new URL("../flow/index.ts", import.meta.url))
const ENGINE_ENTRY = fileURLToPath(new URL("../engine/index.ts", import.meta.url))
const NODE_TYPES_ROOT = path.dirname(path.dirname(require.resolve("@types/node/package.json")))
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
	const shims = path.join(directory, `.pi-create-typecheck-${nonce}.d.ts`)

	if (!existsSync(options.entryPath)) {
		throw new WorkflowCandidateValidationError("typescript", `entry file does not exist: ${options.diagnosticPath}`)
	}

	await mkdir(directory, { recursive: true })
	try {
		await Promise.all([
			writeFile(config, `${JSON.stringify(typeScriptConfig(options.entryPath, shims), null, 2)}\n`, "utf8"),
			writeFile(shims, TYPE_VALIDATION_SHIMS, "utf8"),
		])
		await validateTypeScript(
			runner,
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
		await Promise.all([rm(config, { force: true }), rm(shims, { force: true })])
	}
}

function typeScriptConfig(probe: string, shims: string): object {
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
			typeRoots: [NODE_TYPES_ROOT],
			paths: {
				"@kimchi-dev/kimchi-workflows": [FLOW_ENTRY],
				"@kimchi-dev/kimchi-workflows/flow": [FLOW_ENTRY],
				"@kimchi-dev/kimchi-workflows/engine": [ENGINE_ENTRY],
				typebox: [shims],
				"typebox/*": [shims],
			},
		},
		files: [probe, shims],
	}
}

async function validateTypeScript(
	runner: CommandRunner,
	config: string,
	probe: string,
	targetPath: string,
	projectRoot: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	let result: CommandResult
	try {
		result = await runner({
			command: typeScriptCompiler(),
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
function typeScriptCompiler(): string {
	const packageManifest = require.resolve("typescript/package.json")
	const packageRequire = createRequire(packageManifest)
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

/**
 * The target project may be completely dependency-free, while TypeScript still needs enough TypeBox
 * shape information to infer callback input/output and enough Node declarations to parse legitimate
 * workflow imports. Kimchi's own API is never duplicated here: path mappings point at its real source.
 */
const TYPE_VALIDATION_SHIMS = `declare module "typebox" {
  export interface TSchema<TStatic = unknown> {
    readonly __workflowValidationStatic: TStatic
    readonly [key: string]: unknown
  }
  export type Static<T extends TSchema> = T["__workflowValidationStatic"]
  type OptionalKeys<T extends Record<string, TSchema>> = {
    [K in keyof T]: T[K] extends Type.TOptional<TSchema> ? K : never
  }[keyof T]
  type RequiredKeys<T extends Record<string, TSchema>> = Exclude<keyof T, OptionalKeys<T>>
  type ObjectStatic<T extends Record<string, TSchema>> = {
    [K in RequiredKeys<T>]: Static<T[K]>
  } & {
    [K in OptionalKeys<T>]?: Static<T[K]>
  }
  export namespace Type {
    interface TString extends TSchema<string> {}
    interface TNumber extends TSchema<number> {}
    interface TInteger extends TSchema<number> {}
    interface TBoolean extends TSchema<boolean> {}
    interface TUnknown extends TSchema<unknown> {}
    interface TAny extends TSchema<any> {}
    interface TUndefined extends TSchema<undefined> {}
    interface TLiteral<T extends string | number | boolean> extends TSchema<T> {}
    interface TArray<T extends TSchema> extends TSchema<Array<Static<T>>> {}
    interface TObject<T extends Record<string, TSchema>> extends TSchema<ObjectStatic<T>> {}
    interface TUnion<T extends readonly TSchema[]> extends TSchema<Static<T[number]>> {}
    interface TOptional<T extends TSchema> extends TSchema<Static<T>> {
      readonly __workflowValidationOptional: true
    }
  }
  type SchemaOptions = Record<string, unknown>
  export const Type: {
    String(options?: SchemaOptions): Type.TString
    Number(options?: SchemaOptions): Type.TNumber
    Integer(options?: SchemaOptions): Type.TInteger
    Boolean(options?: SchemaOptions): Type.TBoolean
    Unknown(options?: SchemaOptions): Type.TUnknown
    Any(options?: SchemaOptions): Type.TAny
    Undefined(options?: SchemaOptions): Type.TUndefined
    Literal<T extends string | number | boolean>(value: T, options?: SchemaOptions): Type.TLiteral<T>
    Array<T extends TSchema>(items: T, options?: SchemaOptions): Type.TArray<T>
    Object<T extends Record<string, TSchema>>(properties: T, options?: SchemaOptions): Type.TObject<T>
    Union<T extends readonly TSchema[]>(variants: T, options?: SchemaOptions): Type.TUnion<T>
    Optional<T extends TSchema>(schema: T): Type.TOptional<T>
  }
}

declare module "typebox/value" {
  import type { TSchema } from "typebox"
  export const Value: {
    Check(schema: TSchema, value: unknown): boolean
    Errors(schema: TSchema, value: unknown): Iterable<{ instancePath: string; message: string }>
  }
}

declare module "typebox/compile" {
  export const Compile: any
}

`
