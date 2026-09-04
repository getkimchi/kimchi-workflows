import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { distribution } from "./distribution.ts"
import {
	formatWorkflowPackageManagerCommand,
	resolveWorkflowPackageManager,
	runWorkflowPackageManager,
	type WorkflowPackageManagerCommand,
} from "./workflow-package-manager.ts"

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
	/** Test seam replacing package installation, including package-manager resolution. */
	readonly install?: WorkflowPackageInstaller
	/** Test seam used when exercising production command construction with a fake installer. */
	readonly resolvePackageManager?: (signal: AbortSignal | undefined) => Promise<WorkflowPackageManagerCommand>
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
	let packageManager: WorkflowPackageManagerCommand | undefined
	if (!options.install || options.resolvePackageManager) {
		try {
			packageManager = await (options.resolvePackageManager ?? resolveWorkflowPackageManager)(options.signal)
		} catch (error) {
			throw new WorkflowPackagePreparationError(describe(error))
		}
	}

	await mkdir(directory, { recursive: true })
	if (changed) await writeFile(manifestPath, rendered, "utf8")

	if (installRequired) {
		let result: WorkflowPackageInstallResult
		try {
			result = options.install
				? await options.install(directory, options.signal)
				: await runInstall(directory, options.signal, requirePackageManager(packageManager))
		} catch (error) {
			throw new WorkflowPackagePreparationError(
				error instanceof WorkflowPackagePreparationError
					? error.message
					: pnpmStartupError(error instanceof Error ? error : new Error(String(error))),
			)
		}
		if (result.code !== 0) {
			throw new WorkflowPackagePreparationError(
				`pnpm could not prepare the workflow package (exit ${result.code})${commandDiagnostic(result)}\nRetry: ${installCommand(directory, packageManager)}`,
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
		verifyCommand: verifyCommand(packageManager),
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

function runInstall(
	directory: string,
	signal: AbortSignal | undefined,
	packageManager: WorkflowPackageManagerCommand,
): Promise<WorkflowPackageInstallResult> {
	return runWorkflowPackageManager(packageManager, installArgs(directory), {
		cwd: directory,
		signal,
		timeoutMs: INSTALL_TIMEOUT_MS,
		timeoutError: () => new WorkflowPackagePreparationError(`pnpm install exceeded ${INSTALL_TIMEOUT_MS}ms`),
		outputLimit: OUTPUT_LIMIT,
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

function installCommand(directory: string, packageManager: WorkflowPackageManagerCommand | undefined): string {
	return packageManager
		? formatWorkflowPackageManagerCommand(packageManager, installArgs(directory))
		: ["pnpm", ...installArgs(directory)]
				.map((argument) => (/^[\w./:@-]+$/.test(argument) ? argument : JSON.stringify(argument)))
				.join(" ")
}

function verifyCommand(packageManager: WorkflowPackageManagerCommand | undefined): string {
	const args = ["run", "verify:workflow", "--", "--entry", "<workflow.ts>", "--test", "<workflow.test.ts>"]
	return packageManager ? formatWorkflowPackageManagerCommand(packageManager, args) : ["pnpm", ...args].join(" ")
}

function requirePackageManager(
	packageManager: WorkflowPackageManagerCommand | undefined,
): WorkflowPackageManagerCommand {
	if (packageManager) return packageManager
	throw new WorkflowPackagePreparationError("workflow package manager was not resolved")
}

function executableName(name: string): string {
	return process.platform === "win32" ? `${name}.cmd` : name
}

function commandDiagnostic(command: WorkflowPackageInstallResult): string {
	const diagnostic = [command.stderr.trim(), command.stdout.trim()].filter(Boolean).join("\n")
	return diagnostic ? `\n${diagnostic}` : ""
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
