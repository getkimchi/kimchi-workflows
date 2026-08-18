/** Pure presentation helpers for recorded workflow provenance. */

import type { WorkflowSource } from "../engine/types.ts"

/** Stable user-facing provenance: authored files keep their path; built-ins name their registry entry. */
export function workflowSourceLabel(source: WorkflowSource): string {
	return source.kind === "file" ? source.path : `builtin:${source.id}`
}
