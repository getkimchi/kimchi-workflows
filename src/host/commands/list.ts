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
import { type BrokenWorkflow, discoverWorkflows } from "../workflow-catalog.ts"
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
		// Keep the full source filename visible beside its suffix-free installed identity.
		const width = Math.max(...entries.map((entry) => entry.identity.length))
		const lines = entries.map(
			(entry) => `${entry.identity.padEnd(width)}  ${path.basename(entry.filePath)}  ${entry.description ?? "-"}`,
		)
		ctx.ui.notify(lines.join("\n"), "info")
	}

	if (broken.length > 0) {
		notifyBrokenWorkflows(ctx, broken)
	}
}

/** Shared by the plain catalog and the bare-command picker so broken files are never hidden. */
export function notifyBrokenWorkflows(ctx: NotifyCtx, broken: readonly BrokenWorkflow[]): void {
	const lines = broken.map((entry) => `${entry.filePath}: ${entry.error}`)
	ctx.ui.notify(`workflow: ${broken.length} file(s) failed to load:\n${lines.join("\n")}`, "warning")
}
