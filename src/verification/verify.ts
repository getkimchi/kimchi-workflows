import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import type { WorkflowVerificationSuccess } from "./protocol.ts"
import {
	readInstalledPackage,
	resolveRuntimeModule,
	resolveValidationToolchain,
	type ValidationToolchain,
} from "./toolchain.ts"

const OUTPUT_LIMIT = 64 * 1024
const RESULT_LIMIT = 1024 * 1024
const DIAGNOSTIC_LIMIT = 4 * 1024
const VERIFICATION_TIMEOUT_MS = 60_000

interface CommandResult {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

interface VitestJsonResult {
	readonly success: boolean
	readonly numTotalTests: number
	readonly numPassedTests: number
	readonly numFailedTests: number
	readonly numPendingTests: number
	readonly numTodoTests: number
	readonly testResults: readonly Record<string, unknown>[]
}

interface RuntimeAlias {
	readonly find: string
	readonly replacement: string
}

export class WorkflowAuthoredVerificationError extends Error {
	constructor(
		message: string,
		readonly errors: readonly string[] = [],
	) {
		super(message)
		this.name = "WorkflowAuthoredVerificationError"
	}
}

export class WorkflowVerificationInfrastructureError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WorkflowVerificationInfrastructureError"
	}
}

/** Type-check and execute exactly one workflow test using its package-owned dependencies. */
export async function verifyWorkflowPackage(options: {
	readonly entryPath: string
	readonly testPath: string
	readonly packageRoot: string
	readonly signal?: AbortSignal
}): Promise<WorkflowVerificationSuccess> {
	const packageRoot = path.resolve(options.packageRoot)
	const entryPath = path.resolve(options.entryPath)
	const testPath = path.resolve(options.testPath)
	await assertFile(entryPath, "workflow entry")
	await assertFile(testPath, "focused test")
	if (options.signal?.aborted) throw abortReason(options.signal)

	const packageManifest = path.join(packageRoot, "package.json")
	if (!existsSync(packageManifest)) {
		throw new WorkflowVerificationInfrastructureError(`workflow package is missing ${packageManifest}`)
	}
	const packageRequire = createRequire(packageManifest)
	const tempDirectory = await mkdtemp(path.join(packageRoot, ".kimchi-verify-"))
	const typeScriptConfig = path.join(tempDirectory, "tsconfig.json")
	const vitestConfig = path.join(tempDirectory, "vitest.config.mjs")
	const resultPath = path.join(tempDirectory, "vitest-result.json")

	try {
		let toolchain: ValidationToolchain
		let aliases: RuntimeAlias[]
		try {
			toolchain = await resolveValidationToolchain(packageRoot)
			aliases = await runtimeAliases(packageRoot)
		} catch (error) {
			throw new WorkflowVerificationInfrastructureError(
				`could not resolve the prepared workflow package toolchain: ${describe(error)}`,
			)
		}
		await Promise.all([
			writeFile(typeScriptConfig, renderTypeScriptConfig({ entryPath, testPath, toolchain }), "utf8"),
			writeFile(vitestConfig, renderVitestConfig({ aliases, entryPath, packageRoot, tempDirectory, testPath }), "utf8"),
		])
		await runTypeScript({
			compiler: toolchain.compiler,
			configPath: typeScriptConfig,
			packageRoot,
			signal: options.signal,
		})
		const command = await runVitest({
			configPath: vitestConfig,
			packageRequire,
			packageRoot,
			resultPath,
			signal: options.signal,
			testPath,
		})
		const verification = await parseVitestResult({ command, resultPath, testPath })
		if (!verification.ok) {
			throw new WorkflowAuthoredVerificationError(verification.summary, verification.errors)
		}
		return {
			ok: true,
			testPath: verification.testPath,
			files: verification.files,
			tests: verification.tests,
			passedTests: verification.passedTests,
			summary: verification.summary,
		}
	} finally {
		await rm(tempDirectory, { recursive: true, force: true })
	}
}

async function runtimeAliases(packageRoot: string): Promise<RuntimeAlias[]> {
	const [framework, typebox, pi, tui] = await Promise.all([
		readInstalledPackage(packageRoot, "@kimchi-dev/kimchi-workflows"),
		readInstalledPackage(packageRoot, "typebox"),
		readInstalledPackage(packageRoot, "@earendil-works/pi-coding-agent"),
		readInstalledPackage(packageRoot, "@earendil-works/pi-tui"),
	])
	return [
		...[
			"@kimchi-dev/kimchi-workflows/testing",
			"@kimchi-dev/kimchi-workflows/engine",
			"@kimchi-dev/kimchi-workflows/flow",
			"@kimchi-dev/kimchi-workflows",
		].map((find) => ({ find, replacement: resolveRuntimeModule(framework, find) })),
		...["typebox/compile", "typebox/value", "typebox"].map((find) => ({
			find,
			replacement: resolveRuntimeModule(typebox, find),
		})),
		{
			find: "@earendil-works/pi-coding-agent",
			replacement: resolveRuntimeModule(pi, "@earendil-works/pi-coding-agent"),
		},
		{ find: "@earendil-works/pi-tui", replacement: resolveRuntimeModule(tui, "@earendil-works/pi-tui") },
	]
}

