/** Shared presentation rules for workflow catalogs in dialogs, pickers, and plain listings. */
import path from "node:path"
import type { WorkflowEntry } from "./workflow-catalog.ts"

export interface WorkflowOptionDisplay {
	readonly name: string
	readonly description?: string
}

/** Count declared workflow names once so every catalog surface agrees about duplicates. */
export function workflowNameCounts(entries: readonly WorkflowEntry[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>()
	for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)
	return counts
}

export function isDuplicateWorkflowName(entry: WorkflowEntry, counts: ReadonlyMap<string, number>): boolean {
	return (counts.get(entry.name) ?? 0) > 1
}

/** Normalize one workflow's display fields and add a filename hint when it must be disambiguated. */
export function workflowOptionDisplay(entry: WorkflowEntry, showFile = false): WorkflowOptionDisplay {
	return {
		name: showFile ? `${entry.name} (${path.basename(entry.filePath)})` : entry.name,
		description: entry.description?.replace(/\s+/g, " ").trim() || undefined,
	}
}

/** Plain-text form used by native dialogs; the TUI styles the same display fields separately. */
export function workflowOptionLabel(entry: WorkflowEntry, showFile = false): string {
	const display = workflowOptionDisplay(entry, showFile)
	return display.description ? `${display.name} — ${display.description}` : display.name
}
