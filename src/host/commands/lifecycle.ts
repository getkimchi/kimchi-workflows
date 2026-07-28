/**
 * Stopping and removing runs: `/workflow cancel` (spec §6.4) and `/workflow delete` (spec §6.5).
 *
 * The two are deliberately sequential — a live run must be cancelled before it can be deleted — so
 * removal is always a second, deliberate act.
 */
import type { RunStatus } from "../resume-router.ts";
import type { ActiveRun, RunLock } from "../run-lock.ts";
import { summarizeRun } from "../summarize-run.ts";
import type { RunStore } from "../types.ts";
import { type NotifyCtx, resolveRunRef } from "./context.ts";

/**
 * The live/stopped split the two commands turn on (spec §6.4/§6.5): a live run can be cancelled but
 * not deleted, a stopped one the reverse. Stated once, so completion (spec §14.4) can filter run-ids
 * by the rule the handlers enforce instead of carrying a second copy of the status list.
 */
export function isLiveRun(status: RunStatus): boolean {
  return status === "in_progress" || status === "blocked";
}

/**
 * `/workflow cancel [run-id]` (spec §6.4, §10.2). Two distinct cases:
 *
 *  - **Executing run** — abort its signal; the engine stops at the next step boundary (spec §8.6).
 *  - **Blocked run** — there is nothing executing to abort (the guard is released while blocked, spec
 *    §7.1), so cancel it *cold*: append `run-cancelled` to its log. Spec §10.2 requires that stopping
 *    a blocked run works, and the dismissal hint points users straight here.
 *
 * Bare targets the executing run, or the sole blocked run when none is executing; with several blocked
 * a run-id is required — in full, by its hash, or by any unique prefix ({@link resolveRunRef}).
 */
export async function handleCancel(ctx: NotifyCtx, guard: RunLock, store: Pick<RunStore, "loadEvents" | "appendEvent" | "list">, runRef: string | undefined): Promise<void> {
  const active = guard.active;
  const abortActive = (run: ActiveRun): void => {
    run.controller.abort();
    ctx.ui.notify(`workflow: cancelling run ${run.runId} at the next step boundary...`, "info");
  };

  // The exact id is checked BEFORE the store is consulted, so the executing run stays cancellable even
  // if its log cannot be read back right now.
  if (active && (!runRef || runRef === active.runId)) return abortActive(active);

  const runId = runRef ? await resolveRunRef(ctx, store, runRef, "cancel") : await soleBlockedRun(store);
  if (runRef && !runId) return; // unknown or ambiguous — already notified
  // A hash/prefix that resolved to the run this process is executing means the same thing as its full id.
  if (active && runId === active.runId) return abortActive(active);

  if (!runId) {
    const hint = active ? ` The executing run is ${active.runId}.` : "";
    ctx.ui.notify(`workflow: nothing to cancel — no run is executing and no single blocked run to target.${hint} Pass a run-id.`, "info");
    return;
  }

  const status = summarizeRun(await store.loadEvents(runId))?.status;
  if (!status) return void ctx.ui.notify(`workflow: no run "${runId}" to cancel.`, "error");
  if (status !== "blocked") {
    ctx.ui.notify(`workflow: run ${runId} is ${status}; only an executing or blocked run can be cancelled.`, "warning");
    return;
  }

  // Cold cancel: no execution to interrupt, so record the transition directly (spec §5.3).
  await store.appendEvent({ type: "run-cancelled", runId, at: new Date().toISOString() });
  ctx.ui.notify(`workflow: cancelled blocked run ${runId}; resume to continue, or delete to remove it.`, "info");
}

/** The only blocked run, when there is exactly one — lets `/workflow cancel` stay bare in the common case. */
async function soleBlockedRun(store: Pick<RunStore, "list">): Promise<string | undefined> {
  const blocked = (await store.list()).filter((run) => run.status === "blocked");
  return blocked.length === 1 ? blocked[0]?.runId : undefined;
}

/**
 * `/workflow delete <run-id>` (spec §6.5) — permanently remove a **stopped** run. A live run
 * (`in_progress`/`blocked`) is rejected: cancel it first, so the removal is always a deliberate second act.
 */
export async function handleDelete(ctx: NotifyCtx, store: Pick<RunStore, "loadEvents" | "delete" | "list">, runRef: string): Promise<void> {
  const runId = await resolveRunRef(ctx, store, runRef, "delete");
  if (!runId) return; // unknown or ambiguous — already notified

  const status = summarizeRun(await store.loadEvents(runId))?.status;
  if (!status) return void ctx.ui.notify(`workflow: no run "${runId}" to delete.`, "error");
  if (isLiveRun(status)) {
    ctx.ui.notify(`workflow: run ${runId} is ${status}; cancel it first ("/workflow cancel ${runId}"), then delete.`, "warning");
    return;
  }

  await store.delete(runId);
  ctx.ui.notify(`workflow: deleted ${status} run ${runId}.`, "info");
}
