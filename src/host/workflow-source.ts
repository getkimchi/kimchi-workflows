/** Installed identity and presentation helpers for workflow sources. */

import path from "node:path"
import type { WorkflowSource } from "../engine/types.ts"
import type { WorkflowDefinition } from "../flow/types.ts"
import { WORKFLOW_SUFFIX } from "./load-workflow.ts"

/**
 * The installed identity of a project-authored top-level workflow.
 *
 * Catalog files use the full `.workflow.ts` suffix. Explicit paths may name any TypeScript module the
 * loader accepts, so those fall back to stripping only `.ts`. Definition names remain author-owned for
 * composition and nested workflows; the host binds this file identity only at the top-level boundary.
 */
export function workflowFileIdentity(filePath: string): string {
	const fileName = path.basename(filePath)
	if (fileName.endsWith(WORKFLOW_SUFFIX)) return fileName.slice(0, -WORKFLOW_SUFFIX.length)
	return fileName.endsWith(".ts") ? fileName.slice(0, -".ts".length) : fileName
}

/** Bind a project file's canonical installed identity to its root definition without touching nested definitions. */
export function bindWorkflowFileIdentity(workflow: WorkflowDefinition, filePath: string): WorkflowDefinition {
	return bindWorkflowIdentity(workflow, workflowFileIdentity(filePath))
}

/** Preserve a recorded run's identity when its definition is reloaded for status or continuation. */
export function bindWorkflowIdentity(workflow: WorkflowDefinition, identity: string): WorkflowDefinition {
	return workflow.name === identity ? workflow : { ...workflow, name: identity }
}

/** Stable user-facing provenance: authored files keep their path; built-ins name their registry entry. */
export function workflowSourceLabel(source: WorkflowSource): string {
	return source.kind === "file" ? source.path : `builtin:${source.id}`
}
