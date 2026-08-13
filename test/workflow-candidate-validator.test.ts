import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { workflowsDir } from "../src/host/project-dir.ts"
import { validateWorkflowCandidate, validateWorkflowFile } from "../src/host/workflow-candidate-validator.ts"
import { prepareWorkflowPackageFixture } from "./workflow-package-fixture.ts"

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

const ADVANCED_TYPEBOX_SOURCE = `import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const inputSchema = Type.Intersect([
  Type.Object({ first: Type.String() }),
  Type.Object({ last: Type.String() }),
])
const greet = createStep({
  name: "greet",
  input: inputSchema,
  output: Type.Object({ greeting: Type.String() }),
  run: ({ input }) => ({ greeting: \`Hello \${input.first} \${input.last}\` }),
})

export default createWorkflow({ name: "greet", input: inputSchema }).then(greet).commit()
`

const INTERACTIVE_SOURCE = `import { createInteractiveStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const choose = createInteractiveStep({
  name: "choose",
  request: Type.Object({ options: Type.Array(Type.String()) }),
  output: Type.Object({ choice: Type.String() }),
  buildRequest: () => ({ options: ["yes", "no"] }),
  render: async ({ request, ui, mode }) => {
    ui.notify(\`Running in \${mode}\`, "info")
    const choice = await ui.select("Choose", request.options)
    return choice ? { choice } : undefined
  },
})

export default createWorkflow({ name: "choose" }).then(choose).commit()
`

describe("workflow candidate validation", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
	})

	async function project(options: { sourceOnlyFramework?: boolean } = {}): Promise<{
		root: string
		target: string
		packageRoot: string
	}> {
		const root = await mkdtemp(path.join(tmpdir(), "workflow-validation-"))
		roots.push(root)
		const directory = workflowsDir(root)
		await prepareWorkflowPackageFixture({ directory, sourceOnlyFramework: options.sourceOnlyFramework })
		return { root, target: path.join(directory, "greet.workflow.ts"), packageRoot: directory }
	}

	it("typechecks and loads a workflow against its prepared package", async () => {
		const { root, target, packageRoot } = await project()

		const result = await validateWorkflowCandidate({
			source: VALID_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
		})

		expect(result.workflow.name).toBe("greet")
		expect(result.checks).toEqual({
			typescript: "passed",
			runtime: "passed",
			conformance: "skipped",
		})
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("uses installed declarations without generating validation shims", async () => {
		const { root, target, packageRoot } = await project()
		let validationConfig: { files: string[]; compilerOptions: { paths: Record<string, string[]> } } | undefined

		await validateWorkflowCandidate({
			source: VALID_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
			runCommand: async (request) => {
				const configPath = request.args[request.args.indexOf("--project") + 1]
				if (!configPath) throw new Error("validation command omitted --project")
				validationConfig = JSON.parse(await readFile(configPath, "utf8")) as typeof validationConfig
				return { code: 0, stdout: "", stderr: "" }
			},
		})

		expect(validationConfig?.files).toHaveLength(1)
		expect(validationConfig?.files[0]).toMatch(/\.pi-create-candidate-.*\.ts$/)
		expect(validationConfig?.compilerOptions.paths.typebox).toEqual([
			path.join(packageRoot, "node_modules/typebox/build/index.d.mts"),
		])
		expect(validationConfig?.compilerOptions.paths["@earendil-works/pi-coding-agent"]).toEqual([
			path.join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"),
		])
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("accepts TypeBox APIs beyond the validator's former copied subset", async () => {
		const { root, target, packageRoot } = await project()

		const result = await validateWorkflowCandidate({
			source: ADVANCED_TYPEBOX_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
		})

		expect(result.checks.typescript).toBe("passed")
	})

	it("uses package-owned source types for a clean local framework install", async () => {
		const { root, target, packageRoot } = await project({ sourceOnlyFramework: true })

		const result = await validateWorkflowCandidate({
			source: VALID_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
		})

		expect(result.checks.typescript).toBe("passed")
	})

	it("accepts interactive renderers using the installed PI UI types", async () => {
		const { root, target, packageRoot } = await project()

		const result = await validateWorkflowCandidate({
			source: INTERACTIVE_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
		})

		expect(result.checks.typescript).toBe("passed")
	})

	it("launches TypeScript's native compiler rather than the packaged Kimchi executable", async () => {
		const { root, target, packageRoot } = await project()
		let compilerCommand = ""

		await validateWorkflowCandidate({
			source: VALID_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
			runCommand: async (request) => {
				compilerCommand = request.command
				return { code: 0, stdout: "", stderr: "" }
			},
		})

		expect(compilerCommand).not.toBe(process.execPath)
		expect(path.basename(compilerCommand)).toMatch(/^tsc(?:\.exe)?$/)
	})

	it("typechecks named Node imports from the prepared package's Node declarations", async () => {
		const { root, target, packageRoot } = await project()

		const result = await validateWorkflowCandidate({
			source: NODE_IMPORT_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
		})

		expect(result.checks.typescript).toBe("passed")
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("validates an on-disk entry module and follows its relative TypeScript imports", async () => {
		const { root, target, packageRoot } = await project()
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

		const result = await validateWorkflowFile({ entryPath: target, projectRoot: root, packageRoot })

		expect(result.workflow.name).toBe("greet")
		expect(result.checks.typescript).toBe("passed")
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("reports a type error originating in a helper imported by an on-disk entry module", async () => {
		const { root, target, packageRoot } = await project()
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

		const validation = validateWorkflowFile({ entryPath: target, projectRoot: root, packageRoot })

		await expect(validation).rejects.toMatchObject({ stage: "typescript" })
		await expect(validation).rejects.toThrow(/number.*not assignable.*string/i)
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("rejects schema-derived callback type errors and removes every probe", async () => {
		const { root, target, packageRoot } = await project()

		const validation = validateWorkflowCandidate({
			source: INVALID_TYPE_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
		})

		await expect(validation).rejects.toMatchObject({ stage: "typescript" })
		await expect(validation).rejects.toThrow(/Property 'missing' does not exist/)
		expect(await validationArtifacts(target)).toEqual([])
	})

	it("labels caller-provided conformance failures", async () => {
		const { root, target, packageRoot } = await project()

		const validation = validateWorkflowCandidate({
			source: VALID_SOURCE,
			targetPath: target,
			projectRoot: root,
			packageRoot,
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
