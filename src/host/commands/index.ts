/**
 * The `/workflow` command handlers (spec §6), one module per concern:
 *
 *   context         shared types, non-exclusive execution lifecycle, notification helpers
 *   attended        the inline Q&A loop every blocking command converges on (§10.2)
 *   run             starting runs: `run` and `create` (§6.1, §6.6)
 *   batch           the headless CLI arm of `run`: one foreground run and an exit code
 *   result-artifact the `--result-out` JSON both `run` surfaces can persist
 *   resume          continuing a blocked/stopped run (§6.2)
 *   lifecycle       stopping and removing: `cancel` and `delete` (§6.4, §6.5)
 *   list            the two listings: workflows and runs (§6.7, §6.3)
 *   welcome         the interactive bare-command entry point
 *
 * `extension.ts` holds only argument dispatch; each handler takes the narrowest context it needs, so
 * all of them are testable without a PI session.
 */
export type { PendingAsk, PendingHumanInput, PendingInteraction } from "./attended.ts"
export {
	askOf,
	handleAttendedInput,
	humanInputOf,
	pendingAsk,
	pendingHumanInput,
} from "./attended.ts"
export type { BatchRunArgs, BatchRunDeps, BatchSignalSource } from "./batch.ts"
export { exitCodeForStatus, handleBatchRun, plainProgressFor } from "./batch.ts"
export type { CommandCtx, Notify, NotifyCtx, StartAgent } from "./context.ts"
export { describe, notifyResult, reportResult, runTracked } from "./context.ts"
export { handleCancel, handleDelete } from "./lifecycle.ts"
export { handleListRuns, handleListWorkflows } from "./list.ts"
export type { RunResultArtifact } from "./result-artifact.ts"
export { resultArtifact, writeResultArtifact, writeRunResultArtifact } from "./result-artifact.ts"
export { handleResume } from "./resume.ts"
export type {
	ExecutedRun,
	ExecuteRunHooks,
	InitialInputResolution,
	ParsedRunArgs,
	ResolvedRunInvocation,
} from "./run.ts"
export { executeRun, handleCreate, handleRun, parseRunArgs, resolveInitialInput, resolveRunInvocation } from "./run.ts"
export type { StatusDeps } from "./status.ts"
export { handleStatus } from "./status.ts"
export type { WorkflowWelcomeAction } from "./welcome.ts"
export { chooseWorkflowWelcomeAction } from "./welcome.ts"
