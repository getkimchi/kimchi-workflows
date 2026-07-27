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
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "../../src/engine/run-workflow.ts";
import type { AgentRequest, AgentSession } from "../../src/engine/types.ts";
import type { WorkflowDefinition } from "../../src/flow/index.ts";
import { createFsStore } from "../../src/host/fs-store.ts";
import { createHostPort } from "../../src/host/host-port.ts";
import { createPiAgentBridge } from "../../src/host/pi-agent.ts";
import fermentOneshot from "./ferment/ferment-oneshot.workflow.ts";
import tbSolver from "./tb-solver.workflow.ts";

/** Agent-phase budget in seconds (harbor's `[agent] timeout_sec`); the adapter passes it through. */
const DEFAULT_TIMEOUT_SEC = 900;
/**
 * Stop this much before the harness would kill us. The last round needs room to land, and a run torn
 * down mid-write is strictly worse than one that stopped early — the container is graded either way.
 */
const SAFETY_MARGIN_SEC = 45;

function readTimeoutSec(): number {
  const raw = Number(process.env.TB_AGENT_TIMEOUT_SEC ?? DEFAULT_TIMEOUT_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_SEC;
}

/**
 * Which solver this run uses, chosen by `TB_WORKFLOW` (`--ae TB_WORKFLOW=ferment` on the harbor side;
 * agent env is wired into the container's exec environment by the trial).
 *
 * Two solvers, one extension, because they are the same experiment run twice: the same instruction, the
 * same deadline, the same subagent host — only the workflow differs. `tb-solver` is designed from
 * terminal-bench's own measured failures; `ferment-oneshot` is kimchi's one-shot ferment rendered as a
 * workflow, so a comparison between them is a comparison of designs rather than of harnesses.
 */
const WORKFLOWS: Record<string, WorkflowDefinition> = { solver: tbSolver, ferment: fermentOneshot };
const DEFAULT_WORKFLOW = "solver";

function selectWorkflow(): WorkflowDefinition {
  const requested = (process.env.TB_WORKFLOW ?? DEFAULT_WORKFLOW).trim().toLowerCase();
  const selected = WORKFLOWS[requested];
  if (selected) return selected;
  log(`unknown TB_WORKFLOW="${requested}" (known: ${Object.keys(WORKFLOWS).join(", ")}) — falling back to ${DEFAULT_WORKFLOW}`);
  return WORKFLOWS[DEFAULT_WORKFLOW] as WorkflowDefinition;
}

/** Progress goes to stderr: harbor captures it per trial, and in `--print` mode `ui.notify` has nowhere to render. */
function log(message: string): void {
  // biome-ignore lint/suspicious/noConsole: stderr is the only channel a --print run has; harbor captures it per trial
  console.error(`[tb-workflow] ${message}`);
}

/**
 * Run the solver over one instruction, owning its own deadline.
 *
 * Cancellation is ours: `ctx.signal` is undefined outside an agent turn (PI's docs), and the harness's
 * own timeout arrives as a process-group kill that would land mid-edit. So this sets a deadline a
 * little before the harness's and aborts the run itself, which the engine propagates into every
 * in-flight subagent (`AgentRequest.signal`), leaving the machine in a settled state.
 */
async function solve(instruction: string, startAgent: (request: AgentRequest) => AgentSession, cwd: string): Promise<void> {
  const budgetSec = Math.max(30, readTimeoutSec() - SAFETY_MARGIN_SEC);
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
    const store = createFsStore(process.env.TB_LOG_DIR ?? cwd);
    const host = createHostPort(store, { startAgent });
    const workflow = selectWorkflow();

    log(`starting: workflow ${workflow.name}, budget ${budgetSec}s, model ${process.env.TB_MODEL ?? "(workflow default)"}, cwd ${cwd}`);
    const result = await runWorkflow(workflow, { instruction, deadlineIso }, host, { signal: controller.signal });
    log(`run ${result.runId} ${result.status} ${result.status === "completed" ? JSON.stringify(result.output) : (result.error ?? "")}`);
  } catch (err) {
    // Never let a workflow failure surface as a harness crash: the container still holds whatever work
    // landed before the failure, and that is what gets graded.
    log(`run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
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
    try {
      await solve(instruction, bindAgentStarter(ctx.modelRegistry), ctx.cwd);
    } finally {
      running = false;
    }
    return { action: "handled" };
  });
}