function renderTypeScriptConfig(options: {
	readonly entryPath: string
	readonly testPath: string
	readonly toolchain: ValidationToolchain
}): string {
	return `${JSON.stringify(
		{
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
				typeRoots: [options.toolchain.nodeTypesRoot],
				paths: options.toolchain.paths,
			},
			files: [options.entryPath, options.testPath],
		},
		null,
		2,
	)}\n`
}

function renderVitestConfig(options: {
	readonly aliases: readonly RuntimeAlias[]
	readonly packageRoot: string
	readonly tempDirectory: string
	readonly entryPath: string
	readonly testPath: string
}): string {
	const fsAllow = [
		...new Set([
			options.packageRoot,
			...options.aliases.map((alias) => path.dirname(alias.replacement)),
			authoredPackageRoot(options.entryPath),
			authoredPackageRoot(options.testPath),
		]),
	]
	return `export default ${JSON.stringify(
		{
			cacheDir: path.join(options.tempDirectory, "vite-cache"),
			resolve: {
				alias: options.aliases.map(({ find, replacement }) => ({ find, replacement })),
			},
			server: { fs: { allow: fsAllow } },
			test: { cache: false, fileParallelism: false, passWithNoTests: false, pool: "threads" },
		},
		null,
		2,
	)}\n`
}

function authoredPackageRoot(filePath: string): string {
	const authoredDirectory = path.dirname(filePath)
	let directory = authoredDirectory
	for (;;) {
		if (existsSync(path.join(directory, "package.json"))) return directory
		const parent = path.dirname(directory)
		if (parent === directory) return authoredDirectory
		directory = parent
	}
}

async function runTypeScript(options: {
	readonly compiler: string
	readonly configPath: string
	readonly packageRoot: string
	readonly signal: AbortSignal | undefined
}): Promise<void> {
	const command = await runCommand(options.compiler, ["--project", options.configPath, "--pretty", "false"], {
		cwd: options.packageRoot,
		signal: options.signal,
	})
	if (command.code !== 0) {
		const diagnostic = commandDiagnostic(command).trim()
		throw new WorkflowAuthoredVerificationError(
			diagnostic ? `TypeScript failed: ${diagnostic}` : `TypeScript exited with code ${command.code}`,
			diagnostic ? [diagnostic] : [],
		)
	}
}

async function runVitest(options: {
	readonly configPath: string
	readonly packageRequire: NodeJS.Require
	readonly packageRoot: string
	readonly resultPath: string
	readonly signal: AbortSignal | undefined
	readonly testPath: string
}): Promise<CommandResult> {
	const manifestPath = resolveDependency(options.packageRequire, "vitest/package.json")
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { bin?: { vitest?: string } }
	if (!manifest.bin?.vitest) throw new WorkflowVerificationInfrastructureError("installed Vitest has no CLI binary")
	const cliPath = path.resolve(path.dirname(manifestPath), manifest.bin.vitest)
	return runCommand(
		process.execPath,
		[
			cliPath,
			"run",
			options.testPath,
			"--root",
			authoredPackageRoot(options.testPath),
			"--config",
			options.configPath,
			"--reporter=json",
			"--outputFile",
			options.resultPath,
			"--pool=threads",
			"--no-file-parallelism",
			"--no-color",
		],
		{ cwd: options.packageRoot, signal: options.signal },
	)
}

function resolveDependency(packageRequire: NodeJS.Require, specifier: string): string {
	try {
		return packageRequire.resolve(specifier)
	} catch (error) {
		throw new WorkflowVerificationInfrastructureError(
			`workflow package dependency ${JSON.stringify(specifier)} is unavailable: ${describe(error)}`,
		)
	}
}

function runCommand(
	command: string,
	args: readonly string[],
	options: { readonly cwd: string; readonly signal: AbortSignal | undefined },
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(abortReason(options.signal))
			return
		}
		const ownsProcessGroup = process.platform !== "win32"
		const child = spawn(command, [...args], {
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
		const timeout = setTimeout(() => {
			terminate(new WorkflowVerificationInfrastructureError(`verification exceeded ${VERIFICATION_TIMEOUT_MS}ms`))
		}, VERIFICATION_TIMEOUT_MS)
		const onAbort = () => terminate(abortReason(options.signal))
		options.signal?.addEventListener("abort", onAbort, { once: true })

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
			options.signal?.removeEventListener("abort", onAbort)
			if (error) reject(error)
			else if (result) resolve(result)
			else reject(new WorkflowVerificationInfrastructureError("verification process ended without a result"))
		}
	})
}

