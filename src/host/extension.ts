/**
 * PI host adapter (spec: "PI host adapter"). Registers the `/workflow` command against the real
 * `@earendil-works/pi-coding-agent` extension API.
 *
 * This module is **argument dispatch only** — parse the subcommand, bind the per-invocation store and
 * agent starter, delegate. Every handler lives in `./commands/`, takes the narrowest context it needs,
 * and is unit-testable without a PI session.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleCancel, handleCreate, handleDelete, handleListRuns, handleListWorkflows, handleResume, handleRun, handleStatus } from "./commands/index.ts";
import { createFsStore } from "./fs-store.ts";
import { createPiAgentBridge } from "./pi-agent.ts";
import { bindProgress } from "./progress-sink.ts";
import { runArtifactsDir } from "./project-dir.ts";
import { createRunLock } from "./run-lock.ts";

export default function piWorkflowsExtension(pi: ExtensionAPI): void {
  const guard = createRunLock(); // one execution slot per project, backed by the file lock (spec §7)
  const bindAgentStarter = createPiAgentBridge(pi); // one agent_end listener for the extension's lifetime

  pi.registerCommand("workflow", {
    description: "Create, run, list, show, resume, cancel, and delete PI workflows",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      // Resolved per invocation, not at load: the session directory is a property of the CONTEXT (it
      // moves with `--session-dir`, and is empty under `--no-session`), and `ctx` does not exist when
      // this extension is loaded. Everything a run writes — its event log and every step session — lands
      // in this one directory (project-dir.ts).
      const runDir = runArtifactsDir(ctx.cwd, ctx.sessionManager.getSessionDir());
      const store = createFsStore(runDir);
      const startAgent = bindAgentStarter(ctx.modelRegistry, runDir);
      // The live surface, chosen per invocation from `ctx.mode` (progress §7.2) — the context is what
      // knows whether there is a terminal to draw in, and it does not exist until a command runs.
      const progressFor = bindProgress(ctx);

      switch (sub) {
        case "run": {
          // `list` is reserved as the first argument to `run`, so it can never name a workflow (spec §6.3).
          if (rest[0] === "list") return void (await handleListRuns(ctx, store));
          const target = rest[0];
          if (!target) return void ctx.ui.notify("usage: /workflow run <name|file.ts>  |  /workflow run list", "warning");
          return void (await handleRun(ctx, store, guard, startAgent, target, progressFor));
        }

        case "create":
          return void (await handleCreate(ctx, store, guard, startAgent, progressFor));

        case "resume": {
          const runId = rest[0];
          if (!runId) return void ctx.ui.notify("usage: /workflow resume <run-id>", "warning");
          return void (await handleResume(ctx, store, guard, startAgent, runId, progressFor));
        }

        // `/workflow status [run-id]` (progress §11.4) — the fully expanded tree, for the executing run
        // or any recorded one. With no argument it means "the one running right now", which the project
        // lock (spec §7) is the authority on.
        case "status":
          return void (await handleStatus(ctx, store, { activeRunId: () => guard.active?.runId }, rest[0]));

        case "cancel":
          return void (await handleCancel(ctx, guard, store, rest[0]));

        case "delete": {
          const runId = rest[0];
          if (!runId) return void ctx.ui.notify("usage: /workflow delete <run-id>", "warning");
          return void (await handleDelete(ctx, store, runId));
        }

        case undefined:
        case "list":
          return void (await handleListWorkflows(ctx));

        default:
          ctx.ui.notify(`workflow: unknown subcommand "${sub}". Try run | create | list | status | resume | cancel | delete.`, "warning");
      }
    },
  });
}
