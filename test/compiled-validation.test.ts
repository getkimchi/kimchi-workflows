import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { workflowsDir } from "../src/host/project-dir.ts"
import { prepareWorkflowPackageFixture } from "./workflow-package-fixture.ts"

const exec = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, "..")
const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("compiled validation environment", () => {
	it("validates and runs an external workflow through only the central project package", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "kimchi-workflows-compiled-validation-"))
		temporaryDirectories.push(root)
		const projectRoot = path.join(root, "project")
		const entryPath = path.join(projectRoot, "automation", "external.workflow.ts")
		const dependencyRoot = path.join(projectRoot, "node_modules", "project-greeting")
		const executablePath = path.join(root, process.platform === "win32" ? "validation-probe.exe" : "validation-probe")
		await prepareWorkflowPackageFixture({ directory: workflowsDir(projectRoot) })
		await Promise.all([mkdir(path.dirname(entryPath), { recursive: true }), mkdir(dependencyRoot, { recursive: true })])
		await Promise.all([
			writeFile(
				path.join(dependencyRoot, "package.json"),
				`${JSON.stringify({
					name: "project-greeting",
					type: "module",
					exports: { types: "./index.d.ts", import: "./index.js" },
				})}\n`,
				"utf8",
			),
			writeFile(path.join(dependencyRoot, "index.d.ts"), 'export declare const greeting: "hello"\n', "utf8"),
			writeFile(path.join(dependencyRoot, "index.js"), 'export const greeting = "hello"\n', "utf8"),
			writeFile(
				entryPath,
				`import { Type } from "typebox"
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { greeting } from "project-greeting"
const greet = createStep({
	name: "greet",
	output: Type.Object({ greeting: Type.String() }),
	run: () => ({ greeting }),
})
export default createWorkflow({ name: "compiled-external" }).then(greet).commit()
`,
				"utf8",
			),
		])

		await exec(
			"bun",
			[
				"build",
				path.join(repoRoot, "test/fixtures/compiled-validation-probe.ts"),
				"--compile",
				`--outfile=${executablePath}`,
			],
			{ cwd: repoRoot, timeout: 60_000 },
		)
		const { stdout } = await exec(executablePath, [projectRoot, entryPath], { cwd: root, timeout: 30_000 })

		expect(JSON.parse(stdout)).toEqual({ name: "compiled-external", output: { greeting: "hello" } })
	})
})
