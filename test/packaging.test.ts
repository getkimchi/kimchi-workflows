import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "..")

const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
	name: string
	exports: Record<string, Record<string, string>>
}

/** `.` -> `@scope/name`, `./host` -> `@scope/name/host`. */
const specifiers = Object.keys(pkg.exports).map((sub) => (sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`))

type ProbeResult = { specifier: string; ok: boolean; exportCount?: number; error?: string }

/**
 * Every other test imports from `src/`, so none of them can see the package the way a consumer does:
 * a subpath missing from `files`, a `dist` layout that drifted from the export map, or tsc emitting an
 * extensionless relative import that typechecks but throws ERR_MODULE_NOT_FOUND under Node ESM.
 *
 * The imports run in a spawned `node`, not here — vitest resolves through vite, which would answer
 * from `src/` and prove nothing about what was packed.
 */
describe("published package", () => {
	let workDir: string
	let packedRoot: string
	let results: Map<string, ProbeResult>

	beforeAll(async () => {
		workDir = await mkdtemp(path.join(tmpdir(), "kimchi-packaging-"))
		packedRoot = path.join(workDir, "consumer/node_modules", pkg.name)
		await mkdir(packedRoot, { recursive: true })

		// `npm pack` runs prepack, so this builds and packs exactly what `npm publish` would upload.
		const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", workDir], {
			cwd: repoRoot,
		})
		const tarball = path.join(workDir, (JSON.parse(stdout) as [{ filename: string }])[0].filename)
		await exec("tar", ["-xzf", tarball, "-C", packedRoot, "--strip-components=1"])

		// Lets the packed code resolve `jiti` and the peer deps without a network install.
		await symlink(path.join(repoRoot, "node_modules"), path.join(packedRoot, "node_modules"))

		const probe = path.join(workDir, "consumer/probe.mjs")
		await writeFile(
			probe,
			`const results = []
for (const specifier of ${JSON.stringify(specifiers)}) {
	try {
		const mod = await import(specifier)
		results.push({ specifier, ok: true, exportCount: Object.keys(mod).length })
	} catch (error) {
		results.push({ specifier, ok: false, error: \`\${error.code ?? ""} \${error.message}\`.trim() })
	}
}
console.log(JSON.stringify(results))
`,
		)

		const probed = await exec(process.execPath, [probe], { cwd: path.dirname(probe) })
		results = new Map((JSON.parse(probed.stdout) as ProbeResult[]).map((r) => [r.specifier, r]))
	}, 120_000)

	afterAll(async () => {
		if (workDir) await rm(workDir, { recursive: true, force: true })
	})

	it.each(specifiers)("%s imports from a consumer install", (specifier) => {
		const result = results.get(specifier)
		expect(result, `${specifier} was never probed`).toBeDefined()
		expect(result?.error ?? "", `${specifier} failed to import`).toBe("")
		expect(result?.exportCount, `${specifier} resolved but exports nothing`).toBeGreaterThan(0)
	})

	it("ships every file the export map points at", () => {
		const missing = Object.values(pkg.exports)
			.flatMap((conditions) => Object.values(conditions))
			.filter((target) => !existsSync(path.join(packedRoot, target)))
		expect(missing, "export targets absent from the tarball").toEqual([])
	})

	it("ships the extension entry the pi manifest declares", () => {
		expect(existsSync(path.join(packedRoot, "src/host/extension.ts"))).toBe(true)
	})
})
