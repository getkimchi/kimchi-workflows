/**
 * The `/workflow` command handlers (spec §6), one module per concern:
 *
 *   context    shared types, the single-run guard lifecycle, notification helpers
 *   attended   the inline Q&A loop every blocking command converges on (§10.2)
 *   run        starting runs: `run` and `create` (§6.1, §6.6)
 *   resume     continuing a blocked/stopped run (§6.2)
 *   lifecycle  stopping and removing: `cancel` and `delete` (§6.4, §6.5)
 *   list       the two listings: workflows and runs (§6.7, §6.3)
 *
 * `extension.ts` holds only argument dispatch; each handler takes the narrowest context it needs, so
 * all of them are testable without a PI session.
 */
export type { PendingAsk } from "./attended.ts";
export { askOf, handleAttendedQuestionnaire, pendingAsk } from "./attended.ts";
export type { CommandCtx, Notify, NotifyCtx, StartAgent } from "./context.ts";
export { describe, notifier, notifyResult, rejectIfBusy, reportResult, runGuarded } from "./context.ts";
export { handleCancel, handleDelete } from "./lifecycle.ts";
export { handleListRuns, handleListWorkflows } from "./list.ts";
export { handleResume } from "./resume.ts";
export { handleCreate, handleRun } from "./run.ts";
export type { StatusDeps } from "./status.ts";
export { handleStatus } from "./status.ts";
