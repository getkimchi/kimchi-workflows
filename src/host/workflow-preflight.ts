/** Preflight an existing workflow file before a command evaluates its module. */

import { existsSync } from "node:fs"
import type { WorkflowDefinition } from "../flow/types.ts"
import { loadWorkflowFile } from "./load-workflow.ts"
import { workflowsDir } from "./project-dir.ts"
import { validateWorkflowTypeScript } from "./workflow-candidate-validator.ts"

export type WorkflowPreflightResult =
	| { readonly ok: true; readonly workflow: WorkflowDefinition }
	| { readonly ok: false; readonly cause?: string }

/**
 * Type-check first, then evaluate exactly once. Besides removing command-level duplication, this order
 * guarantees that semantic TypeScript errors cannot run a workflow module's top-level side effects.
 */
export async function loadValidatedWorkflow(options: {
	readonly filePath: string
	readonly projectRoot: string
}): Promise<WorkflowPreflightResult> {
	if (!existsSync(options.filePath)) return { ok: false }

	try {
		await validateWorkflowTypeScript({
			entryPath: options.filePath,
			projectRoot: options.projectRoot,
			packageRoot: workflowsDir(options.projectRoot),
		})
		return { ok: true, workflow: await loadWorkflowFile(options.filePath) }
	} catch (error) {
		if (!existsSync(options.filePath)) return { ok: false }
		return { ok: false, cause: error instanceof Error ? error.message : String(error) }
	}
}
