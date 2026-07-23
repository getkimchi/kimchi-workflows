/**
 * PI host adapter (spec: "PI host adapter"). Registers the `/workflow` command against the real
 * `@earendil-works/pi-coding-agent` extension API.
 *
 * This module is **argument dispatch only** — parse the subcommand, bind the per-invocation store and
 * agent starter, delegate. Every handler lives in `./commands/`, takes the narrowest context it needs,
 * and is unit-testable without a PI session.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleCancel, handleCreate, handleDelete, handleListRuns, handleListWorkflows, handleResume, handleRun } from "./commands/index.ts";
import { createFsStore } from "./fs-store.ts";
import { createPiAgentBridge } from "./pi-agent.ts";
import { createRunGuard } from "./run-guard.ts";

export default function piWorkflowsExtension(pi: ExtensionAPI): void {
  const guard = createRunGuard(); // one active run per process (spec §7)
  const bindAgentStarter = createPiAgentBridge(pi); // one agent_end listener for the extension's lifetime

  pi.registerCommand("workflow", {
    description: "Create, run, list, resume, cancel, and delete PI workflows",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const store = createFsStore(ctx.cwd);
      const startAgent = bindAgentStarter(ctx.modelRegistry);

      switch (sub) {
        case "run": {
          // `list` is reserved as the first argument to `run`, so it can never name a workflow (spec §6.3).
          if (rest[0] === "list") return void (await handleListRuns(ctx, store));
          const target = rest[0];
          if (!target) return void ctx.ui.notify("usage: /workflow run <name|file.ts>  |  /workflow run list", "warning");
          return void (await handleRun(ctx, store, guard, startAgent, target));
        }

        case "create":
          return void (await handleCreate(ctx, store, guard, startAgent));

        case "resume": {
          const runId = rest[0];
          if (!runId) return void ctx.ui.notify("usage: /workflow resume <run-id>", "warning");
          return void (await handleResume(ctx, store, guard, startAgent, runId));
        }

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
          ctx.ui.notify(`workflow: unknown subcommand "${sub}". Try run | create | list | resume | cancel | delete.`, "warning");
      }
    },
  });
}
