import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createJiti } from "jiti"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadWorkflowFile } from "../src/host/load-workflow.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import { createTestRun } from "../src/testing/index.ts"

/**
 * Authoring a workflow OUTSIDE this repo, in a project that has installed nothing.
 *
 * This is the case the engine exists to serve and the one the repo could not previously reach: a
 * project whose only workflow-related asset is a `.<app>/workflows/*.workflow.ts` file. Its bare imports
 * resolve from ITS directory, so before `loadWorkflowFile` supplied the modules itself, this failed on
 * `Cannot find module 'typebox'` — see the negative control below, which proves the temp project
 * really is dependency-free and that these tests are not passing by accident.
 */
const SOURCE = `import { basename } from "node:path";
import { Type } from "typebox";
import { isValidNodeName } from "@getkimchi/kimchi-workflows/engine";
import { createStep, createWorkflow } from "@getkimchi/kimchi-workflows";

const greet = createStep({
  name: "greet",
  output: Type.Object({ greeting: Type.String(), named: Type.Boolean(), file: Type.String() }),
  run: () => ({ greeting: "hello from outside the repo", named: isValidNodeName("greet"), file: basename("/tmp/x/greet.workflow.ts") }),
});

export default createWorkflow({ name: "greet", description: "Authored in another project" }).then(greet).commit();
`

describe("authoring outside this repo", () => {
	let projectRoot: string
	let workflowFile: string

	beforeEach(async () => {
		// os.tmpdir(), deliberately: nothing above it resolves `typebox` or `pi-workflows`.
		projectRoot = await mkdtemp(path.join(tmpdir(), "pi-workflows-external-"))
		await mkdir(workflowsDir(projectRoot), { recursive: true })
		workflowFile = path.join(workflowsDir(projectRoot), "greet.workflow.ts")
		await writeFile(workflowFile, SOURCE, "utf8")
	})

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true })
	})

	it("loads a workflow whose project installed neither typebox nor pi-workflows", async () => {
		const workflow = await loadWorkflowFile(workflowFile)

		expect(workflow.name).toBe("greet")
		expect(workflow.nodes).toHaveLength(1)
	})

	it("runs it, so the schema it built validates against the engine's typebox", async () => {
		// The real assertion is instance sharing: `Type.Object` came from the modules the loader handed
		// out, and the engine's `Value.Check` must accept the result — two typeboxes would not agree.
		const run = await createTestRun(await loadWorkflowFile(workflowFile))

		expect(run.status).toBe("completed")
		// `named` proves the engine subpath resolved, `file` that node built-ins still do.
		expect(run.output).toEqual({ greeting: "hello from outside the repo", named: true, file: "greet.workflow.ts" })
	})

	it("does not answer for the package's internal layout", async () => {
		// Only the published names resolve. A directory path is not a supported import, and failing here
		// is the point: it cannot work after a real `npm install` either, since `exports` omits it.
		const byPath = path.join(workflowsDir(projectRoot), "by-path.workflow.ts")
		await writeFile(
			byPath,
			SOURCE.replace('from "@getkimchi/kimchi-workflows"', 'from "@getkimchi/kimchi-workflows/src/flow"'),
			"utf8",
		)

		await expect(loadWorkflowFile(byPath)).rejects.toThrow(/Cannot find module/)
	})

	it("negative control: a loader that does not supply the modules cannot load the same file", async () => {
		const bare = createJiti(import.meta.url)

		await expect(bare.import(workflowFile)).rejects.toThrow(/Cannot find module 'typebox'/)
	})
})
