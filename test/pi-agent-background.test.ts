import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiAgentBridge, resolvePiInvocation } from "../src/host/pi-agent.ts";
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts";
import { type SubagentSpawner, subagentSpawner } from "../src/host/subagent-process.ts";
import { assistantLine, fakeSubagentSpawner, scriptedSubagent } from "./fake-subagent.ts";

/**
 * A background subagent (spec §2.2) spawns a second `pi`-family process — the one real isolation
 * mechanism `ExtensionAPI` offers an extension (see the header comment in src/host/pi-agent.ts). No `pi`
 * binary exists to run offline, so these drive an injected spawner whose children are real streams
 * (test/fake-subagent.ts): the invocation resolver, the args built for it, model resolution/rejection,
 * reading the final assistant turn off a chunked stdout, the bounded stderr tail, abort killing the
 * child, and the exit-code error. What only a real process can settle is covered further down, against
 * `/bin/sh`. Tests inject a FIXED resolver (`command: "pi"`, args passed through unchanged) so assertions
 * stay independent of the live test runner's own `process.argv`/`execPath`; the resolver's own
 * live-process logic is covered separately below.
 */
const fixedResolver = (args: readonly string[]) => ({ command: "pi", args });

/** The bridge's background path needs nothing from PI itself — no listener it registers, no call it makes. */
const noopPi = { on: () => {} } as unknown as ExtensionAPI;

function fakeModelRegistry(hit?: { id: string }): ModelRegistry {
  return { find: (provider: string, modelId: string) => (hit && `${provider}/${modelId}` === hit.id ? hit : undefined) } as unknown as ModelRegistry;
}

