/**
 * Shared plumbing for the `/workflow` command handlers: the narrowed context they run against, the
 * single-run guard lifecycle (spec §7), and the notification helpers they format results with.
 *
 * Everything here is UI- and guard-shaped. The handlers themselves live in sibling modules and
 * depend only on this one, which keeps the command layer a flat, acyclic tree.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRequest, AgentSession, RunResult } from "../../engine/types.ts";
import type { RunGuard } from "../run-guard.ts";

/** How a command opens an agent session (spec §2.2), bound to the invoking context's model registry. */
export type StartAgent = (request: AgentRequest) => AgentSession;

/**
 * The slice of the command context the handlers actually use. The registered handler still receives the
 * full `ExtensionCommandContext` (structurally compatible), but narrowing here documents the surface and
 * makes the handlers unit-testable with a small fake.
 */
export type CommandCtx = Pick<ExtensionCommandContext, "ui" | "cwd" | "mode" | "hasUI" | "modelRegistry">;

/** The narrowest context a handler can take: enough to talk to the user, nothing more. */
export interface NotifyCtx {
  ui: Pick<CommandCtx["ui"], "notify">;
}

export type Notify = CommandCtx["ui"]["notify"];

/** The single race message when the guard is taken between check and `begin` (spec §7). */
const RUN_BUSY_MESSAGE = "workflow: another run became active; try again.";

/**
 * Own the guard lifecycle for one execution (spec §7): acquire `begin(runId)`; if the guard is busy,
 * emit the shared race message and return `undefined`; otherwise run with the run's abort signal and
 * release on every outcome (including `blocked` — blocked ≠ in_progress). Returns the run result, or
 * `undefined` when the guard was busy.
 */
export async function runGuarded(guard: RunGuard, runId: string, notify: Notify, run: (signal: AbortSignal) => Promise<RunResult>): Promise<RunResult | undefined> {
  const controller = guard.begin(runId);
  if (!controller) {
    notify(RUN_BUSY_MESSAGE, "warning");
    return undefined;
  }
  try {
    return await run(controller.signal);
  } finally {
    guard.end(runId);
  }
}

/**
 * Reject a command that needs an idle process (spec §7.2). Returns true — and notifies — when a run is
 * already executing. `verb` completes "…before <verb> another", so callers read as the user does.
 */
export function rejectIfBusy(ctx: NotifyCtx, guard: RunGuard, verb: string): boolean {
  if (!guard.active) return false;
  ctx.ui.notify(`workflow: run ${guard.active.runId} is already active; cancel it or wait before ${verb} another.`, "warning");
  return true;
}

/** Report a run's terminal (or blocked) outcome to the user (spec §5.1). */
export function notifyResult(ctx: NotifyCtx, workflowName: string, result: RunResult): void {
  if (result.status === "completed") {
    ctx.ui.notify(`workflow "${workflowName}" completed (run ${result.runId}).`, "info");
  } else if (result.status === "cancelled") {
    ctx.ui.notify(`workflow "${workflowName}" cancelled (run ${result.runId}); resume to continue.`, "warning");
  } else if (result.status === "blocked") {
    ctx.ui.notify(`workflow "${workflowName}" blocked (run ${result.runId}) awaiting answers.`, "info");
  } else {
    ctx.ui.notify(`workflow "${workflowName}" crashed (run ${result.runId}): ${result.error}`, "error");
  }
}

/** A `this`-safe {@link Notify} bound to a context's UI, for passing into {@link runGuarded}. */
export function notifier(ctx: NotifyCtx): Notify {
  return (message, type) => ctx.ui.notify(message, type);
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
