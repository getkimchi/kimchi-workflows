/**
 * Shared plumbing for the `/workflow` command handlers: the narrowed context they run against, the
 * single-run guard lifecycle (spec §7), and the notification helpers they format results with.
 *
 * Everything here is UI- and guard-shaped. The handlers themselves live in sibling modules and
 * depend only on this one, which keeps the command layer a flat, acyclic tree.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRequest, AgentSession, RunResult } from "../../engine/types.ts";
import { matchRunId } from "../naming.ts";
import type { BeginResult, RunLock } from "../run-lock.ts";
import type { RunStore } from "../types.ts";

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

/**
 * Own the project lock lifecycle for one execution (spec §7): acquire `begin(runId)`; if the lock is
 * held or contended, notify and return `undefined`; otherwise run with the run's abort signal and
 * release on every outcome (including `blocked` — blocked ≠ in_progress, spec §7.1). A successful
 * reclaim (spec §7.3) is announced too, since it silently rewrites another run's recorded status.
 * Returns the run result, or `undefined` when the lock could not be acquired.
 */
export async function runGuarded(
  guard: RunLock,
  runId: string,
  projectRoot: string,
  store: Pick<RunStore, "appendEvent">,
  notify: Notify,
  run: (signal: AbortSignal) => Promise<RunResult>,
): Promise<RunResult | undefined> {
  const result = await guard.begin(runId, projectRoot, store);
  if (!result.ok) {
    notify(busyMessage(result), "warning");
    return undefined;
  }
  if (result.reclaimed) {
    notify(`workflow: reclaimed the project lock from run ${result.reclaimed.runId} (its process is no longer alive); that run is now recorded crashed and resumable.`, "info");
  }
  try {
    return await run(result.controller.signal);
  } finally {
    await guard.end(runId, projectRoot);
  }
}

function busyMessage(result: Extract<BeginResult, { ok: false }>): string {
  switch (result.reason) {
    case "held":
      return `workflow: run ${result.holder.runId} is already executing (pid ${result.holder.pid} on ${result.holder.host}); cancel it or wait before starting/resuming another.`;
    case "foreign-host":
      return `workflow: run ${result.holder.runId} is executing on a different host (${result.holder.host}); refusing rather than guessing at its liveness.`;
    case "contended":
      return "workflow: another run became active; try again.";
  }
}

/**
 * Reject a command that needs an idle process (spec §7.2). Returns true — and notifies — when THIS
 * process is already executing a run. A cheap same-process fast path only: the project lock (held
 * across sessions/processes, spec §7.2) is the actual gate, enforced by `runGuarded`'s `begin()` call;
 * this just avoids wasted work (e.g. resolving a workflow file) when the answer is already known here.
 * `verb` completes "…before <verb> another", so callers read as the user does.
 */
export function rejectIfBusy(ctx: NotifyCtx, guard: RunLock, verb: string): boolean {
  if (!guard.active) return false;
  ctx.ui.notify(`workflow: run ${guard.active.runId} is already active; cancel it or wait before ${verb} another.`, "warning");
  return true;
}

/**
 * Turn a `resume`/`cancel`/`delete` argument into a run-id, or notify why it cannot be one and return
 * `undefined` (spec §6.2/§6.4/§6.5).
 *
 * Run-ids are slugs now (naming.ts), which are readable but long, so what the user types is matched the
 * way the harness matches its own session ids: exact first, then the short hash, then any unique prefix.
 * Several matches are reported WITH the candidates rather than resolved by picking one — two of these
 * three commands destroy state. `verb` completes "no run … to <verb>", so callers read as the user does.
 */
export async function resolveRunRef(ctx: NotifyCtx, store: Pick<RunStore, "list">, arg: string, verb: string): Promise<string | undefined> {
  const match = matchRunId(
    (await store.list()).map((run) => run.runId),
    arg,
  );
  if (match.kind === "ok") return match.runId;
  if (match.kind === "ambiguous") {
    ctx.ui.notify(`workflow: "${arg}" matches ${match.candidates.length} runs (${match.candidates.join(", ")}); use a longer prefix or the full run-id.`, "warning");
    return undefined;
  }
  ctx.ui.notify(`workflow: no run "${arg}" to ${verb}.`, "error");
  return undefined;
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
