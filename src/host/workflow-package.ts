import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { distribution } from "./distribution.ts"
import { checkWorkflowPrerequisites } from "./workflow-prerequisites.ts"

const INSTALL_TIMEOUT_MS = 5 * 60_000
const OUTPUT_LIMIT = 64 * 1024

/** Env override for the one case the stamped metadata cannot cover: an unstamped, in-place source build. */
const DEVELOPMENT_PACKAGE_DIR_ENV = "KIMCHI_WORKFLOWS_PACKAGE_DIR"

interface PackageManifest {
	readonly name?: string
	readonly version?: string
	readonly packageManager?: string
	readonly scripts?: Record<string, string>
	readonly devDependencies?: Record<string, string>
	readonly [key: string]: unknown
}

export interface WorkflowPackageInstallResult {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

export type WorkflowPackageInstaller = (
	directory: string,
	signal: AbortSignal | undefined,
) => Promise<WorkflowPackageInstallResult>

export interface WorkflowPackagePreparation {
	readonly directory: string
	readonly manifestPath: string
	readonly lockfilePath: string
	readonly verifyCommand: string
	readonly installed: boolean
}

export class WorkflowPackagePreparationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WorkflowPackagePreparationError"
	}
}

/** Establish one reproducible pnpm package for every workflow in a project. */
export async function prepareWorkflowPackage(options: {
	readonly directory: string
	readonly signal?: AbortSignal
	/** Test seam; production invokes pnpm directly. */
	readonly install?: WorkflowPackageInstaller
	/** Test seam; production probes the external Node and pnpm commands. */
	readonly checkPrerequisites?: (signal: AbortSignal | undefined) => Promise<void>
}): Promise<WorkflowPackagePreparation> {
	const directory = path.resolve(options.directory)
	const manifestPath = path.join(directory, "package.json")
	const lockfilePath = path.join(directory, "pnpm-lock.yaml")
	const current = existsSync(manifestPath) ? await readManifest(manifestPath, "workflow package") : {}
	const desired = workflowManifest(current)
	const rendered = `${JSON.stringify(desired, null, 2)}\n`
	const previous = existsSync(manifestPath) ? await readFile(manifestPath, "utf8") : undefined
	const changed = previous !== rendered
	const verifier = path.join(directory, "node_modules", ".bin", executableName("kimchi-workflows"))
	const installRequired = changed || !existsSync(lockfilePath) || !existsSync(verifier)
	if (installRequired) {
		const checkPrerequisites = options.checkPrerequisites ?? (options.install ? undefined : checkWorkflowPrerequisites)
		try {
			await checkPrerequisites?.(options.signal)
		} catch (error) {
			throw new WorkflowPackagePreparationError(describe(error))
		}
	}

	await mkdir(directory, { recursive: true })
	if (changed) await writeFile(manifestPath, rendered, "utf8")

	if (installRequired) {
		let result: WorkflowPackageInstallResult
		try {
			result = await (options.install ?? runInstall)(directory, options.signal)
		} catch (error) {
			throw new WorkflowPackagePreparationError(
				error instanceof WorkflowPackagePreparationError
					? error.message
					: pnpmStartupError(error instanceof Error ? error : new Error(String(error))),
			)
		}
		if (result.code !== 0) {
			throw new WorkflowPackagePreparationError(
				`pnpm could not prepare the workflow package (exit ${result.code})${commandDiagnostic(result)}\nRetry: ${installCommand(directory)}`,
			)
		}
		if (!existsSync(lockfilePath)) {
			throw new WorkflowPackagePreparationError(`pnpm completed without creating ${lockfilePath}`)
		}
		if (!existsSync(verifier)) {
			throw new WorkflowPackagePreparationError(`workflow verifier was not installed at ${verifier}`)
		}
	}

	return {
		directory,
		manifestPath,
		lockfilePath,
		verifyCommand: "pnpm run verify:workflow -- --entry <workflow.ts> --test <workflow.test.ts>",
		installed: installRequired,
	}
}

function workflowManifest(current: PackageManifest): PackageManifest {
	const managedDependencies: Record<string, string> = {
		[distribution.name]:
			distribution.version === "0.0.0" ? localPackageSpecifier(developmentPackageRoot()) : distribution.version,
		"@earendil-works/pi-coding-agent": distribution.toolchain.piCodingAgent,
		"@earendil-works/pi-tui": distribution.toolchain.piTui,
		"@types/node": distribution.toolchain.typesNode,
		typebox: distribution.toolchain.typebox,
		typescript: distribution.toolchain.typescript,
		vitest: distribution.toolchain.vitest,
	}
	const scripts: Record<string, string> = {
		...(current.scripts ?? {}),
		"verify:workflow": "kimchi-workflows verify",
	}
	if (!scripts.verify || scripts.verify === "pnpm run verify:workflow") scripts.verify = "vitest run"

	return {
		...current,
		name: current.name ?? "kimchi-project-workflows",
		private: true,
		type: current.type ?? "module",
		packageManager: distribution.packageManager,
		scripts,
		devDependencies: {
			...(current.devDependencies ?? {}),
			...managedDependencies,
		},
	}
}

