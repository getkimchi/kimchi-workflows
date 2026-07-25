import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPiAgentBridge } from "../src/host/pi-agent.ts";
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts";

/**
 * A background subagent (spec §2.2) spawns a second `pi --mode json -p --no-session` process via
 * `pi.exec` — the one real isolation mechanism `ExtensionAPI` offers an extension (see the header
 * comment in src/host/pi-agent.ts). `pi.exec`'s own subprocess machinery is PI's, not ours, and cannot
 * be exercised without a real `pi` binary; what IS ours, and IS tested here, is: the args built for it,
 * model resolution/rejection, and parsing its NDJSON stdout into the final assistant turn — all driven
 * through a scripted fake of the `exec`/`on` surface, never a real process.
 */

interface FakeExecCall {
  readonly command: string;
  readonly args: readonly string[];
}

function fakePi(execImpl: (call: FakeExecCall) => ExecResult): { pi: ExtensionAPI; calls: FakeExecCall[] } {
  const calls: FakeExecCall[] = [];
  const pi = {
    on: () => {},
    exec: async (command: string, args: string[]) => {
      const call = { command, args };
      calls.push(call);
      return execImpl(call);
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

function fakeModelRegistry(hit?: { id: string }): ModelRegistry {
  return { find: (provider: string, modelId: string) => (hit && `${provider}/${modelId}` === hit.id ? hit : undefined) } as unknown as ModelRegistry;
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

const ASSISTANT_LINE = (text: string, totalTokens: number) =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { totalTokens } } });

describe("createPiAgentBridge background requests (spec §2.2): a real subprocess, not a throw", () => {
  it("spawns `pi --mode json -p --no-session <prompt>` and returns the final assistant message + usage", async () => {
    const { pi, calls } = fakePi(() => ok([ASSISTANT_LINE("hello", 5), ""].join("\n")));
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());

    const session = startAgent({ stepName: "bg", background: true });
    const turn = await session.sendAndAwaitEnd("do the task");

    expect(turn).toEqual({ text: "hello", usage: { totalTokens: 5 } });
    expect(calls).toEqual([{ command: "pi", args: ["--mode", "json", "-p", "--no-session", "do the task"] }]);
  });

  it("passes a resolved --model before the prompt", async () => {
    const { pi, calls } = fakePi(() => ok(ASSISTANT_LINE("ok", 1)));
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry({ id: "kimchi-dev/kimi-k2.7" }));

    await startAgent({ stepName: "bg", background: true, model: "kimchi-dev/kimi-k2.7" }).sendAndAwaitEnd("go");

    expect(calls[0]?.args).toEqual(["--mode", "json", "-p", "--no-session", "--model", "kimchi-dev/kimi-k2.7", "go"]);
  });

  it("rejects an unresolvable model before spawning anything", async () => {
    const { pi, calls } = fakePi(() => ok(""));
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true, model: "nope/nope" }).sendAndAwaitEnd("go")).rejects.toThrow(/unknown model "nope\/nope"/);
    expect(calls).toEqual([]); // never spawned
  });

  it("throws naming the exit code and stderr when the subprocess fails", async () => {
    const { pi } = fakePi(() => ({ stdout: "", stderr: "boom", code: 1, killed: false }));
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());

    await expect(startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go")).rejects.toThrow(/exited with code 1.*boom/s);
  });

  it("getConversation() is always empty — a background step is one-shot and never resumed with history", async () => {
    const { pi } = fakePi(() => ok(ASSISTANT_LINE("hi", 1)));
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());
    const session = startAgent({ stepName: "bg", background: true });

    await session.sendAndAwaitEnd("go");

    expect(session.getConversation()).toEqual([]);
  });

  it("does not throw for an ordinary (non-background) request", () => {
    const { pi } = fakePi(() => ok(""));
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());

    expect(() => startAgent({ stepName: "fg" })).not.toThrow();
  });
});