async function parseVitestResult(options: {
	readonly command: CommandResult
	readonly resultPath: string
	readonly testPath: string
}): Promise<{
	readonly ok: boolean
	readonly testPath: string
	readonly files: number
	readonly tests: number
	readonly passedTests: number
	readonly summary: string
	readonly errors: readonly string[]
}> {
	let raw: string
	try {
		const resultInfo = await stat(options.resultPath)
		if (resultInfo.size > RESULT_LIMIT) throw new Error(`JSON report exceeded ${RESULT_LIMIT} bytes`)
		raw = await readFile(options.resultPath, "utf8")
	} catch (error) {
		throw new WorkflowVerificationInfrastructureError(
			`Vitest exited with code ${options.command.code} without a usable JSON report: ${describe(error)}${commandDiagnostic(options.command)}`,
		)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		throw new WorkflowVerificationInfrastructureError(`Vitest produced invalid JSON: ${describe(error)}`)
	}
	if (!isVitestJsonResult(parsed)) {
		throw new WorkflowVerificationInfrastructureError("Vitest produced an unsupported JSON result")
	}

	const files = parsed.testResults.length
	const errors = collectVitestErrors(parsed)
	if (errors.length === 0 && options.command.code !== 0) {
		const diagnostic = commandDiagnostic(options.command).trim()
		if (diagnostic) errors.push(diagnostic)
	}
	const ok =
		options.command.code === 0 &&
		parsed.success &&
		files === 1 &&
		parsed.numTotalTests > 0 &&
		parsed.numPassedTests === parsed.numTotalTests &&
		parsed.numFailedTests === 0 &&
		parsed.numPendingTests === 0 &&
		parsed.numTodoTests === 0
	const testCount = `${parsed.numTotalTests} test${parsed.numTotalTests === 1 ? "" : "s"}`
	return {
		ok,
		testPath: options.testPath,
		files,
		tests: parsed.numTotalTests,
		passedTests: parsed.numPassedTests,
		summary: ok
			? `TypeScript passed; focused test passed (${testCount})`
			: `focused test failed${errors[0] ? `: ${errors[0]}` : ` (${parsed.numPassedTests}/${parsed.numTotalTests} tests passed)`}`,
		errors: errors.slice(0, 8),
	}
}

function isVitestJsonResult(value: unknown): value is VitestJsonResult {
	if (!value || typeof value !== "object") return false
	const result = value as Partial<VitestJsonResult>
	return (
		typeof result.success === "boolean" &&
		typeof result.numTotalTests === "number" &&
		typeof result.numPassedTests === "number" &&
		typeof result.numFailedTests === "number" &&
		typeof result.numPendingTests === "number" &&
		typeof result.numTodoTests === "number" &&
		Array.isArray(result.testResults) &&
		result.testResults.every((testResult) => Boolean(testResult) && typeof testResult === "object")
	)
}

function collectVitestErrors(result: VitestJsonResult): string[] {
	const errors: string[] = []
	for (const file of result.testResults) {
		if (typeof file.message === "string" && file.message.trim()) errors.push(truncateDiagnostic(file.message))
		if (!Array.isArray(file.assertionResults)) continue
		for (const assertion of file.assertionResults) {
			if (!assertion || typeof assertion !== "object") continue
			const record = assertion as Record<string, unknown>
			if (record.status !== "failed" || !Array.isArray(record.failureMessages)) continue
			for (const message of record.failureMessages) errors.push(truncateDiagnostic(String(message)))
		}
	}
	return errors
}

async function assertFile(filePath: string, label: string): Promise<void> {
	try {
		if ((await stat(filePath)).isFile()) return
	} catch {
		// Fall through to the focused authored-input error.
	}
	throw new WorkflowAuthoredVerificationError(`${label} does not exist: ${filePath}`)
}

function commandDiagnostic(command: CommandResult): string {
	const diagnostic = [command.stderr.trim(), command.stdout.trim()].filter(Boolean).join("\n")
	return diagnostic ? `\n${truncateDiagnostic(diagnostic)}` : ""
}

function truncateDiagnostic(value: string): string {
	return value.length <= DIAGNOSTIC_LIMIT ? value : `${value.slice(0, DIAGNOSTIC_LIMIT)}…`
}

function appendBounded(current: string, addition: string): string {
	return (current + addition).slice(-OUTPUT_LIMIT)
}

function abortReason(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("workflow verification aborted")
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
