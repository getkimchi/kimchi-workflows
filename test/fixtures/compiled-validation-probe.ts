import { workflowsDir } from "../../src/host/project-dir.ts"
import { validateWorkflowFile } from "../../src/host/workflow-candidate-validator.ts"
import { createTestRun } from "../../src/testing/index.ts"

const [projectRoot, entryPath] = process.argv.slice(2)
if (!projectRoot || !entryPath) throw new Error("usage: compiled-validation-probe <project-root> <workflow-entry>")

const validation = await validateWorkflowFile({
	entryPath,
	projectRoot,
	packageRoot: workflowsDir(projectRoot),
})
const run = await createTestRun(validation.workflow)
if (run.status !== "completed") throw new Error(`compiled validation workflow ended as ${run.status}`)
process.stdout.write(JSON.stringify({ name: validation.workflow.name, output: run.output }))
