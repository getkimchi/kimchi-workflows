import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "..")
const generator = path.join(repoRoot, "scripts/generate-distribution-metadata.mjs")
const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("distribution metadata", () => {
	it("generates a non-placeholder release version", async () => {
		const fixture = await distributionFixture("1.2.3")

		const source = await readFile(fixture.distributionPath, "utf8")
		expect(source).toContain('version: "1.2.3"')
		expect(source).toContain('packageManager: "pnpm@10.33.0"')
	})

	it("prepares a project package from a Bun executable without package metadata on disk", async () => {
		const fixture = await distributionFixture("1.2.3")
		const workflowPackagePath = path.join(fixture.root, "src/host/workflow-package.ts")
		const workflowPrerequisitesPath = path.join(fixture.root, "src/host/workflow-prerequisites.ts")
		const entryPath = path.join(fixture.root, "test/fixtures/compiled-workflow-package-probe.ts")
		const executablePath = path.join(fixture.root, process.platform === "win32" ? "probe.exe" : "probe")
		await mkdir(path.dirname(entryPath), { recursive: true })
		await copyFile(path.join(repoRoot, "src/host/workflow-package.ts"), workflowPackagePath)
		await copyFile(path.join(repoRoot, "src/host/workflow-prerequisites.ts"), workflowPrerequisitesPath)
		await copyFile(path.join(repoRoot, "test/fixtures/compiled-workflow-package-probe.ts"), entryPath)

		await exec("bun", ["build", entryPath, "--compile", `--outfile=${executablePath}`], {
			cwd: fixture.root,
			timeout: 30_000,
		})
		await Promise.all([
			rm(fixture.manifestPath),
			rm(path.join(fixture.root, "src"), { recursive: true }),
			rm(path.join(fixture.root, "test"), { recursive: true }),
		])

		const { stdout } = await exec(executablePath, [], { cwd: fixture.root, timeout: 30_000 })
		expect(JSON.parse(stdout)).toEqual({ framework: "1.2.3", packageManager: "pnpm@10.33.0" })
	})
})

async function distributionFixture(version: string): Promise<{
	root: string
	manifestPath: string
	distributionPath: string
}> {
	const root = await mkdtemp(path.join(tmpdir(), "kimchi-workflows-distribution-"))
	temporaryDirectories.push(root)
	const manifestPath = path.join(root, "package.json")
	const distributionPath = path.join(root, "src/host/distribution.ts")
	await mkdir(path.dirname(distributionPath), { recursive: true })
	await writeFile(
		manifestPath,
		`${JSON.stringify({
			name: "@kimchi-dev/kimchi-workflows",
			version,
			kimchiWorkflows: { packageManager: "pnpm@10.33.0" },
			dependencies: {
				"@types/node": "^22.19.18",
				typescript: "^7.0.2",
				vitest: "4.1.10",
			},
			devDependencies: {
				"@earendil-works/pi-coding-agent": "0.84.1",
				"@earendil-works/pi-tui": "0.84.1",
				typebox: "1.3.7",
			},
		})}\n`,
		"utf8",
	)
	await exec(process.execPath, [generator, "--manifest", manifestPath, "--output", distributionPath], {
		cwd: repoRoot,
		timeout: 30_000,
	})
	return { root, manifestPath, distributionPath }
}