describe("createPiAgentBridge background requests (spec §2.2): a real subprocess, not a throw", () => {
  it("spawns `pi --mode json -p --session <trace> <prompt>` and returns the final assistant message + usage", async () => {
    const { spawn, calls } = scriptedSubagent([assistantLine("hello", 5), ""].join("\n"));
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    const session = startAgent({ stepName: "bg", background: true });
    const turn = await session.sendAndAwaitEnd("do the task");

    expect(turn).toEqual({ text: "hello", usage: { totalTokens: 5 } });
    expect(calls[0]?.command).toBe("pi");
    // The step is not resumable, so its session is a fresh file under traces/ that nothing reads back —
    // it starts cold as before, but what it spent is now recoverable afterwards.
    const args = calls[0]?.args ?? [];
    expect(args.slice(0, 3)).toEqual(["--mode", "json", "-p"]);
    expect(args[3]).toBe("--session");
    expect(args[4]).toMatch(/traces[/\\]bg-.*\.jsonl$/);
    expect(args.at(-1)).toBe("do the task");
    expect(args).not.toContain("--no-session");
  });

  it("passes a resolved --model before the prompt", async () => {
    const { spawn, calls } = scriptedSubagent(assistantLine("ok", 1));
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry({ id: "kimchi-dev/kimi-k2.7" }));

    await startAgent({ stepName: "bg", background: true, model: "kimchi-dev/kimi-k2.7" }).sendAndAwaitEnd("go");

    const args = calls[0]?.args ?? [];
    expect(args.slice(-3)).toEqual(["--model", "kimchi-dev/kimi-k2.7", "go"]);
    expect(args[3]).toBe("--session");
  });

  it("rejects an unresolvable model before spawning anything", async () => {
    const { spawn, calls } = scriptedSubagent("");
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true, model: "nope/nope" }).sendAndAwaitEnd("go")).rejects.toThrow(/unknown model "nope\/nope"/);
    expect(calls).toEqual([]); // never spawned
  });

  it("throws naming the exit code and stderr when the subprocess fails", async () => {
    const { spawn } = scriptedSubagent("", { stderr: "boom", code: 1 });
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go")).rejects.toThrow(/exited with code 1.*boom/s);
  });

  it("getConversation() is always empty — a background step is one-shot and never resumed with history", async () => {
    const { spawn } = scriptedSubagent(assistantLine("hi", 1));
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());
    const session = startAgent({ stepName: "bg", background: true });

    await session.sendAndAwaitEnd("go");

    expect(session.getConversation()).toEqual([]);
  });

  it("does not throw for an ordinary (non-background) request", () => {
    const { spawn } = scriptedSubagent("");
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    expect(() => startAgent({ stepName: "fg" })).not.toThrow();
  });

  it("reads the last assistant turn out of a stdout split at arbitrary chunk boundaries", async () => {
    // A pipe hands over whatever happened to be in the buffer, not whole lines: the final message here
    // arrives in three pieces, one of them straddling the newline before it.
    const ndjson = [assistantLine("earlier", 1), assistantLine("final answer", 42)].join("\n");
    const cut = ndjson.length - 20;
    const { spawn } = fakeSubagentSpawner((child) => {
      child.write(ndjson.slice(0, 30));
      child.write(ndjson.slice(30, cut));
      child.write(ndjson.slice(cut));
      void child.exit(0);
    });
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go")).resolves.toEqual({ text: "final answer", usage: { totalTokens: 42 } });
  });

  it("completes when the subagent exits but a descendant it left behind still holds stdout open", async () => {
    // `pi.exec` had to solve this too (its `waitForChildProcess`, upstream issue #5303): a worker that
    // starts a dev server hands that server its stdout handle, so the pipe never closes even though the
    // subagent itself is gone. Waiting on `close` alone would hang the step — and with no time budget
    // declared, the whole run — on a subagent that in fact answered.
    const { spawn } = fakeSubagentSpawner((child) => {
      child.write(`${assistantLine("server started, here is the answer", 8)}\n`);
      child.exitLeakingStdout(0);
    });
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go")).resolves.toEqual({
      text: "server started, here is the answer",
      usage: { totalTokens: 8 },
    });
  });

  it("keeps reading a child that is still writing after it exited, rather than truncating its reply", async () => {
    // The other half of the same problem: give up on a fixed deadline from `exit` and the tail — which is
    // where the final assistant message lives — is silently lost.
    const ndjson = `${assistantLine("the last word", 12)}\n`;
    const { spawn } = fakeSubagentSpawner((child) => {
      child.write(`${assistantLine("not the answer", 1)}\n`);
      child.exitLeakingStdout(0);
      // Dribbled out across several idle-grace windows, long after the process itself reported exiting.
      let at = 0;
      const tick = setInterval(() => {
        child.write(ndjson.slice(at, at + 16));
        at += 16;
        if (at >= ndjson.length) clearInterval(tick);
      }, 25);
    });
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go")).resolves.toEqual({ text: "the last word", usage: { totalTokens: 12 } });
  });

  // Spec §8.8/§9.4: the child must be killable. Without this the engine's cancel and wall-time budget
  // both become claims about a process they cannot reach — and with no budget declared (the default) an
  // unresponsive subagent would hang the run outright. `pi.exec`'s `signal` option used to own this;
  // spawning directly means owning it here, so it is asserted on the child rather than on a passed-along
  // option nobody can see act.
  it("kills the spawned child when the attempt's signal aborts, and fails rather than reporting success", async () => {
    const controller = new AbortController();
    const { spawn, calls } = fakeSubagentSpawner((child) => {
      child.write(assistantLine("partial work", 3)); // the child was mid-run when the run was cancelled
      controller.abort();
    });
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true, signal: controller.signal }).sendAndAwaitEnd("go")).rejects.toThrow(/aborted/);
    expect(calls[0]?.child.signalsReceived).toEqual(["SIGTERM"]); // the process itself was told to stop
  });

  it("kills a child spawned under an already-aborted signal, leaving nothing running behind it", async () => {
    const controller = new AbortController();
    controller.abort();
    const { spawn, calls } = fakeSubagentSpawner(); // a child that would otherwise never say anything

    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true, signal: controller.signal }).sendAndAwaitEnd("go")).rejects.toThrow(/aborted/);
    expect(calls[0]?.child.signalsReceived).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when a child does not die on SIGTERM, so a cancel cannot leave one running", async () => {
    // Only the timers are faked — the streams' own nextTick/setImmediate machinery stays real, so the
    // child still closes and settles the turn exactly as it would in wall-clock time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const controller = new AbortController();
      controller.abort();
      const { spawn, calls } = fakeSubagentSpawner(() => {}, { ignores: ["SIGTERM"] }); // wedged or trapping the signal
      const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

      const turn = startAgent({ stepName: "bg", background: true, signal: controller.signal }).sendAndAwaitEnd("go");
      const settled = turn.then(() => new Error("test bug: an aborted turn must not resolve")).catch((err: Error) => err);
      expect(calls[0]?.child.signalsReceived).toEqual(["SIGTERM"]); // asked nicely, ignored

      vi.advanceTimersByTime(5000);

      expect(calls[0]?.child.signalsReceived).toEqual(["SIGTERM", "SIGKILL"]);
      expect((await settled).message).toMatch(/aborted/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the tail of a failing subagent's stderr, which is the part that explains the failure", async () => {
    // 4MB of noise ahead of the one line worth reading: kept whole this is the same unbounded buffer the
    // stdout fix removed, and it would be paid for on every failure.
    const { spawn } = fakeSubagentSpawner((child) => {
      for (let i = 0; i < 64; i++) child.writeStderr(`${"noise ".repeat(10_000)}${i}\n`);
      child.writeStderr("Error: no API key available for kimchi-dev/kimi-k2.7\n");
      void child.exit(2);
    });
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    const error = await startAgent({ stepName: "bg", background: true })
      .sendAndAwaitEnd("go")
      .then(() => new Error("test bug: the subagent exited 2 and should have thrown"))
      .catch((err: Error) => err);

    expect(error.message).toContain("exited with code 2");
    expect(error.message).toContain("Error: no API key available for kimchi-dev/kimi-k2.7"); // the tail survives
    expect(error.message.length).toBeLessThan(16 * 1024); // ...and the 4MB ahead of it did not
  });
});

