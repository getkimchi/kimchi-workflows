/**
 * Stopping and removing runs: `/workflow cancel` (spec §6.4) and `/workflow delete` (spec §6.5).
 *
 * The two are deliberately sequential — a live run must be cancelled before it can be deleted — so
 * removal is always a second, deliberate act.
 */
import type { RunLock } from "../run-lock.ts";
import { summarizeRun } from "../summarize-run.ts";
import type { RunStore } from "../types.ts";
import type { NotifyCtx } from "./context.ts";

/**
 * `/workflow cancel [run-id]` (spec §6.4, §10.2). Two distinct cases:
 *
 *  - **Executing run** — abort its signal; the engine stops at the next step boundary (spec §8.6).
 *  - **Blocked run** — there is nothing executing to abort (the guard is released while blocked, spec
 *    §7.1), so cancel it *cold*: append `run-cancelled` to its log. Spec §10.2 requires that stopping
 *    a blocked run works, and the dismissal hint points users straight here.
 *
 * Bare targets the executing run, or the sole blocked run when none is executing; with several blocked
 * a run-id is required.
 */
export async function handleCancel(ctx: NotifyCtx, guard: RunLock, store: Pick<RunStore, "loadEvents" | "appendEvent" | "list">, runIdArg: string | undefined): Promise<void> {
  const active = guard.active;

  if (active && (!runIdArg || runIdArg === active.runId)) {
    active.controller.abort();
    ctx.ui.notify(`workflow: cancelling run ${active.runId} at the next step boundary...`, "info");
    return;
  }

  const runId = runIdArg ?? (await soleBlockedRun(store));
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
export async function handleDelete(ctx: NotifyCtx, store: Pick<RunStore, "loadEvents" | "delete">, runId: string): Promise<void> {
  const status = summarizeRun(await store.loadEvents(runId))?.status;
  if (!status) return void ctx.ui.notify(`workflow: no run "${runId}" to delete.`, "error");
  if (status === "in_progress" || status === "blocked") {
    ctx.ui.notify(`workflow: run ${runId} is ${status}; cancel it first ("/workflow cancel ${runId}"), then delete.`, "warning");
    return;
  }

  await store.delete(runId);
  ctx.ui.notify(`workflow: deleted ${status} run ${runId}.`, "info");
}
