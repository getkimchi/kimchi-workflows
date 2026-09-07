import { workflowsDir } from "../../src/host/project-dir.ts"
import { validateWorkflowFile } from "../../src/host/workflow-candidate-validator.ts"
import { resolveWorkflowPackageManager } from "../../src/host/workflow-package-manager.ts"
import { createTestRun } from "../../src/testing/index.ts"

await main(process.argv.slice(2))

async function main([projectRoot, entryPath]: readonly string[]): Promise<void> {
	if (projectRoot === "--startup-only") {
		process.stdout.write("ready")
		return
	}
	if (projectRoot === "--check-prerequisites") {
		try {
			await resolveWorkflowPackageManager()
			process.stdout.write("available")
		} catch (error) {
			process.stdout.write(error instanceof Error ? error.message : String(error))
		}
		return
	}
	if (!projectRoot || !entryPath) throw new Error("usage: compiled-validation-probe <project-root> <workflow-entry>")
	const validation = await validateWorkflowFile({
		entryPath,
		projectRoot,
		packageRoot: workflowsDir(projectRoot),
	})
	const run = await createTestRun(validation.workflow)
	if (run.status !== "completed") throw new Error(`compiled validation workflow ended as ${run.status}`)
	process.stdout.write(JSON.stringify({ name: validation.workflow.name, output: run.output }))
}
