/**
 * PI host adapter (spec: "PI host adapter"). Registers the `/workflow` command against the real
 * `@earendil-works/pi-coding-agent` extension API.
 *
 * This module is **argument dispatch only** — parse the subcommand, bind the per-invocation store and
 * agent starter, delegate. Every handler lives in `./commands/`, takes the narrowest context it needs,
 * and is unit-testable without a PI session.
 *
 * `/workflow` reaches this through exactly one door: `pi.registerCommand`. `print`/`json` mode need no
 * extension-side help to get here — `AgentSession.prompt()` (pi-coding-agent's `agent-session.js`)
 * dispatches a registered extension command BEFORE it ever emits the `input` event those modes' prompt
 * path fires on, so a `/workflow …` line piped into either mode is already routed to this same handler
 * by the harness itself (spec §6.10).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { createActiveRuns } from "./active-runs.ts"
import {
	handleCancel,
	handleCreate,
	handleDelete,
	handleListRuns,
	handleListWorkflows,
	handleResume,
	handleRun,
	handleStatus,
	parseRunArgs,
} from "./commands/index.ts"
import { createCompletionSources } from "./completion-sources.ts"
import { completeWorkflowArgument } from "./completions.ts"
import { createFsStore } from "./fs-store.ts"
import { createPiAgentBridge } from "./pi-agent.ts"
import { bindProgress } from "./progress-sink.ts"
import { runArtifactsDir } from "./project-dir.ts"
import { registerStepOutputToolsFromEnv } from "./step-output-tools.ts"
import { withTelemetry } from "./telemetry-bridge.ts"

export default function piWorkflowsExtension(pi: ExtensionAPI): void {
	// A process spawned as a workflow STEP is not a workflow host: it registers the step's output tools
	// (step-output-tools.ts) and nothing else. Registering `/workflow` there would let a step start a
	// nested run inside the run it belongs to.
	if (registerStepOutputToolsFromEnv(pi)) return

	const activeRuns = createActiveRuns() // lifecycle visibility only; never limits concurrent executions
	const bindAgentStarter = createPiAgentBridge(pi) // one shared listener set for the extension's lifetime
	const completionSources = createCompletionSources()

	// The completion callback is given no context of its own (spec §14.2), so the pair the store is built
	// from below is captured here — on every session start, whatever the reason (spec §14.7).
	pi.on("session_start", (_event, ctx) => completionSources.setProject(ctx.cwd, ctx.sessionManager.getSessionDir()))

	pi.registerCommand("workflow", {
		// An extension cannot set an `argumentHint` (spec §14.9), so the description names the verbs.
		description: "PI workflows: run | create | list | status | resume | cancel | delete",
		getArgumentCompletions: (argumentPrefix: string) => completeWorkflowArgument(argumentPrefix, completionSources),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmedArgs = args.trim()
			const [sub, ...rest] = trimmedArgs.split(/\s+/).filter(Boolean)
			// Resolved per invocation, not at load: the session directory is a property of the CONTEXT (it
			// moves with `--session-dir`, and is empty under `--no-session`), and `ctx` does not exist when
			// this extension is loaded. Everything a run writes — its event log and every step session — lands
			// in this one directory (project-dir.ts).
			const runDir = runArtifactsDir(ctx.cwd, ctx.sessionManager.getSessionDir())
			// Telemetry (telemetry spec R1–R7) attaches HERE, at the one store every command path shares, so
			// every event a run records — including the cold-cancel terminal the engine never emits — is
			// published without each write site having to remember to. It only
			// publishes on the harness bus; whether anything ships is a subscriber's decision, and with no
			// subscriber loaded (plain PI) the whole thing is inert.
			const store = withTelemetry(createFsStore(runDir), (channel, data) => pi.events.emit(channel, data))
			const startAgent = bindAgentStarter(ctx.modelRegistry, runDir, ctx)
			// The live surface, chosen per invocation from `ctx.mode` (progress §7.2) — the context is what
			// knows whether there is a terminal to draw in, and it does not exist until a command runs.
			const progressFor = bindProgress(ctx)

			switch (sub) {
				case "run": {
					// `list` is reserved as the first argument to `run`, so it can never name a workflow (spec §6.3).
					if (rest[0] === "list") return void (await handleListRuns(ctx, store))

					// Re-sliced from the RAW (not `\s+`-collapsed) remainder: `--input`'s own payload is very
					// often a JSON object containing spaces (spec §6.1), and `rest` above has already thrown that
					// whitespace away by the time we'd see it.
					const runArgs = trimmedArgs.slice(sub.length).trim()
					const parsed = parseRunArgs(runArgs)
					if (parsed.error) return void ctx.ui.notify(`workflow: ${parsed.error}`, "error")
					if (!parsed.target)
						return void ctx.ui.notify(
							"usage: /workflow run <name|file.ts> [--input <json>|@<file>]  |  /workflow run list",
							"warning",
						)
					return void (await handleRun(ctx, store, activeRuns, startAgent, parsed.target, parsed.inputArg, progressFor))
				}

				case "create":
					return void (await handleCreate(ctx, store, activeRuns, startAgent, progressFor))

				case "resume": {
					const runId = rest[0]
					if (!runId) return void ctx.ui.notify("usage: /workflow resume <run-id>", "warning")
					return void (await handleResume(ctx, store, activeRuns, startAgent, runId, progressFor))
				}

				// `/workflow status [run-id]` (progress §11.4) — the fully expanded tree, for the executing run
				// or any recorded one. With no argument it works only when one local execution is unambiguous.
				case "status":
					return void (await handleStatus(
						ctx,
						store,
						{ activeRunIds: () => activeRuns.active.map((run) => run.runId) },
						rest[0],
					))

				case "cancel":
					return void (await handleCancel(ctx, activeRuns, store, rest[0]))

				case "delete": {
					const runId = rest[0]
					if (!runId) return void ctx.ui.notify("usage: /workflow delete <run-id>", "warning")
					return void (await handleDelete(ctx, store, runId))
				}

				case undefined:
				case "list":
					return void (await handleListWorkflows(ctx))

				default:
					ctx.ui.notify(
						`workflow: unknown subcommand "${sub}". Try run | create | list | status | resume | cancel | delete.`,
						"warning",
					)
			}
		},
	})
}
