/** Resolve workflow definitions recorded in run provenance. */

import { fileURLToPath } from "node:url"
import createWorkflowWorkflow from "./builtin/create.workflow.ts"
import { loadValidatedWorkflow, type WorkflowPreflightResult } from "./workflow-preflight.ts"

/** The exact package-owned source path persisted for runs started by `/workflow create`. */
export const BUILTIN_CREATE_WORKFLOW_FILE = fileURLToPath(new URL("./builtin/create.workflow.ts", import.meta.url))

export { createWorkflowWorkflow }

/**
 * Package-owned built-ins are trusted definitions already imported by the extension. Project-authored
 * definitions retain the TypeScript-before-evaluation preflight that protects against edited source.
 * Matching provenance by exact path keeps workflow names entirely user-owned.
 */
export function loadRecordedWorkflow(options: {
	readonly filePath: string
	readonly projectRoot: string
}): Promise<WorkflowPreflightResult> {
	if (options.filePath === BUILTIN_CREATE_WORKFLOW_FILE) {
		return Promise.resolve({ ok: true, workflow: createWorkflowWorkflow })
	}
	return loadValidatedWorkflow(options)
}
