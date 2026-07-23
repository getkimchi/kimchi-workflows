/**
 * Starting runs: `/workflow run <name|file.ts>` (spec §6.1) and `/workflow create` (spec §6.6).
 *
 * Both go through the same {@link startRun} lifecycle — guard, run-id, metadata sidecar, attended
 * Q&A — so `create` gets nothing bespoke beyond the initial input its steps need.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "../../engine/run-workflow.ts";
import type { WorkflowDefinition } from "../../flow/types.ts";
import createWorkflowWorkflow from "../builtin/create.workflow.ts";
import { createHostPort } from "../host-port.ts";
import type { RunGuard } from "../run-guard.ts";
import type { RunStore } from "../types.ts";
import { resolveWorkflow } from "../workflow-catalog.ts";
import { handleAttendedQuestionnaire } from "./attended.ts";
import { type CommandCtx, notifier, notifyResult, rejectIfBusy, runGuarded, type StartAgent } from "./context.ts";

/** `/workflow run <name|file.ts>` — start a workflow named either by declared name or by path. */
export async function handleRun(ctx: CommandCtx, store: RunStore, guard: RunGuard, startAgent: StartAgent, target: string): Promise<void> {
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
export async function handleCreate(ctx: CommandCtx, store: RunStore, guard: RunGuard, startAgent: StartAgent): Promise<void> {
  if (rejectIfBusy(ctx, guard, "starting")) return;

  // The built-in ships with the extension, so it is imported directly rather than loaded from disk.
  // `workflowFilePath` still points at its module so a resume can reload it like any other run.
  const filePath = fileURLToPath(new URL("../builtin/create.workflow.ts", import.meta.url));
  await startRun(ctx, store, guard, startAgent, createWorkflowWorkflow, filePath, { projectRoot: ctx.cwd });
}

/** Shared run lifecycle for `/workflow run` and `/workflow create` (spec §7, §8.7, §10.2). */
async function startRun(
  ctx: CommandCtx,
  store: RunStore,
  guard: RunGuard,
  startAgent: StartAgent,
  workflow: WorkflowDefinition,
  workflowFilePath: string,
  initialInput: unknown,
): Promise<void> {
  // Mint the run-id up front so metadata is persisted *at run start* (spec §8.7); the engine stays
  // file-unaware and simply uses the injected id.
  const runId = randomUUID();
  const result = await runGuarded(guard, runId, notifier(ctx), async (signal) => {
    await store.saveMeta(runId, { workflowFilePath, workflowName: workflow.name });
    const host = createHostPort(store, { generateRunId: () => runId, startAgent });
    return runWorkflow(workflow, initialInput, host, { signal });
  });
  if (!result) return; // guard was busy (race) — already notified

  // Attended flow: if the run parked, render the questionnaire inline and loop until it settles.
  if (result.status === "parked") {
    await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, workflowFilePath, startAgent, runId, result.questionnaire);
  } else {
    notifyResult(ctx, workflow.name, result);
  }
}
