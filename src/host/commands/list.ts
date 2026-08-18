/**
 * The two listings: `/workflow list` shows the workflows a project defines (spec §6.7), and
 * `/workflow run list` shows the recorded runs (spec §6.3).
 *
 * Both are pure formatters over a store or the catalog, so they take the narrowest context that can
 * talk to the user and are unit-testable with a notify spy.
 */
import path from "node:path"
import { workflowsDir } from "../project-dir.ts"
import { projectRunSummaries } from "../reconcile-runs.ts"
import type { RunStore } from "../types.ts"
import { discoverWorkflows } from "../workflow-catalog.ts"
import type { NotifyCtx } from "./context.ts"

/** `/workflow run list` — the recorded runs (spec §6.3). */
export async function handleListRuns(
	ctx: NotifyCtx,
	store: Pick<RunStore, "list"> & Partial<Pick<RunStore, "executions" | "loadEvents">>,
	isActive: (runId: string) => boolean = () => false,
): Promise<void> {
	const runs = await projectRunSummaries(store, { isActive })
	if (runs.length === 0) return void ctx.ui.notify("No workflow runs recorded.", "info")
	const lines = runs.map((run) => {
		// Pending-input count is not decoration (spec §6.3): a run reads `in_progress` while any step
		// executes, even with a sibling step simultaneously `blocked` — without this, a waiting question
		// would be invisible in the listing.
		const waiting = run.pendingQuestions > 0 ? `  waiting=${run.pendingQuestions}` : ""
		return `${run.runId}  ${run.workflowName}  ${run.status}  step=${run.currentStep ?? "-"}  started=${run.startedAt}  completed=${run.completedAt ?? "-"}${waiting}`
	})
	ctx.ui.notify(lines.join("\n"), "info")
}

/**
 * `/workflow list` — the workflows this project defines, by name and description. Files that fail to
 * load are reported separately rather than omitted silently, so a broken workflow is visible.
 */
export async function handleListWorkflows(ctx: NotifyCtx & { cwd: string }): Promise<void> {
	const { entries, broken } = await discoverWorkflows(ctx.cwd)

	if (entries.length === 0 && broken.length === 0) {
		ctx.ui.notify(`No workflows found in ${workflowsDir(ctx.cwd)}. Create one with "/workflow create".`, "info")
		return
	}

	if (entries.length > 0) {
		// The filename is shown, not just the name: two files may declare the same workflow name, and
		// without it the listing would show indistinguishable rows for workflows `run` then rejects as
		// ambiguous. Duplicates are called out so the collision is obvious rather than merely implied.
		const counts = new Map<string, number>()
		for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)

		const width = Math.max(...entries.map((entry) => entry.name.length))
		const lines = entries.map((entry) => {
			const duplicate = (counts.get(entry.name) ?? 0) > 1 ? "  (duplicate name)" : ""
			return `${entry.name.padEnd(width)}  ${path.basename(entry.filePath)}  ${entry.description ?? "-"}${duplicate}`
		})
		ctx.ui.notify(lines.join("\n"), "info")
	}

	if (broken.length > 0) {
		const lines = broken.map((entry) => `${entry.filePath}: ${entry.error}`)
		ctx.ui.notify(`workflow: ${broken.length} file(s) failed to load:\n${lines.join("\n")}`, "warning")
	}
}
