/** Shared presentation rules for workflow catalogs in dialogs, pickers, and plain listings. */
import path from "node:path"
import type { WorkflowEntry } from "./workflow-catalog.ts"

export interface WorkflowOptionDisplay {
	readonly name: string
	readonly description?: string
}

/** Normalize one workflow's display fields and optionally include its full source filename. */
export function workflowOptionDisplay(entry: WorkflowEntry, showFile = false): WorkflowOptionDisplay {
	// Project workflows are the default and stay unmarked; a global one is the exception worth naming,
	// so its row is identifiable in pickers and dialogs alike (spec §6.8).
	const scopeSuffix = entry.scope === "global" ? " (global)" : ""
	return {
		name: showFile
			? `${entry.identity} (${path.basename(entry.filePath)})${scopeSuffix}`
			: `${entry.identity}${scopeSuffix}`,
		description: entry.description?.replace(/\s+/g, " ").trim() || undefined,
	}
}

/** Plain-text form used by native dialogs; the TUI styles the same display fields separately. */
export function workflowOptionLabel(entry: WorkflowEntry, showFile = false): string {
	const display = workflowOptionDisplay(entry, showFile)
	return display.description ? `${display.name} — ${display.description}` : display.name
}
