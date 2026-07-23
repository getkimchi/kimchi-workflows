/**
 * Stopping and removing runs: `/workflow cancel` (spec §6.4) and `/workflow delete` (spec §6.5).
 *
 * The two are deliberately sequential — a live run must be cancelled before it can be deleted — so
 * removal is always a second, deliberate act.
 */
import type { RunGuard } from "../run-guard.ts";
import { summarizeRun } from "../summarize-run.ts";
import type { RunStore } from "../types.ts";
import type { NotifyCtx } from "./context.ts";

/**
 * `/workflow cancel [run-id]` (spec §6.4, §10.2). Two distinct cases:
 *
 *  - **Executing run** — abort its signal; the engine stops at the next step boundary (spec §8.6).
 *  - **Parked run** — there is nothing executing to abort (the guard is released while parked, spec
 *    §7.1), so cancel it *cold*: append `run-cancelled` to its log. Spec §10.2 requires that stopping
 *    a parked run works, and the dismissal hint points users straight here.
 *
 * Bare targets the executing run, or the sole parked run when none is executing; with several parked
 * a run-id is required.
 */
export async function handleCancel(ctx: NotifyCtx, guard: RunGuard, store: Pick<RunStore, "loadEvents" | "appendEvent" | "list">, runIdArg: string | undefined): Promise<void> {
  const active = guard.active;

  if (active && (!runIdArg || runIdArg === active.runId)) {
    active.controller.abort();
    ctx.ui.notify(`workflow: cancelling run ${active.runId} at the next step boundary...`, "info");
    return;
  }

  const runId = runIdArg ?? (await soleParkedRun(store));
  if (!runId) {
    const hint = active ? ` The executing run is ${active.runId}.` : "";
    ctx.ui.notify(`workflow: nothing to cancel — no run is executing and no single parked run to target.${hint} Pass a run-id.`, "info");
    return;
  }

  const status = summarizeRun(await store.loadEvents(runId))?.status;
  if (!status) return void ctx.ui.notify(`workflow: no run "${runId}" to cancel.`, "error");
  if (status !== "parked") {
    ctx.ui.notify(`workflow: run ${runId} is ${status}; only an executing or parked run can be cancelled.`, "warning");
    return;
  }

  // Cold cancel: no execution to interrupt, so record the transition directly (spec §5.3).
  await store.appendEvent({ type: "run-cancelled", runId, time: new Date().toISOString() });
  ctx.ui.notify(`workflow: cancelled parked run ${runId}; resume to continue, or delete to remove it.`, "info");
}

/** The only parked run, when there is exactly one — lets `/workflow cancel` stay bare in the common case. */
async function soleParkedRun(store: Pick<RunStore, "list">): Promise<string | undefined> {
  const parked = (await store.list()).filter((run) => run.status === "parked");
  return parked.length === 1 ? parked[0]?.runId : undefined;
}

/**
 * `/workflow delete <run-id>` (spec §6.5) — permanently remove a **stopped** run. A live run
 * (`running`/`parked`) is rejected: cancel it first, so the removal is always a deliberate second act.
 */
export async function handleDelete(ctx: NotifyCtx, store: Pick<RunStore, "loadEvents" | "delete">, runId: string): Promise<void> {
  const status = summarizeRun(await store.loadEvents(runId))?.status;
  if (!status) return void ctx.ui.notify(`workflow: no run "${runId}" to delete.`, "error");
  if (status === "running" || status === "parked") {
    ctx.ui.notify(`workflow: run ${runId} is ${status}; cancel it first ("/workflow cancel ${runId}"), then delete.`, "warning");
    return;
  }

  await store.delete(runId);
  ctx.ui.notify(`workflow: deleted ${status} run ${runId}.`, "info");
}