function localPackageSpecifier(packageRoot: string): string {
	return `file:${packageRoot.replaceAll(path.sep, "/")}`
}

/**
 * Resolve the framework location for an unstamped source build (version 0.0.0): a git install or
 * repository checkout, where the project package must point at the framework on disk. Stamped
 * production builds never reach this path — they pin the published version. The explicit
 * development package location (env) wins; a real on-disk package root beside this module is the
 * fallback that keeps ordinary source installs working, including under a bundled executable
 * where `import.meta.url` points into a virtual filesystem and simply finds no manifest.
 */
function developmentPackageRoot(): string {
	const explicit = process.env[DEVELOPMENT_PACKAGE_DIR_ENV]?.trim()
	if (explicit) return requireDevelopmentPackageRoot(path.resolve(explicit), DEVELOPMENT_PACKAGE_DIR_ENV)
	try {
		const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
		if (isDevelopmentPackageRoot(moduleRoot)) return moduleRoot
	} catch {
		// `import.meta.url` is not a file URL (bundled): no implicit package root exists.
	}
	throw new WorkflowPackagePreparationError(
		`this kimchi-workflows build carries no release version; set ${DEVELOPMENT_PACKAGE_DIR_ENV} to the framework package directory`,
	)
}

function requireDevelopmentPackageRoot(packageRoot: string, source: string): string {
	if (isDevelopmentPackageRoot(packageRoot)) return packageRoot
	throw new WorkflowPackagePreparationError(
		`${source} must point to the ${distribution.name} package directory: ${packageRoot}`,
	)
}

function isDevelopmentPackageRoot(packageRoot: string): boolean {
	try {
		const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name?: unknown }
		return manifest.name === distribution.name
	} catch {
		return false
	}
}

async function readManifest(manifestPath: string, label: string): Promise<PackageManifest> {
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(manifestPath, "utf8"))
	} catch (error) {
		throw new WorkflowPackagePreparationError(`could not read ${label} manifest ${manifestPath}: ${describe(error)}`)
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new WorkflowPackagePreparationError(`${label} manifest ${manifestPath} is not a JSON object`)
	}
	return parsed as PackageManifest
}

function runInstall(directory: string, signal: AbortSignal | undefined): Promise<WorkflowPackageInstallResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal))
			return
		}
		const ownsProcessGroup = process.platform !== "win32"
		const child = spawn("pnpm", installArgs(directory), {
			cwd: directory,
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
			terminate(new WorkflowPackagePreparationError(`pnpm install exceeded ${INSTALL_TIMEOUT_MS}ms`))
		}, INSTALL_TIMEOUT_MS)
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

		function finish(error?: Error, result?: WorkflowPackageInstallResult): void {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			if (forceKill) clearTimeout(forceKill)
			signal?.removeEventListener("abort", onAbort)
			if (error) {
				reject(
					error instanceof WorkflowPackagePreparationError
						? error
						: new WorkflowPackagePreparationError(pnpmStartupError(error)),
				)
			} else if (result) resolve(result)
			else reject(new WorkflowPackagePreparationError("pnpm install ended without a process result"))
		}
	})
}

function pnpmStartupError(error: Error): string {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") {
		return `pnpm is required to prepare the workflow package. Install it with: npm install --global ${distribution.packageManager}`
	}
	return `could not start pnpm: ${describe(error)}`
}

function installArgs(directory: string): string[] {
	return ["--dir", directory, "--ignore-workspace", "install", "--no-frozen-lockfile", "--ignore-scripts"]
}

function installCommand(directory: string): string {
	return ["pnpm", ...installArgs(directory)]
		.map((argument) => (/^[\w./:@-]+$/.test(argument) ? argument : JSON.stringify(argument)))
		.join(" ")
}

function executableName(name: string): string {
	return process.platform === "win32" ? `${name}.cmd` : name
}

function commandDiagnostic(command: WorkflowPackageInstallResult): string {
	const diagnostic = [command.stderr.trim(), command.stdout.trim()].filter(Boolean).join("\n")
	return diagnostic ? `\n${diagnostic}` : ""
}

function appendBounded(current: string, addition: string): string {
	return (current + addition).slice(-OUTPUT_LIMIT)
}

function abortReason(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("workflow package preparation aborted")
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
