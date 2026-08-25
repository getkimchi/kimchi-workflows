import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	verifyWorkflowTest,
	WorkflowTestInfrastructureError,
	WorkflowTestVerificationError,
} from "../src/host/workflow-test-verifier.ts"
import { prepareWorkflowPackageFixture } from "./workflow-package-fixture.ts"

const temporaryProjects: string[] = []

afterEach(async () => {
	await Promise.all(temporaryProjects.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function projectWithTest(testBody: string): Promise<{
	root: string
	entryPath: string
	testPath: string
}> {
	const root = await mkdtemp(path.join(tmpdir(), "kimchi-workflow-verifier-"))
	temporaryProjects.push(root)
	const modules = path.join(root, "node_modules")
	const dependencyDirectory = path.join(modules, "project-greeting")
	await prepareWorkflowPackageFixture({ directory: root })
	await mkdir(dependencyDirectory, { recursive: true })
	await Promise.all([
		writeFile(
			path.join(dependencyDirectory, "package.json"),
			JSON.stringify({ name: "project-greeting", type: "module", exports: "./index.js", types: "./index.d.ts" }),
			"utf8",
		),
		writeFile(path.join(dependencyDirectory, "index.js"), 'export const greeting = "hello"\n', "utf8"),
		writeFile(path.join(dependencyDirectory, "index.d.ts"), 'export declare const greeting: "hello"\n', "utf8"),
	])

	const entryPath = path.join(root, "greeting.workflow.ts")
	await writeFile(
		entryPath,
		`import { Type } from "typebox"
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { greeting } from "project-greeting"

const greet = createStep({
	name: "greet",
	output: Type.String(),
	run: () => greeting,
})

export default createWorkflow({ name: "greeting" }).then(greet).commit()
`,
		"utf8",
	)
	const testPath = path.join(root, "greeting.workflow.test.ts")
	await writeFile(
		testPath,
		`import { expect, it } from "vitest"
import { createTestRun } from "@kimchi-dev/kimchi-workflows/testing"
import workflow from "./greeting.workflow.ts"

it("runs the authored workflow", async () => {
	const run = await createTestRun(workflow)
	${testBody}
})
`,
		"utf8",
	)
	return { root, entryPath, testPath }
}

async function projectWithExternalTest(): Promise<{
	root: string
	packageRoot: string
	entryPath: string
	testPath: string
}> {
	const root = await mkdtemp(path.join(tmpdir(), "kimchi-external-workflow-verifier-"))
	temporaryProjects.push(root)
	const packageRoot = path.join(root, ".kimchi", "workflows")
	const authoredDirectory = path.join(root, "automations")
	const dependencyDirectory = path.join(root, "node_modules", "project-greeting")
	await Promise.all([
		prepareWorkflowPackageFixture({ directory: packageRoot }),
		mkdir(authoredDirectory, { recursive: true }),
		mkdir(dependencyDirectory, { recursive: true }),
		writeFile(
			path.join(root, "package.json"),
			`${JSON.stringify({ name: "authored-project", private: true })}\n`,
			"utf8",
		),
	])
	await Promise.all([
		writeFile(
			path.join(dependencyDirectory, "package.json"),
			JSON.stringify({ name: "project-greeting", type: "module", exports: "./index.js", types: "./index.d.ts" }),
			"utf8",
		),
		writeFile(path.join(dependencyDirectory, "index.js"), 'export const greeting = "hello"\n', "utf8"),
		writeFile(path.join(dependencyDirectory, "index.d.ts"), 'export declare const greeting: "hello"\n', "utf8"),
	])

	const entryPath = path.join(authoredDirectory, "greeting.workflow.ts")
	const testPath = path.join(authoredDirectory, "greeting.workflow.test.ts")
	await Promise.all([
		writeFile(
			entryPath,
			`import { Type } from "typebox"
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { greeting } from "project-greeting"

const greet = createStep({ name: "greet", output: Type.String(), run: () => greeting })
export default createWorkflow({ name: "external-greeting" }).then(greet).commit()
`,
			"utf8",
		),
		writeFile(
			testPath,
			`import { expect, it } from "vitest"
import { createTestRun } from "@kimchi-dev/kimchi-workflows/testing"
import workflow from "./greeting.workflow.ts"

it("runs outside the central workflow package", async () => {
	const run = await createTestRun(workflow)
	expect(run.output).toBe("hello")
})
`,
			"utf8",
		),
	])
	return { root, packageRoot, entryPath, testPath }
}

describe("workflow package verification", () => {
	it("runs one focused test with package-owned dependencies", async () => {
		const project = await projectWithTest('expect(run.output).toBe("hello")')
		await writeFile(
			path.join(project.root, "unrelated.test.ts"),
			'import { expect, it } from "vitest"\nit("would fail", () => expect(true).toBe(false))\n',
			"utf8",
		)

		await expect(
			verifyWorkflowTest({
				entryPath: project.entryPath,
				testPath: project.testPath,
				packageRoot: project.root,
			}),
		).resolves.toMatchObject({
			files: 1,
			tests: 1,
			passedTests: 1,
			summary: "TypeScript passed; focused test passed (1 test)",
		})
	})

	it("verifies authored files and project dependencies outside the central package", async () => {
		const project = await projectWithExternalTest()

		await expect(
			verifyWorkflowTest({
				entryPath: project.entryPath,
				testPath: project.testPath,
				packageRoot: project.packageRoot,
			}),
		).resolves.toMatchObject({ files: 1, tests: 1, passedTests: 1 })
	})

	it("reports assertion failures as repairable authored verification", async () => {
		const project = await projectWithTest('expect(run.output).toBe("goodbye")')

		const verification = verifyWorkflowTest({
			entryPath: project.entryPath,
			testPath: project.testPath,
			packageRoot: project.root,
		})
		await expect(verification).rejects.toBeInstanceOf(WorkflowTestVerificationError)
		await expect(verification).rejects.toThrow(/expected.*goodbye/i)
	})

	it("reports TypeScript errors as repairable authored verification", async () => {
		const project = await projectWithTest('expect(run.output).toBe("hello")')
		await writeFile(project.entryPath, "const value: string = 42\nexport default value\n", "utf8")

		await expect(
			verifyWorkflowTest({
				entryPath: project.entryPath,
				testPath: project.testPath,
				packageRoot: project.root,
			}),
		).rejects.toBeInstanceOf(WorkflowTestVerificationError)
	})

	it("rejects a submitted file that executes no tests", async () => {
		const project = await projectWithTest('expect(run.output).toBe("hello")')
		await writeFile(project.testPath, 'import { it } from "vitest"\nit.skip("not proof", () => {})\n', "utf8")

		await expect(
			verifyWorkflowTest({
				entryPath: project.entryPath,
				testPath: project.testPath,
				packageRoot: project.root,
			}),
		).rejects.toThrow("0/1 tests passed")
	})

	it("classifies a missing verifier dependency as infrastructure", async () => {
		const project = await projectWithTest('expect(run.output).toBe("hello")')
		await rm(path.join(project.root, "node_modules/typescript"))

		await expect(
			verifyWorkflowTest({
				entryPath: project.entryPath,
				testPath: project.testPath,
				packageRoot: project.root,
			}),
		).rejects.toBeInstanceOf(WorkflowTestInfrastructureError)
	})

	it("terminates verification when the workflow run is aborted", async () => {
		const project = await projectWithTest("await new Promise(() => {})")
		const controller = new AbortController()
		const verification = verifyWorkflowTest({
			entryPath: project.entryPath,
			testPath: project.testPath,
			packageRoot: project.root,
			signal: controller.signal,
		})
		setTimeout(() => controller.abort(new Error("stop verification")), 100)

		await expect(verification).rejects.toThrow("stop verification")
	})
})
