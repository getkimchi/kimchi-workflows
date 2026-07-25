/**
 * The terminal-bench agent, as a PI extension.
 *
 * Loading this with `-e` turns an ordinary harness run into a workflow run: the benchmark instruction
 * arrives on stdin like it always did, but instead of starting one long agent loop, the `input` event
 * swallows it (`action: "handled"`, so no LLM turn ever begins) and hands it to the engine as a
 * workflow input. Nothing is compiled or pre-linked into a separate agent binary — the harness process
 * IS the orchestrator, and every step it runs is a fresh subprocess of that same binary
 * (`src/host/pi-agent.ts` respawns `process.execPath`), so subagents inherit its provider, auth and
 * model registry rather than guessing at them.
 *
 * Why `input` rather than a `/workflow run` command: in `--print` mode a slash command piped on stdin
 * is treated as prompt text, not dispatched — whereas `input` fires for exactly that piped text, before
 * expansion, and can consume it. It also sees the raw string, which matters because terminal-bench
 * instructions routinely begin with `-` (the reason the harbor adapter pipes them via stdin at all).
 *
 * Cancellation is ours to own: `ctx.signal` is undefined outside an agent turn (PI's docs), and the
 * harness's own timeout arrives as a process-group kill that would land mid-edit. So this installs its
 * own deadline — a little before the harness's — and aborts the run, which the engine propagates into
 * every in-flight subagent (`AgentRequest.signal`), leaving the machine in a settled state.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "../../src/engine/run-workflow.ts";
import { createFsStore } from "../../src/host/fs-store.ts";
import { createHostPort } from "../../src/host/host-port.ts";
import { createPiAgentBridge } from "../../src/host/pi-agent.ts";
import tbSolver from "./tb-solver.workflow.ts";

/** Agent-phase budget in seconds (harbor's `[agent] timeout_sec`); the adapter passes it through. */
const DEFAULT_TIMEOUT_SEC = 900;
/**
 * Stop this much before the harness would kill us. The sweep needs room to land, and a run torn down
 * mid-write is strictly worse than one that stopped early — the container is graded either way.
 */
const SAFETY_MARGIN_SEC = 45;

function readTimeoutSec(): number {
  const raw = Number(process.env.TB_AGENT_TIMEOUT_SEC ?? DEFAULT_TIMEOUT_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_SEC;
}

/** Progress goes to stderr: harbor captures it per trial, and in `--print` mode `ui.notify` has nowhere to render. */
function log(message: string): void {
  console.error(`[tb-workflow] ${message}`);
}

export default function terminalBenchAgent(pi: ExtensionAPI): void {
  const bindAgentStarter = createPiAgentBridge(pi);
  let running = false;

  pi.on("input", async (event, ctx) => {
    // Only the harness's own inbound instruction starts a run: a message this extension itself injected
    // (or a second prompt while a run is in flight) must fall through untouched.
    if (event.source === "extension" || running) return { action: "continue" };
    const instruction = event.text.trim();
    if (instruction.length === 0) return { action: "continue" };

    running = true;
    const timeoutSec = readTimeoutSec();
    const budgetSec = Math.max(30, timeoutSec - SAFETY_MARGIN_SEC);
    const deadlineIso = new Date(Date.now() + budgetSec * 1000).toISOString();

    const controller = new AbortController();
    const deadline = setTimeout(() => {
      log(`deadline reached after ${budgetSec}s — aborting; in-flight subagents are stopped with it`);
      controller.abort();
    }, budgetSec * 1000);
    // A process-group kill (harbor's timeout path) still gives us a moment to stop cleanly.
    const onSignal = () => controller.abort();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);

    try {
      const store = createFsStore(process.env.TB_LOG_DIR ?? ctx.cwd);
      const host = createHostPort(store, { startAgent: bindAgentStarter(ctx.modelRegistry) });

      log(`starting: budget ${budgetSec}s, model ${process.env.TB_MODEL ?? "(workflow default)"}, cwd ${ctx.cwd}`);
      const result = await runWorkflow(tbSolver, { instruction, deadlineIso }, host, { signal: controller.signal });
      const summary = result.status === "completed" ? JSON.stringify(result.output) : (result.error ?? "");
      log(`run ${result.runId} ${result.status} ${summary}`);
    } catch (err) {
      // Never let a workflow failure surface as a harness crash: the container still has whatever work
      // landed before the failure, and that is what gets graded.
      log(`run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    } finally {
      clearTimeout(deadline);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      running = false;
    }

    return { action: "handled" };
  });
}
