/**
 * PI host adapter (spec: "PI host adapter"). Registers the `/workflow` command against the real
 * `@earendil-works/pi-coding-agent` extension API.
 *
 * Scope through 6b: `run`, `list`, `resume` (status-aware), `delete`, `cancel`; the single-running-run
 * blocking guard (spec §7, released on park); agent + Q&A + questionnaire steps with an attended
 * inline answer loop (spec §10.2, dismiss ≠ cancel).
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Questionnaire } from "../flow/questionnaire.ts";
import { resumeWithAnswer, resumeWorkflow } from "../engine/resume-workflow.ts";
import { runWorkflow } from "../engine/run-workflow.ts";
import type { AgentRequest, AgentSession, RunEvent, RunResult } from "../engine/types.ts";
import { createFsRunStore } from "./fs-run-store.ts";
import { createHostPort } from "./host-port.ts";
import { loadWorkflowFile } from "./load-workflow.ts";
import { createPiAgentBridge } from "./pi-agent.ts";
import { collectAnswers } from "./questionnaire-render.ts";
import { resumeAction } from "./resume-router.ts";
import { createRunGuard, type RunGuard } from "./run-guard.ts";
import { summarizeRun } from "./summarize-run.ts";
import type { RunStore } from "./types.ts";

type StartAgent = (request: AgentRequest) => AgentSession;

/**
 * The slice of the command context the handlers actually use. The registered handler still receives the
 * full `ExtensionCommandContext` (structurally compatible), but narrowing here documents the surface and
 * makes the handlers unit-testable with a small fake.
 */
export type CommandCtx = Pick<ExtensionCommandContext, "ui" | "cwd" | "mode" | "hasUI" | "modelRegistry">;
type Notify = CommandCtx["ui"]["notify"];

/** The single race message when the guard is taken between check and `begin` (spec §7). */
const RUN_BUSY_MESSAGE = "workflow: another run became active; try again.";

/**
 * Own the guard lifecycle for one execution (spec §7): acquire `begin(runId)`; if the guard is busy,
 * emit the shared race message and return `undefined`; otherwise run with the run's abort signal and
 * release on every outcome (including `parked` — parked ≠ running). Returns the run result, or
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

export default function piWorkflowsExtension(pi: ExtensionAPI): void {
  const guard = createRunGuard(); // one active run per process (spec §7)
  const bindAgentStarter = createPiAgentBridge(pi); // one agent_end listener for the extension's lifetime

  pi.registerCommand("workflow", {
    description: "Run, list, resume, cancel, and delete PI workflows",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const store = createFsRunStore(ctx.cwd);
      const startAgent = bindAgentStarter(ctx.modelRegistry);

      if (sub === "run") {
        const file = rest[0];
        if (!file) return void ctx.ui.notify("usage: /workflow run <file.ts>", "warning");
        await handleRun(ctx, store, guard, startAgent, file);
        return;
      }

      if (sub === "resume") {
        const runId = rest[0];
        if (!runId) return void ctx.ui.notify("usage: /workflow resume <run-id>", "warning");
        await handleResume(ctx, store, guard, startAgent, runId);
        return;
      }

      if (sub === "cancel") {
        handleCancel(ctx, guard, rest[0]);
        return;
      }

      if (sub === "delete") {
        const runId = rest[0];
        if (!runId) return void ctx.ui.notify("usage: /workflow delete <run-id>", "warning");
        await store.delete(runId);
        ctx.ui.notify(`workflow: deleted run ${runId}.`, "info");
        return;
      }

      if (!sub || sub === "list") {
        await handleList(ctx, store);
        return;
      }

      ctx.ui.notify(`workflow: unknown subcommand "${sub}". Try run | list | resume | cancel | delete.`, "warning");
    },
  });
}

async function handleRun(ctx: CommandCtx, store: RunStore, guard: RunGuard, startAgent: StartAgent, file: string): Promise<void> {
  if (guard.active) {
    ctx.ui.notify(`workflow: run ${guard.active.runId} is already active; cancel it or wait before starting another.`, "warning");
    return;
  }

  const resolvedPath = path.resolve(ctx.cwd, file);
  const workflow = await loadWorkflowFile(resolvedPath).catch((err: unknown) => {
    ctx.ui.notify(`workflow: failed to load "${file}": ${describe(err)}`, "error");
    return undefined;
  });
  if (!workflow) return;

  // Mint the run-id up front so metadata is persisted *at run start* (spec §8.7); the engine stays
  // file-unaware and simply uses the injected id.
  const runId = randomUUID();
  const result = await runGuarded(guard, runId, notifier(ctx), async (signal) => {
    await store.saveMeta(runId, { workflowFilePath: resolvedPath, workflowName: workflow.name });
    const host = createHostPort(store, { generateRunId: () => runId, startAgent });
    return runWorkflow(workflow, undefined, host, { signal });
  });
  if (!result) return; // guard was busy (race) — already notified

  // Attended flow: if the run parked, render the questionnaire inline and loop until it settles.
  if (result.status === "parked") {
    await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, resolvedPath, startAgent, runId, result.questionnaire);
  } else {
    notifyResult(ctx, workflow.name, result);
  }
}

async function handleResume(ctx: CommandCtx, store: RunStore, guard: RunGuard, startAgent: StartAgent, runId: string): Promise<void> {
  if (guard.active) {
    ctx.ui.notify(`workflow: run ${guard.active.runId} is already active; cancel it or wait before resuming another.`, "warning");
    return;
  }

  const meta = await store.loadMeta(runId);
  if (!meta) return void ctx.ui.notify(`workflow: no run "${runId}" to resume.`, "error");

  const workflow = await loadWorkflowFile(meta.workflowFilePath).catch((err: unknown) => {
    ctx.ui.notify(`workflow: failed to reload "${meta.workflowFilePath}" for resume: ${describe(err)}`, "error");
    return undefined;
  });
  if (!workflow) return;

  const events = await store.loadEvents(runId);
  const status = summarizeRun(events)?.status;
  if (!status) return void ctx.ui.notify(`workflow: run "${runId}" has no recorded events.`, "error");

  // Pure routing (spec §5.2): parked → answer path; crashed/cancelled → re-run; completed → error.
  const action = resumeAction(status);
  if (action.kind === "error") return void ctx.ui.notify(`workflow: cannot resume run ${runId}: ${action.reason}.`, "warning");

  if (action.kind === "answer") {
    await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, meta.workflowFilePath, startAgent, runId, pendingQuestionnaire(events));
    return;
  }

  // rerun: node-atomic re-run (3a/5a). A re-run may itself reach a Q&A step and park → attend it.
  const result = await runGuarded(guard, runId, notifier(ctx), (signal) => {
    const host = createHostPort(store, { startAgent });
    return resumeWorkflow(workflow, events, host, { signal });
  });
  if (!result) return; // guard was busy (race) — already notified

  if (result.status === "parked") {
    await handleAttendedQuestionnaire(ctx, store, guard, workflow.name, meta.workflowFilePath, startAgent, runId, result.questionnaire);
  } else {
    notifyResult(ctx, workflow.name, result);
  }
}

/**
 * Attended inline Q&A loop (spec §10.2): render the pending questionnaire (rich `ctx.ui.custom` form
 * when a TUI is present, native dialogs otherwise — see {@link collectAnswers}), collect structured
 * answers, and continue via `resumeWithAnswer` — looping while it re-parks. Dismissing the prompt
 * leaves the run `parked` (dismiss ≠ cancel). The guard is acquired only around each resume execution,
 * so while parked/prompting it is released and does not block new runs (spec §7).
 */
