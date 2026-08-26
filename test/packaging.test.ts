import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createFakeActiveRuns } from "./helpers.ts"
import { scriptedAgent } from "./scripted-agent.ts"

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "..")
// Packing and packed verification cross real Node, pnpm, and Vitest process boundaries. The verifier
// owns a 90-second timeout, so its outer Vitest budget must leave time to terminate and reap children.
const PACKAGING_TIMEOUT_MS = 120_000

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

		// `pnpm pack` runs prepack, so this builds and packs exactly what publication uploads.
		const { stdout } = await exec("pnpm", ["pack", "--json", "--pack-destination", workDir], {
			cwd: repoRoot,
		})
		const jsonStart = stdout.indexOf('{\n  "name"')
		if (jsonStart < 0) throw new Error(`pnpm pack did not emit package JSON: ${stdout}`)
		const packed = JSON.parse(stdout.slice(jsonStart)) as { filename?: string } | [{ filename: string }]
		const filename = Array.isArray(packed) ? packed[0].filename : packed.filename
		if (!filename) throw new Error(`pnpm pack did not report a filename: ${stdout}`)
		const tarball = path.isAbsolute(filename) ? filename : path.join(workDir, filename)
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
	}, PACKAGING_TIMEOUT_MS)

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

	it("stamps packed distribution metadata from the packed manifest", async () => {
		const distributionModule = pathToFileURL(path.join(packedRoot, "dist/host/distribution.js")).href
		const { distribution } = (await import(distributionModule)) as {
			distribution: { name: string; version: string; packageManager: string }
		}
		const packedManifest = JSON.parse(await readFile(path.join(packedRoot, "package.json"), "utf8")) as {
			name: string
			version: string
			packageManager?: string
			kimchiWorkflows?: { packageManager?: string }
		}

		expect(distribution.name).toBe(packedManifest.name)
		expect(distribution.version).toBe(packedManifest.version)
		expect(distribution.packageManager).toBe(
			packedManifest.kimchiWorkflows?.packageManager ?? packedManifest.packageManager,
		)
		expect(distribution.version).toMatch(/^\d+\.\d+\.\d+/)
	})

	it("ships its package-owned verification command", () => {
		expect(existsSync(path.join(packedRoot, "bin/kimchi-workflows.mjs"))).toBe(true)
	})

	it("runs built-in create, answered resume, and status through the compiled host", async () => {
		const commandsModule = pathToFileURL(path.join(packedRoot, "dist/host/commands/index.js")).href
		const storeModule = pathToFileURL(path.join(packedRoot, "dist/host/memory-store.js")).href
		const [{ handleCreate, handleResume, handleStatus }, { createMemoryStore }] = await Promise.all([
			import(commandsModule),
			import(storeModule),
		])
		const store = createMemoryStore()
		const activeRuns = createFakeActiveRuns()
		const notes: [string, string | undefined][] = []
		const inputs: (string | undefined)[] = [undefined]
		const ctx = {
			cwd: workDir,
			mode: "print",
			hasUI: false,
			modelRegistry: {},
			ui: {
				notify: (message: string, type?: string) => void notes.push([message, type]),
				input: async () => inputs.shift(),
				select: async () => undefined,
				confirm: async () => false,
				setWidget: () => {},
				setWorkingMessage: () => {},
			},
		}
		const agent = scriptedAgent([
			[
				JSON.stringify({
					questions: {
						title: "Clarify delivery",
						questions: [
							{
								key: "delivery",
								header: "Delivery",
								question: "How should the release notes be delivered?",
								kind: "text",
							},
						],
					},
				}),
			],
		])

		await handleCreate(ctx, store, activeRuns, agent.startAgent)
		const runId = (await store.list())[0]?.runId as string
		expect((await store.list())[0]?.status).toBe("blocked")

		inputs.push("Build a release-notes workflow", undefined)
		await handleResume(ctx, store, activeRuns, agent.startAgent, runId)

		const events = await store.loadEvents(runId)
		const provenance = events.find((event: { type: string }) => event.type === "run-meta") as
			| { workflowSource: { kind: string; id: string } }
			| undefined
		expect(provenance?.workflowSource).toEqual({ kind: "builtin", id: "create" })
		expect(provenance).not.toHaveProperty("workflowFilePath")
		expect(events).toContainEqual(expect.objectContaining({ type: "step-completed", path: "goal" }))
		expect(events.filter((event: { type: string }) => event.type === "questionnaire-asked")).toHaveLength(2)
		expect(agent.opened).toBe(1)

		notes.length = 0
		await handleStatus(ctx, store, { activeRunIds: () => [], width: 76 }, runId)
		expect(notes).toHaveLength(1)
		expect(notes[0]?.[0]).toContain("builtin:create")
		expect(notes[0]?.[0]).toContain("goal")
		expect(notes[0]?.[0]).toContain("design")
		expect(notes[0]?.[1]).toBe("info")
	})

	it("prepares a project workflow package from the packed install", async () => {
		const workflowDirectory = path.join(workDir, "prepared-project/.kimchi/workflows")
		const workflowPackageModule = pathToFileURL(path.join(packedRoot, "dist/host/workflow-package.js")).href
		const { prepareWorkflowPackage } = await import(workflowPackageModule)

		const prepared = await prepareWorkflowPackage({
			directory: workflowDirectory,
			install: async (directory: string) => {
				await mkdir(path.join(directory, "node_modules/.bin"), { recursive: true })
				await Promise.all([
					writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8"),
					writeFile(path.join(directory, "node_modules/.bin/kimchi-workflows"), "", "utf8"),
				])
				return { code: 0, stdout: "", stderr: "" }
			},
		})
		const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8")) as { packageManager?: string }

		expect(manifest.packageManager).toMatch(/^pnpm@/)
	})

	it("runs focused verification from the packed install", verifyPackedWorkflow, PACKAGING_TIMEOUT_MS)

	async function verifyPackedWorkflow() {
		const projectRoot = path.join(workDir, "verification-project")
		const workflowDirectory = path.join(projectRoot, ".kimchi/workflows")
		const modules = path.join(workflowDirectory, "node_modules")
		await Promise.all([
			mkdir(path.join(modules, ".bin"), { recursive: true }),
			mkdir(path.join(modules, "@kimchi-dev"), { recursive: true }),
			mkdir(path.join(modules, "@earendil-works"), { recursive: true }),
		])
		await Promise.all([
			writeFile(
				path.join(workflowDirectory, "package.json"),
				`${JSON.stringify({
					name: "packed-workflow-project",
					private: true,
					type: "module",
					scripts: { "verify:workflow": "kimchi-workflows verify" },
				})}\n`,
				"utf8",
			),
			symlink(packedRoot, path.join(modules, "@kimchi-dev/kimchi-workflows")),
			symlink(
				path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent"),
				path.join(modules, "@earendil-works/pi-coding-agent"),
			),
			symlink(path.join(repoRoot, "node_modules/@earendil-works/pi-tui"), path.join(modules, "@earendil-works/pi-tui")),
			symlink(path.join(packedRoot, "bin/kimchi-workflows.mjs"), path.join(modules, ".bin/kimchi-workflows")),
			...["@types", "typebox", "typescript", "vitest"].map((name) =>
				symlink(path.join(repoRoot, "node_modules", name), path.join(modules, name)),
			),
		])
		const entryPath = path.join(workflowDirectory, "packed.workflow.ts")
		await writeFile(
			entryPath,
			`import { createStep, createWorkflow } from ${JSON.stringify(pkg.name)}
const greet = createStep({ name: "greet", run: () => "hello" })
export default createWorkflow({ name: "packed" }).then(greet).commit()
`,
			"utf8",
		)
		const testPath = path.join(workflowDirectory, "packed.workflow.test.ts")
		await writeFile(
			testPath,
			`import { expect, it } from "vitest"
import { createTestRun } from ${JSON.stringify(`${pkg.name}/testing`)}
import workflow from "./packed.workflow.ts"
it("runs", async () => expect((await createTestRun(workflow)).output).toBe("hello"))
`,
			"utf8",
		)
		const verifierProbe = path.join(workDir, "consumer/verify-packed.mjs")
		const verifierModule = pathToFileURL(path.join(packedRoot, "dist/host/workflow-test-verifier.js")).href
		await writeFile(
			verifierProbe,
			`import { verifyWorkflowTest } from ${JSON.stringify(verifierModule)}
const result = await verifyWorkflowTest(${JSON.stringify({ entryPath, packageRoot: workflowDirectory, testPath })})
console.log(JSON.stringify(result))
`,
			"utf8",
		)

		const { stdout } = await exec(process.execPath, [verifierProbe], { cwd: path.dirname(verifierProbe) })
		expect(JSON.parse(stdout)).toMatchObject({ files: 1, tests: 1, passedTests: 1 })
	}
})
