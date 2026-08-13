import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const INSTALL_TIMEOUT_MS = 5 * 60_000
const OUTPUT_LIMIT = 64 * 1024
const FRAMEWORK_MANIFEST_PATH = fileURLToPath(new URL("../../package.json", import.meta.url))
const FRAMEWORK_ROOT = path.dirname(FRAMEWORK_MANIFEST_PATH)

interface PackageManifest {
	readonly name?: string
	readonly version?: string
	readonly packageManager?: string
	readonly kimchiWorkflows?: {
		readonly packageManager?: string
	}
	readonly scripts?: Record<string, string>
	readonly dependencies?: Record<string, string>
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
}): Promise<WorkflowPackagePreparation> {
	const directory = path.resolve(options.directory)
	const manifestPath = path.join(directory, "package.json")
	const lockfilePath = path.join(directory, "pnpm-lock.yaml")
	await mkdir(directory, { recursive: true })

	const framework = await readManifest(FRAMEWORK_MANIFEST_PATH, "workflow framework")
	const current = existsSync(manifestPath) ? await readManifest(manifestPath, "workflow package") : {}
	const desired = workflowManifest(current, framework)
	const rendered = `${JSON.stringify(desired, null, 2)}\n`
	const previous = existsSync(manifestPath) ? await readFile(manifestPath, "utf8") : undefined
	const changed = previous !== rendered
	if (changed) await writeFile(manifestPath, rendered, "utf8")

	const verifier = path.join(directory, "node_modules", ".bin", executableName("kimchi-workflows"))
	const installRequired = changed || !existsSync(lockfilePath) || !existsSync(verifier)
	if (installRequired) {
		const result = await (options.install ?? runInstall)(directory, options.signal)
		if (result.code !== 0) {
			throw new WorkflowPackagePreparationError(
				`pnpm could not prepare the workflow package (exit ${result.code})${commandDiagnostic(result)}`,
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

function workflowManifest(current: PackageManifest, framework: PackageManifest): PackageManifest {
	const frameworkName = requiredString(framework.name, "framework package name")
	const frameworkVersion = requiredString(framework.version, "framework package version")
	const dependencies = framework.dependencies ?? {}
	const development = framework.devDependencies ?? {}
	const managedDependencies: Record<string, string> = {
		[frameworkName]: frameworkVersion === "0.0.0" ? localPackageSpecifier(FRAMEWORK_ROOT) : frameworkVersion,
		"@earendil-works/pi-coding-agent": requiredDependency(development, "@earendil-works/pi-coding-agent"),
		"@earendil-works/pi-tui": requiredDependency(development, "@earendil-works/pi-tui"),
		"@types/node": requiredDependency(dependencies, "@types/node"),
		typebox: requiredDependency(development, "typebox"),
		typescript: requiredDependency(dependencies, "typescript"),
		vitest: requiredDependency(dependencies, "vitest"),
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
		packageManager: requiredString(
			framework.kimchiWorkflows?.packageManager ?? framework.packageManager,
			"framework package manager",
		),
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

function requiredDependency(dependencies: Record<string, string>, name: string): string {
	return requiredString(dependencies[name], `framework dependency ${name}`)
}

function requiredString(value: string | undefined, label: string): string {
	if (typeof value === "string" && value.trim()) return value
	throw new WorkflowPackagePreparationError(`${label} is missing`)
}

function runInstall(directory: string, signal: AbortSignal | undefined): Promise<WorkflowPackageInstallResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal))
			return
		}
		const ownsProcessGroup = process.platform !== "win32"
		const child = spawn(
			"pnpm",
			["--dir", directory, "--ignore-workspace", "install", "--no-frozen-lockfile", "--ignore-scripts"],
			{
				cwd: directory,
				detached: ownsProcessGroup,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
			},
		)
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
						: new WorkflowPackagePreparationError(`could not start pnpm: ${describe(error)}`),
				)
			} else if (result) resolve(result)
			else reject(new WorkflowPackagePreparationError("pnpm install ended without a process result"))
		}
	})
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
