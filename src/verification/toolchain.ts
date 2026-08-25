/**
 * Resolve the static-validation and verification toolchain from a package environment.
 *
 * The project workflow package (`.kimchi/workflows`) is the explicit validation environment
 * (bundled-extension plan, phase 2): everything validation needs — framework declarations, TypeBox,
 * PI/TUI/Vitest types, Node type roots, the TypeScript compiler, and the runtime modules a verified test
 * executes — is resolved THROUGH that package, never from wherever this extension happens to live.
 * A production path that reached for the extension's own installation (`import.meta.url`-relative)
 * would resolve inside Bun's virtual filesystem once the harness is a compiled binary.
 *
 * Layering: this module sits below `host/` (hosts import it; it imports nothing from hosts), and
 * beside `verify.ts`, whose package-owned verifier consults the same environment for its tsc
 * `paths` and vitest aliases.
 */
import { existsSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

export interface ValidationToolchain {
	readonly compiler: string
	readonly nodeTypesRoot: string
	readonly paths: Readonly<Record<string, readonly string[]>>
}

export interface InstalledPackage {
	readonly name: string
	readonly directory: string
	readonly manifestPath: string
	readonly manifest: PackageManifest
}

interface PackageManifest {
	readonly name?: unknown
	readonly main?: unknown
	readonly module?: unknown
	readonly types?: unknown
	readonly typings?: unknown
	readonly exports?: unknown
	readonly typesVersions?: unknown
}

/** Build static validation from the one explicitly prepared project workflow package. */
export async function resolveValidationToolchain(packageRoot: string): Promise<ValidationToolchain> {
	const [framework, typebox, pi, tui, node, typescript, vitest] = await Promise.all([
		readInstalledPackage(packageRoot, "@kimchi-dev/kimchi-workflows"),
		readInstalledPackage(packageRoot, "typebox"),
		readInstalledPackage(packageRoot, "@earendil-works/pi-coding-agent"),
		readInstalledPackage(packageRoot, "@earendil-works/pi-tui"),
		readInstalledPackage(packageRoot, "@types/node"),
		readInstalledPackage(packageRoot, "typescript"),
		readInstalledPackage(packageRoot, "vitest"),
	])
	return {
		compiler: typeScriptCompiler(typescript.manifestPath),
		nodeTypesRoot: path.dirname(path.dirname(node.manifestPath)),
		paths: {
			...frameworkTypePaths(framework),
			...declarationPaths(typebox),
			...declarationPaths(pi),
			...declarationPaths(tui),
			...declarationPaths(vitest),
		},
	}
}

/**
 * Resolve the runtime module for one specifier exported by `pkg`: the installed JavaScript named by
 * the package's own exports map, or the package's TypeScript source for a clean `file:` install
 * (`pnpm --ignore-scripts` runs no prepack, so `dist/` may not exist yet — the equally authoritative
 * source stands in, mirroring {@link frameworkTypePaths}). Anything else throws the original
 * resolution error: a runtime module the environment cannot name is an infrastructure failure.
 */
export function resolveRuntimeModule(pkg: InstalledPackage, specifier: string): string {
	const exportKey = packageExportKey(pkg.name, specifier)
	const exported = packageExportValue(pkg.manifest.exports, exportKey)
	const target =
		findRuntimeCondition(exported) ??
		(exportKey === "." ? (stringValue(pkg.manifest.module) ?? stringValue(pkg.manifest.main)) : undefined)
	if (target) {
		const resolved = path.resolve(pkg.directory, target)
		if (existsSync(resolved)) return resolved
	}
	const source = sourceLayoutEntry(pkg, specifier)
	if (source) return source
	throw new Error(`${pkg.name} does not expose a resolvable runtime module for ${specifier}`)
}

function packageExportKey(packageName: string, specifier: string): string {
	if (specifier === packageName) return "."
	if (specifier.startsWith(`${packageName}/`)) return `./${specifier.slice(packageName.length + 1)}`
	return `./${specifier}`
}

function packageExportValue(exportsField: unknown, exportKey: string): unknown {
	if (isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith("."))) {
		return exportsField[exportKey]
	}
	return exportKey === "." ? exportsField : undefined
}

function findRuntimeCondition(value: unknown): string | undefined {
	if (typeof value === "string") return isDeclarationPath(value) ? undefined : value
	if (Array.isArray(value)) {
		for (const item of value) {
			const target = findRuntimeCondition(item)
			if (target) return target
		}
		return undefined
	}
	if (!isRecord(value)) return undefined
	for (const condition of ["import", "default", "node", "require"]) {
		const target = findRuntimeCondition(value[condition])
		if (target) return target
	}
	for (const [condition, nested] of Object.entries(value)) {
		if (condition === "types") continue
		const target = findRuntimeCondition(nested)
		if (target) return target
	}
	return undefined
}

/** The `src/<layer>/index.ts` layout entry for one of a package's exported specifiers, when it exists. */
function sourceLayoutEntry(pkg: InstalledPackage, specifier: string): string | undefined {
	if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) return undefined
	const layer = specifier === pkg.name ? "flow" : specifier.slice(pkg.name.length + 1)
	if (!layer || layer.includes("/")) return undefined
	const source = path.join(pkg.directory, "src", layer, "index.ts")
	return existsSync(source) ? source : undefined
}

