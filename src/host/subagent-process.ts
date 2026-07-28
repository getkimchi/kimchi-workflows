/**
 * The subprocess half of a background subagent step (spec §2.2): spawn one `pi --mode json -p` process,
 * reduce its stdout to the final assistant turn AS IT ARRIVES, bound its stderr, and make sure an
 * aborted attempt actually ends the process rather than merely stopping waiting for it.
 *
 * Split out of pi-agent.ts, which owns the PI-facing bridge and knows nothing about pipes; everything
 * here is plain Node and one pure reader (`createAssistantTurnReader`, pi-agent-messages.ts), so the
 * whole file is exercisable offline through the {@link SubagentSpawner} seam. Why any of this is a
 * subprocess at all, and why it streams rather than buffering, is recorded in pi-agent.ts's header.
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { AgentTurn } from "../engine/types.ts";
import { createAssistantTurnReader } from "./pi-agent-messages.ts";

/**
 * The part of a `child_process.ChildProcess` a background subagent needs: two pipes to drain, an exit to
 * await, and a way to kill it. Structural on purpose — a real `ChildProcess` satisfies it, and so does a
 * test fake built from two streams, with no cast and no real binary.
 */
export interface SubagentProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: "exit" | "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** How a background subagent's process is started; injectable so the streaming/abort wiring is testable offline. */
export type SubagentSpawner = (command: string, args: readonly string[]) => SubagentProcess;

/** The default spawner: a real child process with stdin closed and both output pipes ours to drain. */
export const subagentSpawner: SubagentSpawner = (command, args) => spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });

/**
 * How much of a failing subagent's stderr to keep for its error message.
 *
 * stderr is read for exactly one reason — naming the cause in the error thrown on a non-zero exit — and
 * what explains a failure is the END of it: the stack, the last log line, the "no such model" the CLI
 * printed before giving up. Keeping it whole is the same unbounded-buffer bug as stdout, and a subagent
 * that fails after printing a GB of warnings would cost the parent that GB to report one line of it.
 * 8KiB is comfortably more than the deepest stack or CLI usage dump anyone reads out of a thrown error,
 * and small enough that the cap can never itself be a memory problem across concurrent subagents.
 */
const STDERR_TAIL_CHARS = 8 * 1024;

/** How long a subagent gets to honour SIGTERM before it is killed outright — see {@link killOnAbort}. */
const SIGKILL_GRACE_MS = 5000;

/**
 * How long after a subagent has exited its pipes may stay quiet before they are given up on.
 *
 * A subagent that leaves a descendant behind — `npm run dev &`, a spawned server, anything daemonized —
 * leaves that descendant holding the inherited stdout handle, so the pipe never closes even though the
 * `pi` process it belonged to is long gone. Waiting for `close` alone would hang such a step forever.
 * Waiting a fixed deadline from `exit` instead would truncate the tail of a child still writing, which is
 * where the final assistant message is. So the timer is re-armed on every chunk: output still arriving
 * keeps us reading, and only a genuinely idle inherited handle releases us. This mirrors PI's own
 * `waitForChildProcess` (utils/child-process.ts, and its issue #5303), which is what `pi.exec` used to
 * apply on our behalf — the same 100ms it uses, for the same reason.
 */
const PIPE_IDLE_GRACE_MS = 100;

/** Everything a finished subagent process leaves behind — all of it bounded, none of it its stdout. */
export interface SubagentResult {
  readonly code: number;
  readonly turn: AgentTurn;
  /** The last {@link STDERR_TAIL_CHARS} of stderr — enough to name a failure, capped so it cannot be one. */
  readonly stderrTail: string;
}

/**
 * Run one subagent process to completion, reducing its output AS IT ARRIVES rather than collecting it.
 *
 * Both pipes are drained the moment they produce anything — stdout into the incremental reader, stderr
 * into a fixed-size tail — so nothing this function holds grows with how much the child says.
 *
 * A child ended by a SIGNAL has no exit code; it is reported as 0, which is what `pi.exec` did (`code ??
 * 0`) and so keeps a cancel reading as a cancel rather than as a mystery exit. The one signal we send
 * ourselves is on abort, and pi-agent.ts's `backgroundSession` checks `signal.aborted` before it looks
 * at the code at all.
 */