async function handleAttendedQuestionnaire(
  ctx: CommandCtx,
  store: RunStore,
  guard: RunGuard,
  workflowName: string,
  workflowFilePath: string,
  startAgent: StartAgent,
  runId: string,
  initialQuestionnaire: Questionnaire | undefined,
): Promise<void> {
  let questionnaire = initialQuestionnaire;
  for (;;) {
    if (!questionnaire) return void ctx.ui.notify(`workflow: run ${runId} is parked but has no recorded questions.`, "warning");

    const answers = await collectAnswers(ctx, questionnaire);
    if (answers === undefined) {
      // Dismiss ≠ cancel (spec §10.2): the run stays parked and is resumable later.
      ctx.ui.notify(`workflow: run ${runId} is still parked; answer later via "/workflow resume ${runId}", or "/workflow cancel" to stop it.`, "info");
      return;
    }

    const result = await runGuarded(guard, runId, notifier(ctx), async (signal) => {
      const workflow = await loadWorkflowFile(workflowFilePath);
      const events = await store.loadEvents(runId);
      const host = createHostPort(store, { startAgent });
      return resumeWithAnswer(workflow, events, answers, host, { signal });
    });
    if (!result) return; // guard was busy (race) — already notified; the run stays parked

    if (result.status === "parked") {
      questionnaire = result.questionnaire; // re-park (another batch, or invalid answers) → ask again
      continue;
    }
    notifyResult(ctx, workflowName, result);
    return;
  }
}

function handleCancel(ctx: CommandCtx, guard: RunGuard, runIdArg: string | undefined): void {
  const active = guard.active;
  if (!active) return void ctx.ui.notify("workflow: no run is currently active to cancel.", "info");
  if (runIdArg && runIdArg !== active.runId) {
    ctx.ui.notify(`workflow: run ${runIdArg} is not the active run (${active.runId}).`, "warning");
    return;
  }
  active.controller.abort();
  ctx.ui.notify(`workflow: cancelling run ${active.runId} at the next step boundary...`, "info");
}

export async function handleList(ctx: { ui: Pick<CommandCtx["ui"], "notify"> }, store: Pick<RunStore, "list">): Promise<void> {
  const runs = await store.list();
  if (runs.length === 0) return void ctx.ui.notify("No workflow runs recorded.", "info");
  const lines = runs.map((run) => `${run.runId}  ${run.workflowName}  ${run.status}  started=${run.startedAt}  completed=${run.completedAt ?? "-"}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

function notifyResult(ctx: CommandCtx, workflowName: string, result: RunResult): void {
  if (result.status === "completed") {
    ctx.ui.notify(`workflow "${workflowName}" completed (run ${result.runId}).`, "info");
  } else if (result.status === "cancelled") {
    ctx.ui.notify(`workflow "${workflowName}" cancelled (run ${result.runId}); resume to continue.`, "warning");
  } else if (result.status === "parked") {
    ctx.ui.notify(`workflow "${workflowName}" parked (run ${result.runId}) awaiting answers.`, "info");
  } else {
    ctx.ui.notify(`workflow "${workflowName}" crashed (run ${result.runId}): ${result.error}`, "error");
  }
}

/** The pending questionnaire of a parked run: the last `questionnaire-asked` payload. */
function pendingQuestionnaire(events: readonly RunEvent[]): Questionnaire | undefined {
  let questionnaire: Questionnaire | undefined;
  for (const event of events) {
    if (event.type === "questionnaire-asked") questionnaire = event.questionnaire;
  }
  return questionnaire;
}

/** A `this`-safe {@link Notify} bound to a context's UI, for passing into {@link runGuarded}. */
function notifier(ctx: Pick<CommandCtx, "ui">): Notify {
  return (message, type) => ctx.ui.notify(message, type);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
