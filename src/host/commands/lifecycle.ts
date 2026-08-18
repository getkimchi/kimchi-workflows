/**
 * Stopping and removing runs: `/workflow cancel` (spec §6.4) and `/workflow delete` (spec §6.5).
 *
 * The two are deliberately sequential — a live run must be cancelled before it can be deleted — so
 * removal is always a second, deliberate act.
 */

import type { ActiveRun, ActiveRuns } from "../active-runs.ts"
import { reconcileAbandonedRuns } from "../reconcile-runs.ts"
import type { RunStatus } from "../resume-router.ts"
import { summarizeRun } from "../summarize-run.ts"
import type { RunStore } from "../types.ts"
import { type NotifyCtx, resolveRunRef } from "./context.ts"

/**
 * The live/stopped split the two commands turn on (spec §6.4/§6.5): a live run can be cancelled but
 * not deleted, a stopped one the reverse. Stated once, so completion (spec §14.4) can filter run-ids
 * by the rule the handlers enforce instead of carrying a second copy of the status list.
 */
export function isLiveRun(status: RunStatus): boolean {
	return status === "in_progress" || status === "blocked"
}

/**
 * `/workflow cancel [run-id]` (spec §6.4, §10.2). Two distinct cases:
 *
 *  - **Executing run** — durably record cancellation, then abort its signal; the engine stops at the
 *    next step boundary (spec §8.6).
 *  - **Blocked run** — there is nothing executing to abort, so cancel it *cold*: append
 *    `run-cancelled` to its log. Spec §10.2 requires that stopping
 *    a blocked run works, and the dismissal hint points users straight here.
 *
 * Bare targets the sole local execution, or the sole blocked run when none is executing. With several
 * local executions or blocked runs a run-id is required — in full, by its hash, or by any unique prefix
 * ({@link resolveRunRef}).
 */
export async function handleCancel(
	ctx: NotifyCtx,
	activeRuns: ActiveRuns,
	store: RunStore,
	runRef: string | undefined,
): Promise<void> {
	const cancelActive = async (runs: readonly ActiveRun[], runId: string): Promise<void> => {
		const run = runs[0]
		if (!run) return
		const events = await store.loadEvents(runId)
		const path = summarizeRun(events)?.currentStep
		const result = await run.cancel(() =>
			store.appendEvent({
				type: "run-cancelled",
				runId,
				executionId: run.lease.executionId,
				path,
				source: "command",
				at: new Date().toISOString(),
			}),
		)
		ctx.ui.notify(
			result === "accepted"
				? `workflow: cancelled run ${runId}; stopping the active execution...`
				: result === "already-recorded"
					? `workflow: run ${runId} is already cancelled; its execution is still stopping.`
					: `workflow: run ${runId} already finished settling; its recorded terminal state wins.`,
			"info",
		)
	}

	// An exact id is checked BEFORE the store is consulted, so newly-started local work stays cancellable
	// even if its first event has not landed yet.
	if (runRef) {
		const exact = activeRuns.find(runRef)
		if (exact.length > 0) return cancelActive(exact, runRef)
	} else {
		const activeIds = [...new Set(activeRuns.active.map((run) => run.runId))]
		if (activeIds.length === 1) {
			const runId = activeIds[0] as string
			return cancelActive(activeRuns.find(runId), runId)
		}
		if (activeIds.length > 1) {
			ctx.ui.notify(
				`workflow: ${activeIds.length} runs are executing (${activeIds.join(", ")}); pass a run-id to cancel one.`,
				"warning",
			)
			return
		}
	}

	await reconcileAbandonedRuns(store, activeRuns)

	const runId = runRef ? await resolveRunRef(ctx, store, runRef, "cancel") : await soleBlockedRun(store)
	if (runRef && !runId) return // unknown or ambiguous — already notified
	// A hash/prefix that resolves to locally executing work means the same thing as its full id.
	if (runId) {
		const local = activeRuns.find(runId)
		if (local.length > 0) return cancelActive(local, runId)
	}

	if (!runId) {
		ctx.ui.notify(
			"workflow: nothing to cancel — no local run is executing and no single blocked run is available. Pass a run-id.",
			"info",
		)
		return
	}

	const events = await store.loadEvents(runId)
	const status = summarizeRun(events)?.status
	if (!status) return void ctx.ui.notify(`workflow: no run "${runId}" to cancel.`, "error")
	if (status === "cancelled") {
		ctx.ui.notify(`workflow: run ${runId} is already cancelled.`, "info")
		return
	}
	const inspected = await store.executions?.inspect(runId)
	if (inspected) {
		const { host, pid } = inspected.lease.owner
		ctx.ui.notify(`workflow: run ${runId} is owned by PID ${pid} on ${host}; cancel it from that runner.`, "warning")
		return
	}
	if (status !== "blocked") {
		ctx.ui.notify(
			`workflow: run ${runId} is ${status}; only its executing runner or a blocked run can cancel it.`,
			"warning",
		)
		return
	}

	// Cold cancel: no execution to interrupt, so record the transition directly (spec §5.3).
	const executionId = [...events].reverse().find((event) => event.type === "run-execution-started")?.executionId
	await store.appendEvent({
		type: "run-cancelled",
		runId,
		executionId,
		source: "command",
		at: new Date().toISOString(),
	})
	ctx.ui.notify(`workflow: cancelled blocked run ${runId}; resume to continue, or delete to remove it.`, "info")
}

/** The only blocked run, when there is exactly one — lets `/workflow cancel` stay bare in the common case. */
async function soleBlockedRun(store: Pick<RunStore, "list">): Promise<string | undefined> {
	const blocked = (await store.list()).filter((run) => run.status === "blocked")
	return blocked.length === 1 ? blocked[0]?.runId : undefined
}

/**
 * `/workflow delete <run-id>` (spec §6.5) — permanently remove a **stopped** run. A live run
 * (`in_progress`/`blocked`) is rejected: cancel it first, so the removal is always a deliberate second act.
 */
export async function handleDelete(ctx: NotifyCtx, store: RunStore, runRef: string): Promise<void> {
	const runId = await resolveRunRef(ctx, store, runRef, "delete")
	if (!runId) return // unknown or ambiguous — already notified

	const status = summarizeRun(await store.loadEvents(runId))?.status
	if (!status) return void ctx.ui.notify(`workflow: no run "${runId}" to delete.`, "error")
	if (isLiveRun(status)) {
		ctx.ui.notify(
			`workflow: run ${runId} is ${status}; cancel it first ("/workflow cancel ${runId}"), then delete.`,
			"warning",
		)
		return
	}
	const inspected = await store.executions?.inspect(runId)
	if (inspected) {
		const { host, pid } = inspected.lease.owner
		ctx.ui.notify(
			`workflow: run ${runId} is still settling under PID ${pid} on ${host}; wait for its execution to stop before deleting it.`,
			"warning",
		)
		return
	}

	await store.delete(runId)
	ctx.ui.notify(`workflow: deleted ${status} run ${runId}.`, "info")
}