export async function runSubagent(spawnSubagent: SubagentSpawner, command: string, args: readonly string[], signal: AbortSignal | undefined): Promise<SubagentResult> {
  const child = spawnSubagent(command, args);
  const reader = createAssistantTurnReader();
  let stderrTail = "";

  // Listeners first, abort wiring second: an ALREADY-aborted attempt kills the child on the next line,
  // and nothing about that exit may happen before there is something watching for it.
  const exited = waitForExit(child, {
    stdout: (chunk) => reader.push(chunk),
    stderr: (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    },
  });
  const stopWatchingAbort = killOnAbort(child, signal);

  try {
    return { code: (await exited) ?? 0, turn: reader.end(), stderrTail };
  } finally {
    stopWatchingAbort();
  }
}

/**
 * Kill the child when `signal` aborts (spec §8.8/§9.4); returns the undo, to be called once it is reaped.
 *
 * This is the part `pi.exec`'s `signal` option used to do for us, and it does it the same way: SIGTERM,
 * then SIGKILL if the child is still there {@link SIGKILL_GRACE_MS} later — because a SIGTERM is a
 * request, and a subagent wedged in an uninterruptible call or trapping the signal would otherwise
 * outlive the run that was supposed to bound it, with nothing left holding a reference to it.
 */
function killOnAbort(child: SubagentProcess, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  let escalation: NodeJS.Timeout | undefined;
  const kill = (): void => {
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS).unref();
  };
  if (signal.aborted) kill();
  else signal.addEventListener("abort", kill, { once: true });
  return () => {
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener("abort", kill);
  };
}

/**
 * Wait for the child to terminate and for its output to stop, feeding every chunk to `sink` on the way.
 *
 * Resolving on `close` alone is the obvious reading — it means "exited AND pipes closed" — and it is the
 * one that hangs forever on a subagent that left a descendant holding stdout (see
 * {@link PIPE_IDLE_GRACE_MS}). So `exit` is what starts the countdown and an idle pipe is what ends it,
 * with `close` short-circuiting the ordinary case where the child simply finished.
 */
function waitForExit(child: SubagentProcess, sink: { stdout: (chunk: string) => void; stderr: (chunk: string) => void }): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let openPipes = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0);
    let idle: NodeJS.Timeout | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      child.stdout?.destroy(); // let go of a handle a descendant is still holding open
      child.stderr?.destroy();
      resolve(code);
    };
    const armIdle = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => finish(exitCode), PIPE_IDLE_GRACE_MS);
    };
    const drain = (pipe: Readable | null, consume: (chunk: string) => void): void => {
      if (!pipe) return;
      // `setEncoding` hands over decoded strings and, more to the point, holds back the trailing bytes of
      // a multi-byte character split across two reads — a chunk boundary must not corrupt a reply.
      pipe.setEncoding("utf8");
      pipe.on("data", (chunk: string) => {
        consume(chunk);
        if (exited) armIdle(); // still talking after exiting: keep reading rather than cut it off
      });
      // A pipe can fail on its own (EPIPE/ECONNRESET), most often because we just killed the child.
      // Unhandled that is an uncaught exception taking the harness down; the exit is what decides here.
      pipe.on("error", () => {});
      pipe.once("end", () => {
        openPipes--;
        if (exited && openPipes === 0) finish(exitCode);
      });
    };

    drain(child.stdout, sink.stdout);
    drain(child.stderr, sink.stderr);

    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      reject(error); // the spawn itself failed (a missing binary); there was never a process to read
    });
    child.on("exit", (code: number | null) => {
      exited = true;
      exitCode = code;
      if (openPipes === 0) finish(code);
      else armIdle();
    });
    child.on("close", (code: number | null) => finish(code));
  });
}