/**
 * The property the streaming rewrite exists for: what this process retains must track the ONE message a
 * background step reads, not how much its subagent said. Buffering the stream (`pi.exec`) cost a byte of
 * live heap per byte the child printed; parsing it whole cost an order of magnitude more, and took a
 * container down (324MB -> 1.91GB while reading 367KB).
 *
 * Measured with a forced full GC on either side, so what is asserted is what is still LIVE after the turn
 * resolves, not transient garbage the collector had not gotten to.
 */
describe("a long-running subagent costs the parent a bounded amount of memory", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  setFlagsFromString("--no-expose-gc");

  it("does not accumulate the child's stdout, however much of it there is", async () => {
    const noise = (i: number) => JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: `${i} ${"abcdefgh".repeat(1024)}${i}` }] } });
    const messages = 4500;
    const streamedBytes = messages * (noise(0).length + 1);
    function* transcript(): Generator<string> {
      // Generated lazily and never collected, so the only thing that can be holding the stream is the
      // code under test.
      for (let i = 0; i < messages; i++) yield `${noise(i)}\n`;
      yield `${assistantLine("done", 11)}\n`;
    }
    const { spawn } = fakeSubagentSpawner(async (child) => {
      await child.stream(transcript());
      await child.exit(0);
    });
    const startAgent = createPiAgentBridge(noopPi, fixedResolver, spawn)(fakeModelRegistry());

    gc();
    const before = process.memoryUsage().heapUsed;
    const turn = await startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go");
    gc();
    const retained = process.memoryUsage().heapUsed - before;

    expect(turn).toEqual({ text: "done", usage: { totalTokens: 11 } });
    expect(streamedBytes).toBeGreaterThan(32 * 1024 * 1024); // the child really did print ~32MB
    // Holding the stream (or the messages parsed out of it) would show up as ~32MB or more still live.
    // What is actually kept is the final turn plus a partial line — this bound is orders below either.
    expect(retained).toBeLessThan(4 * 1024 * 1024);
  });
});

