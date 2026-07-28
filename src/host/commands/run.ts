/**
 * Starting runs: `/workflow run <name|file.ts>` (spec §6.1) and `/workflow create` (spec §6.6).
 *
 * Both go through the same {@link startRun} lifecycle — guard, run-id, provenance, attended Q&A — so
 * `create` gets nothing bespoke beyond the initial input its steps need.
 */
import { fileURLToPath } from "node:url";
import { runWorkflow } from "../../engine/run-workflow.ts";
import type { WorkflowDefinition } from "../../flow/types.ts";
import createWorkflowWorkflow from "../builtin/create.workflow.ts";
import { createHostPort } from "../host-port.ts";
import { mintRunId } from "../naming.ts";
import type { RunLock } from "../run-lock.ts";
import type { RunStore } from "../types.ts";
import { resolveWorkflow } from "../workflow-catalog.ts";
import { askOf, handleAttendedQuestionnaire } from "./attended.ts";
import { type CommandCtx, notifier, notifyResult, rejectIfBusy, runGuarded, type StartAgent } from "./context.ts";

/** `/workflow run <name|file.ts>` — start a workflow named either by declared name or by path. */
export async function handleRun(ctx: CommandCtx, store: RunStore, guard: RunLock, startAgent: StartAgent, target: string): Promise<void> {
  if (rejectIfBusy(ctx, guard, "starting")) return;

  const resolution = await resolveWorkflow(ctx.cwd, target);
  if (!resolution.ok) {
    ctx.ui.notify(`workflow: ${resolution.error}`, "error");
    return;
  }

  await startRun(ctx, store, guard, startAgent, resolution.workflow, resolution.filePath, undefined);
}

/**
 * `/workflow create` — run the built-in meta-workflow (src/host/builtin/create.workflow.ts) through
 * exactly the same machinery as any other run. It differs only in receiving the project root as its
 * initial input, which its steps use to resolve where the generated file should land.
 */
export async function handleCreate(ctx: CommandCtx, store: RunStore, guard: RunLock, startAgent: StartAgent): Promise<void> {
  if (rejectIfBusy(ctx, guard, "starting")) return;

  // The built-in ships with the extension, so it is imported directly rather than loaded from disk.
  // `workflowFilePath` still points at its module so a resume can reload it like any other run.
  const filePath = fileURLToPath(new URL("../builtin/create.workflow.ts", import.meta.url));
  await startRun(ctx, store, guard, startAgent, createWorkflowWorkflow, filePath, { projectRoot: ctx.cwd });
}

/** Shared run lifecycle for `/workflow run` and `/workflow create` (spec §7, §8.9, §10.2). */
async function startRun(
  ctx: CommandCtx,
  store: RunStore,
  guard: RunLock,
  startAgent: StartAgent,
  workflow: WorkflowDefinition,
  workflowFilePath: string,
  initialInput: unknown,
): Promise<void> {
  // Mint the run-id up front so provenance is persisted *at run start* (spec §8.9); the engine stays
  // file-unaware and simply uses the injected id.
  //
  // A slug (`workflow-<name>-<8 hex>`, naming.ts) rather than a UUID, because this id is now the whole
  // user-facing identity: it names the log, it is embedded in every step session file, and it is what
  // `resume`/`cancel`/`delete` take back. "Which of these is my deploy run" has to be answerable from a
  // directory listing. The store's own log is what a candidate is checked against — a name shared by
  // many runs plus 32 random bits does collide eventually, and a collision would silently append one
  // run's events onto another's.
  const runId = await mintRunId(workflow.name, async (candidate) => (await store.loadEvents(candidate)).length > 0);
  const result = await runGuarded(guard, runId, ctx.cwd, store, notifier(ctx), async (signal) => {
    // The adapter's own event (spec §8.9), not the engine's: `run-started` is emitted by the engine,
    // which is deliberately unaware of files, so where this run came FROM is recorded separately —
    // before the first engine event, so a crash mid-run still leaves a resumable log.
    await store.appendEvent({ type: "run-meta", runId, workflowFilePath, at: new Date().toISOString() });
    const host = createHostPort(store, { generateRunId: () => runId, startAgent });
    return runWorkflow(workflow, initialInput, host, { signal });
  });
  if (!result) return; // guard was busy (race) — already notified

  // Attended flow: if the run blocked, render the questionnaire inline and loop until it settles.
  if (result.status === "blocked") {
    await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, workflowFilePath, startAgent, runId, askOf(result));
  } else {
    notifyResult(ctx, workflow.name, result);
  }
}