function frameworkTypePaths(pkg: InstalledPackage): Record<string, readonly string[]> {
	try {
		return declarationPaths(pkg)
	} catch {
		// Published packages provide dist declarations. A local `file:` install intentionally skips
		// lifecycle scripts, so a clean checkout may contain only the equally authoritative TS source.
		const paths: Record<string, readonly string[]> = {}
		for (const [exportKey, exported] of packageExportEntries(pkg.manifest.exports)) {
			const source = frameworkSourceTypePath(pkg, exportKey, exported)
			const specifier = exportKey === "." ? pkg.name : `${pkg.name}${exportKey.slice(1)}`
			paths[specifier] = [source]
		}
		if (!paths[pkg.name]) {
			throw new Error(`${pkg.name} does not expose a root export that can be mapped to TypeScript source`)
		}
		return paths
	}
}

/** Map a generated `dist` declaration export back to its package-owned TypeScript source. */
function frameworkSourceTypePath(pkg: InstalledPackage, exportKey: string, exported: unknown): string {
	const target = declarationTarget(pkg, exportKey, exported)
	if (!target) throw new Error(`${pkg.name} export ${exportKey} has no declaration target to map to source`)

	const declaration = path.resolve(pkg.directory, target)
	const relativeDeclaration = path.relative(path.join(pkg.directory, "dist"), declaration)
	if (
		!relativeDeclaration ||
		path.isAbsolute(relativeDeclaration) ||
		relativeDeclaration === ".." ||
		relativeDeclaration.startsWith(`..${path.sep}`)
	) {
		throw new Error(`${pkg.name} cannot map export ${exportKey} declaration target to source: ${target}`)
	}
	const relativeSource = relativeDeclaration.replace(/\.d\.(ts|mts|cts)$/, ".$1")
	if (relativeSource === relativeDeclaration) {
		throw new Error(`${pkg.name} cannot map export ${exportKey} declaration target to source: ${target}`)
	}
	const source = path.join(pkg.directory, "src", relativeSource)
	if (!existsSync(source)) {
		throw new Error(`${pkg.name} maps export ${exportKey} to a missing source type entry: ${source}`)
	}
	return source
}

export async function readInstalledPackage(packageRoot: string, name: string): Promise<InstalledPackage> {
	const resolvedRoot = path.resolve(packageRoot)
	const installedDirectory = path.join(resolvedRoot, "node_modules", ...name.split("/"))
	const installedManifest = path.join(installedDirectory, "package.json")
	const rootManifest = path.join(resolvedRoot, "package.json")
	let directory = installedDirectory
	let manifestPath = installedManifest
	if (!existsSync(installedManifest) && existsSync(rootManifest)) {
		try {
			const rootPackage = JSON.parse(await readFile(rootManifest, "utf8")) as PackageManifest
			if (rootPackage.name === name) {
				directory = resolvedRoot
				manifestPath = rootManifest
			}
		} catch {
			// The regular diagnostic below describes an unreadable/malformed selected manifest.
		}
	}
	if (!existsSync(manifestPath) && existsSync(rootManifest)) {
		// npm commonly hoists dependencies beside the package that owns this root. Resolve from its
		// manifest instead of assuming every dependency is nested inside the package directory.
		const hoistedManifest = await resolveHoistedPackageManifest(rootManifest, name)
		if (!hoistedManifest) throw new MissingValidationPackageError(name, resolvedRoot, installedManifest)
		manifestPath = hoistedManifest
		directory = path.dirname(manifestPath)
	}
	let manifest: PackageManifest
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest
	} catch (error) {
		if (!existsSync(manifestPath)) throw new MissingValidationPackageError(name, resolvedRoot, manifestPath, error)
		throw new Error(`could not read workflow validation package ${name} at ${manifestPath}: ${describe(error)}`)
	}
	if (manifest.name !== name) {
		throw new Error(`prepared workflow package entry ${manifestPath} identifies itself as ${String(manifest.name)}`)
	}
	return { name, directory, manifestPath, manifest }
}

async function resolveHoistedPackageManifest(rootManifest: string, name: string): Promise<string | undefined> {
	const packageRequire = createRequire(rootManifest)
	try {
		return packageRequire.resolve(`${name}/package.json`)
	} catch {
		// Packages commonly hide package.json behind `exports`; resolve their public entry and walk
		// upward to the owning manifest instead.
	}

	let entry: string
	try {
		entry = packageRequire.resolve(name)
	} catch {
		return undefined
	}

	let directory = path.dirname(realpathSync(entry))
	for (;;) {
		const candidate = path.join(directory, "package.json")
		if (existsSync(candidate)) {
			try {
				const manifest = JSON.parse(await readFile(candidate, "utf8")) as PackageManifest
				if (manifest.name === name) return candidate
			} catch {
				// Keep walking: the public entry may sit below an unrelated nested package boundary.
			}
		}
		const parent = path.dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

export class MissingValidationPackageError extends Error {
	constructor(name: string, packageRoot: string, manifestPath: string, cause?: unknown) {
		super(
			`workflow validation package ${packageRoot} is missing ${name} at ${manifestPath}` +
				(cause === undefined ? "" : `: ${describe(cause)}`),
		)
		this.name = "MissingValidationPackageError"
	}
}

function declarationPaths(pkg: InstalledPackage): Record<string, readonly string[]> {
	const entries = packageExportEntries(pkg.manifest.exports)
	const paths: Record<string, readonly string[]> = {}
	for (const [exportKey, exported] of entries) {
		const target = declarationTarget(pkg, exportKey, exported)
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

function declarationTarget(pkg: InstalledPackage, exportKey: string, exported: unknown): string | undefined {
	return (
		findTypesCondition(exported) ??
		findTypesVersionTarget(pkg.manifest.typesVersions, exportKey) ??
		(exportKey === "." ? (stringValue(pkg.manifest.types) ?? stringValue(pkg.manifest.typings)) : undefined)
	)
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

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
