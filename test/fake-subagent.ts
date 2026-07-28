import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { SubagentProcess, SubagentSpawner } from "../src/host/subagent-process.ts";

/**
 * A scripted stand-in for the `pi` subprocess a background step spawns (spec §2.2, see
 * src/host/subagent-process.ts). Deliberately NOT a stub of the reading under test: the pipes are real
 * `PassThrough` streams and the `exit`/`close` events keep a real child's ordering, so chunk decoding,
 * line splitting across chunk boundaries, backpressure and the exit/pipe-close gap are all exercised for
 * real — only the OS process is missing, which is the one part that cannot be exercised offline.
 */
export class FakeSubagent extends EventEmitter implements SubagentProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every signal `kill()` was asked for, in order — how a test proves an abort actually reached the child. */
  readonly signalsReceived: NodeJS.Signals[] = [];
  /** Signals this child declines to die on, for testing what happens when asking politely is not enough. */
  readonly #ignores: readonly NodeJS.Signals[];
  #exited = false;

  constructor(options: { ignores?: readonly NodeJS.Signals[] } = {}) {
    super();
    this.#ignores = options.ignores ?? [];
  }

  /** A signalled child dies: its pipes close and it reports no exit code, because a signal ended it. */
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalsReceived.push(signal);
    if (this.#ignores.includes(signal)) return true; // trapped or wedged — still running
    void this.exit(null);
    return true;
  }

  /** Emit one stdout chunk, exactly as one `data` event — so a test can straddle a line across chunks. */
  write(chunk: string): void {
    this.stdout.write(chunk);
  }

  /**
   * Emit many stdout chunks, waiting for backpressure between them.
   *
   * A real child blocked on a full pipe cannot run ahead of its reader, and neither may this: writing a
   * long stream without pausing would park it all in the fake's own buffer, which is precisely the cost
   * the memory test is trying to observe on the reader.
   */
  async stream(chunks: Iterable<string>): Promise<void> {
    for (const chunk of chunks) {
      if (!this.stdout.write(chunk)) await once(this.stdout, "drain");
    }
  }

  writeStderr(chunk: string): void {
    this.stderr.write(chunk);
  }

  /**
   * End: `exit` as the process goes, then `close` once both pipes have drained — the order, and the gap
   * between the two events, that a real child guarantees.
   */
  async exit(code: number | null): Promise<void> {
    if (this.#exited) return;
    this.#exited = true;
    this.emit("exit", code);
    this.stdout.end();
    this.stderr.end();
    await Promise.all([once(this.stdout, "end"), once(this.stderr, "end")]);
    this.emit("close", code);
  }

  /**
   * Exit while something else keeps a pipe open — a subagent that daemonized a descendant off its own
   * stdout. `close` never comes, because the handle outlives the process that owned it.
   */
  exitLeakingStdout(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.stderr.end();
    this.emit("exit", code);
  }
}

/** One spawn the bridge asked for: what it was going to run, and the child it got back. */
export interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly child: FakeSubagent;
}

/**
 * A `SubagentSpawner` that records every spawn and hands each child to `run` to be driven.
 *
 * `run` is deferred by a microtask so the bridge has attached its listeners first, as it would against a
 * real process (which cannot produce output in the same synchronous tick as its own spawn).
 */
export function fakeSubagentSpawner(
  run: (child: FakeSubagent, call: SpawnRecord) => void | Promise<void> = () => {},
  options: { ignores?: readonly NodeJS.Signals[] } = {},
): { spawn: SubagentSpawner; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  const spawn: SubagentSpawner = (command, args) => {
    const child = new FakeSubagent(options);
    const call: SpawnRecord = { command, args, child };
    calls.push(call);
    queueMicrotask(() => void run(child, call));
    return child;
  };
  return { spawn, calls };
}

/** The common case: a child that prints `stdout` (and optionally `stderr`), then exits with `code`. */
export function scriptedSubagent(stdout: string, options: { stderr?: string; code?: number } = {}): { spawn: SubagentSpawner; calls: SpawnRecord[] } {
  return fakeSubagentSpawner((child) => {
    if (stdout) child.write(stdout);
    if (options.stderr) child.writeStderr(options.stderr);
    void child.exit(options.code ?? 0);
  });
}

/** One `message_end` NDJSON line, shaped exactly like PI's own `--mode json` stdout. */
export function assistantLine(text: string, totalTokens: number): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { totalTokens } } });
}