/**
 * Three things the scripted child above CANNOT prove, because they are properties of a real OS process
 * rather than of our reading of one: that `subagentSpawner`'s `kill` reaches a live process and leaves no
 * orphan, that an inherited pipe held open by a descendant releases us anyway, and that a spawn which
 * never starts a process is reported rather than awaited forever. `pi.exec` used to own all three.
 *
 * `/bin/sh` stands in for `pi` — a real binary, no network, no model — so these are POSIX-only; the
 * bridge logic they exercise is platform-independent and covered by the fake above everywhere.
 */
describe.skipIf(process.platform === "win32")("against a real OS process", () => {
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** A bridge whose subagent is a shell script, plus the pid it actually spawned. */
  function shellBridge(script: string) {
    let pid = 0;
    const spawner: SubagentSpawner = (command, args) => {
      const child = subagentSpawner(command, args);
      pid = (child as unknown as { pid: number }).pid;
      return child;
    };
    const startAgent = createPiAgentBridge(noopPi, () => ({ command: "/bin/sh", args: ["-c", script] }), spawner)(fakeModelRegistry());
    return { startAgent, pid: () => pid };
  }

  it("kills the process on abort and leaves no orphan behind", async () => {
    const controller = new AbortController();
    const { startAgent, pid } = shellBridge("echo started; exec sleep 300");

    const settled = startAgent({ stepName: "bg", background: true, signal: controller.signal })
      .sendAndAwaitEnd("go")
      .then(() => new Error("test bug: an aborted turn must not resolve"))
      .catch((err: Error) => err);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(pid())).toBe(true); // it really is running

    controller.abort();
    expect((await settled).message).toMatch(/aborted/);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(pid())).toBe(false); // ...and it really is gone
  }, 20_000);

  it("returns as soon as the subagent is done, even with a descendant still holding its stdout", async () => {
    // `sleep 3 &` inherits stdout and outlives the shell, so the pipe stays open for three seconds after
    // the subagent itself exited. Waiting on `close` alone would wait all three.
    const { startAgent } = shellBridge(`printf '%s\\n' '${assistantLine("answered", 4)}'; sleep 3 & exit 0`);

    const began = Date.now();
    await expect(startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go")).resolves.toEqual({ text: "answered", usage: { totalTokens: 4 } });
    expect(Date.now() - began).toBeLessThan(2000);
  }, 20_000);

  it("reports a spawn that never produced a process, rather than waiting on one", async () => {
    const startAgent = createPiAgentBridge(noopPi, () => ({ command: "/definitely/not/a/binary", args: [] }))(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go")).rejects.toThrow(/ENOENT/);
  }, 20_000);
});

/**
 * `resolvePiInvocation`'s three cases (spec §2.2, live-verified in the P7 harness pass — see
 * src/host/pi-agent.ts's header comment): respawn a dev-mode script under its own interpreter, respawn
 * a compiled single-file binary directly, or fall back to literal `"pi"`. Drives the real `process`
 * globals (save/restore around each case) rather than injecting a seam, since `process.argv`/`execPath`
 * ARE the inputs this function reads.
 */
describe("resolvePiInvocation: which binary a background subagent respawns", () => {
  const originalArgv = [...process.argv];
  const originalExecPath = process.execPath;
  afterEach(() => {
    process.argv = [...originalArgv];
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true, writable: true });
  });

  it("respawns [execPath, script, ...args] when argv[1] is a real file on disk (node/bun dev invocation)", () => {
    process.argv[1] = import.meta.filename;
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true, writable: true });

    expect(resolvePiInvocation(["--mode", "json"])).toEqual({ command: "/usr/bin/node", args: [import.meta.filename, "--mode", "json"] });
  });

  it("respawns execPath directly when it names a compiled single-file binary (not node/bun)", () => {
    process.argv[1] = "/no/such/file.ts";
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/kimchi", configurable: true, writable: true });

    expect(resolvePiInvocation(["--mode", "json"])).toEqual({ command: "/usr/local/bin/kimchi", args: ["--mode", "json"] });
  });

  it('falls back to literal "pi" when argv[1] is missing and execPath is a generic runtime', () => {
    process.argv[1] = "/no/such/file.ts";
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true, writable: true });

    expect(resolvePiInvocation(["--mode", "json"])).toEqual({ command: "pi", args: ["--mode", "json"] });
  });
});
