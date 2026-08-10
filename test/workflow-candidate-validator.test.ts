import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { workflowsDir } from "../src/host/project-dir.ts"
import { validateWorkflowCandidate, validateWorkflowFile } from "../src/host/workflow-candidate-validator.ts"

const VALID_SOURCE = `import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const inputSchema = Type.Object({ name: Type.String() })
const outputSchema = Type.Object({ greeting: Type.String() })
const greet = createStep({
  name: "greet",
  input: inputSchema,
  output: outputSchema,
  run: ({ input }) => ({ greeting: \`Hello \${input.name}\` }),
})

export default createWorkflow({ name: "greet", input: inputSchema }).then(greet).commit()
`

const INVALID_TYPE_SOURCE = VALID_SOURCE.replace("input.name", "input.missing")
const NODE_IMPORT_SOURCE = `import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Type } from "typebox"
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"

const inputSchema = Type.Object({ name: Type.String() })
const outputSchema = Type.Object({ greeting: Type.String() })
const execFileAsync = promisify(execFile)
const greet = createStep({
  name: "greet",
  input: inputSchema,
  output: outputSchema,
  run: async ({ input, abortSignal }) => {
    await execFileAsync("echo", [input.name], { signal: abortSignal })
    return { greeting: \`Hello \${input.name}\` }
  },
})

export default createWorkflow({ name: "greet", input: inputSchema }).then(greet).commit()
`

describe("workflow candidate validation", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
	})

	async function project(): Promise<{ root: string; target: string }> {
		const root = await mkdtemp(path.join(tmpdir(), "workflow-validation-"))
		roots.push(root)
		const directory = workflowsDir(root)
		await mkdir(directory, { recursive: true })
		return { root, target: path.join(directory, "greet.workflow.ts") }
	}

	it("typechecks and loads a workflow in a dependency-free project", async () => {
		const { root, target } = await project()

		const result = await validateWorkflowCandidate({ source: VALID_SOURCE, targetPath: target, projectRoot: root })

		expect(result.workflow.name).toBe("greet")
		expect(result.checks).toEqual({
			typescript: "passed",
			runtime: "passed",
			conformance: "skipped",
		})
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("launches TypeScript's native compiler rather than the packaged Kimchi executable", async () => {
		const { root, target } = await project()
		let compilerCommand = ""

		await validateWorkflowCandidate({
			source: VALID_SOURCE,
			targetPath: target,
			projectRoot: root,
			runCommand: async (request) => {
				compilerCommand = request.command
				return { code: 0, stdout: "", stderr: "" }
			},
		})

		expect(compilerCommand).not.toBe(process.execPath)
		expect(path.basename(compilerCommand)).toMatch(/^tsc(?:\.exe)?$/)
	})

	it("typechecks named Node imports without target-project dependencies", async () => {
		const { root, target } = await project()

		const result = await validateWorkflowCandidate({
			source: NODE_IMPORT_SOURCE,
			targetPath: target,
			projectRoot: root,
		})

		expect(result.checks.typescript).toBe("passed")
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("validates an on-disk entry module and follows its relative TypeScript imports", async () => {
		const { root, target } = await project()
		const helper = path.join(path.dirname(target), "greeting.ts")
		await Promise.all([
			writeFile(
				target,
				`import { createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { greet } from "./greeting.ts"
export default createWorkflow({ name: "greet" }).then(greet).commit()
`,
				"utf8",
			),
			writeFile(
				helper,
				`import { createStep } from "@kimchi-dev/kimchi-workflows"
export const greet = createStep({ name: "greet", run: () => ({ greeting: "hello" }) })
`,
				"utf8",
			),
		])

		const result = await validateWorkflowFile({ entryPath: target, projectRoot: root })

		expect(result.workflow.name).toBe("greet")
		expect(result.checks.typescript).toBe("passed")
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("reports a type error originating in a helper imported by an on-disk entry module", async () => {
		const { root, target } = await project()
		const helper = path.join(path.dirname(target), "greeting.ts")
		await Promise.all([
			writeFile(
				target,
				`import { createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { greet } from "./greeting.ts"
export default createWorkflow({ name: "greet" }).then(greet).commit()
`,
				"utf8",
			),
			writeFile(
				helper,
				`import { Type } from "typebox"
import { createStep } from "@kimchi-dev/kimchi-workflows"
export const greet = createStep({
  name: "greet",
  output: Type.Object({ greeting: Type.String() }),
  run: () => ({ greeting: 42 }),
})
`,
				"utf8",
			),
		])

		const validation = validateWorkflowFile({ entryPath: target, projectRoot: root })

		await expect(validation).rejects.toMatchObject({ stage: "typescript" })
		await expect(validation).rejects.toThrow(/number.*not assignable.*string/i)
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("rejects schema-derived callback type errors and removes every probe", async () => {
		const { root, target } = await project()

		const validation = validateWorkflowCandidate({
			source: INVALID_TYPE_SOURCE,
			targetPath: target,
			projectRoot: root,
		})

		await expect(validation).rejects.toMatchObject({ stage: "typescript" })
		await expect(validation).rejects.toThrow(/Property 'missing' does not exist/)
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("labels caller-provided conformance failures", async () => {
		const { root, target } = await project()

		const validation = validateWorkflowCandidate({
			source: VALID_SOURCE,
			targetPath: target,
			projectRoot: root,
			conformance: () => "approved structure changed",
		})

		await expect(validation).rejects.toMatchObject({ stage: "conformance" })
		await expect(validation).rejects.toThrow(/approved structure changed/)
		expect(await validationArtifacts(target)).toEqual([])
	})
})

async function validationArtifacts(target: string): Promise<string[]> {
	return (await readdir(path.dirname(target))).filter((name) => name.startsWith(".pi-create-"))
}
