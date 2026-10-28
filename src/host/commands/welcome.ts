/**
 * The bare `/workflow` entry point: a screenshot-shaped TUI quick-pick, a native RPC dialog, and the
 * ordinary plain catalog listing in headless modes.
 */
import path from "node:path"
import { globalWorkflowsDir, workflowsDir } from "../project-dir.ts"
import { discoverWorkflows, type WorkflowEntry } from "../workflow-catalog.ts"
import { workflowOptionLabel } from "../workflow-display.ts"
import type { CommandCtx } from "./context.ts"
import { notifyBrokenWorkflows } from "./list.ts"

type WelcomeCtx = Pick<CommandCtx, "cwd" | "mode" | "hasUI"> & {
	ui: Pick<CommandCtx["ui"], "custom" | "notify" | "select">
}

/** The action chosen from bare `/workflow`; dispatch remains in extension.ts. */
export type WorkflowWelcomeAction =
	| { readonly kind: "run"; readonly filePath: string }
	| { readonly kind: "create" }
	| { readonly kind: "list" }
	| undefined

/**
 * Show the welcome/picker experience and return what it selected. Dismissing it is a no-op. The
 * headless gate runs before catalog discovery; extension.ts sends `list` to the existing handler.
 */
export async function chooseWorkflowWelcomeAction(ctx: WelcomeCtx): Promise<WorkflowWelcomeAction> {
	if (!ctx.hasUI) return { kind: "list" }

	const { entries, broken } = await discoverWorkflows(ctx.cwd)
	if (broken.length > 0) notifyBrokenWorkflows(ctx, broken)

	const locations = workflowLocationsLabel(ctx.cwd)
	if (ctx.mode === "tui") {
		const { pickWorkflowInTui } = await import("../workflow-picker.ts")
		return pickWorkflowInTui(ctx, entries, locations)
	}
	return chooseViaDialog(ctx, entries, locations)
}

async function chooseViaDialog(
	ctx: Pick<WelcomeCtx, "ui">,
	entries: readonly WorkflowEntry[],
	locations: string,
): Promise<WorkflowWelcomeAction> {
	const createLabel = entries.length === 0 ? "Create a workflow" : "Create new workflow"
	const labels = dialogLabels(entries, createLabel)
	const options = [...labels.keys(), createLabel]
	const state = entries.length === 0 ? "No workflows found." : "Which workflow do you want to run?"
	const title = [
		"Kimchi Workflows",
		`Run structured long running tasks. Workflows are stored in ${locations}.`,
		"",
		state,
	].join("\n")
	const selection = await ctx.ui.select(title, options)
	if (selection === undefined) return undefined
	if (selection === createLabel) return { kind: "create" }
	const entry = labels.get(selection)
	return entry ? { kind: "run", filePath: entry.filePath } : undefined
}

function dialogLabels(entries: readonly WorkflowEntry[], reservedLabel: string): Map<string, WorkflowEntry> {
	return new Map(
		entries.map((entry) => {
			const ordinaryLabel = workflowOptionLabel(entry)
			// Native dialogs return only the selected string, not the row identity. A workflow row must
			// therefore differ from the built-in action or one of the two identical rows is unreachable.
			const label = ordinaryLabel === reservedLabel ? workflowOptionLabel(entry, true) : ordinaryLabel
			return [label, entry]
		}),
	)
}

/** Keep the project-owned workflow directory legible instead of filling the header with an absolute path. */
export function workflowDirectoryLabel(projectRoot: string): string {
	const directory = workflowsDir(projectRoot)
	const relative = path.relative(projectRoot, directory)
	return relative && !relative.startsWith("..") ? relative : directory
}

/** Both catalog locations, legible: the project's relative directory plus the absolute global one. */
export function workflowLocationsLabel(projectRoot: string): string {
	return `${workflowDirectoryLabel(projectRoot)} and ${globalWorkflowsDir()}`
}
