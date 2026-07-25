import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPiAgentBridge } from "../src/host/pi-agent.ts";
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts";

/**
 * The bridge's cross-talk safety (spec §2.2), driven directly against a fake PI — no engine, no
 * workflow, just `createPiAgentBridge` and a scriptable `agent_end`/`sendUserMessage`.
 *
 * Before this fix, `createPiAgentBridge` kept ONE shared mutable `pending` resolver: a second
 * `sendAndAwaitEnd` call while a first was still in flight silently OVERWROTE it, so the single
 * `agent_end` that eventually fired resolved whichever caller happened to be `pending` last — the
 * FIRST caller's promise never settled at all (hung forever), and the SECOND caller was handed a reply
 * that was never its own. These tests reconstruct exactly that interleaving and prove the fix: the
 * second attempt is rejected before it can touch anything shared, and the first is completely unaffected.
 */

function fakePi(): { pi: ExtensionAPI; fireAgentEnd: (text: string) => void; sentMessages: string[] } {
  let handler: ((event: AgentEndEvent) => void) | undefined;
  const sentMessages: string[] = [];
  const pi = {
    on: (event: string, h: (event: AgentEndEvent) => void) => {
      if (event === "agent_end") handler = h;
    },
    sendUserMessage: (message: string) => {
      sentMessages.push(message);
    },
    setModel: async () => true,
  } as unknown as ExtensionAPI;

  return {
    pi,
    fireAgentEnd: (text: string) => {
      if (!handler) throw new Error("test bug: no agent_end handler was registered");
      handler({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text }], usage: { totalTokens: 1 } }],
      } as unknown as AgentEndEvent);
    },
    sentMessages,
  };
}

function fakeModelRegistry(): ModelRegistry {
  return { find: () => undefined } as unknown as ModelRegistry;
}

describe("createPiAgentBridge in-session safety (spec §2.2): two concurrent turns can never cross-talk", () => {
  it("a second in-session turn attempted while one is in flight is rejected loudly and specifically, never silently swapped in", async () => {
    const { pi, fireAgentEnd, sentMessages } = fakePi();
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());

    const stepA = startAgent({ stepName: "step-a" });
    const stepB = startAgent({ stepName: "step-b" });

    // Step A starts its in-session turn: goes through to `pi.sendUserMessage`, stays pending.
    const turnA = stepA.sendAndAwaitEnd("prompt from A");

    // Step B attempts a SECOND in-session turn while A's is still in flight — the exact interleaving the
    // old shared `pending` variable could not survive.
    await expect(stepB.sendAndAwaitEnd("prompt from B")).rejects.toThrow(/step "step-b".*step "step-a".*in flight/s);

    // B's message was never sent to PI at all — the rejection happens before any side effect, so PI
    // itself never sees a second concurrent `sendUserMessage`.
    expect(sentMessages).toEqual(["prompt from A"]);

    // A's turn is completely unaffected: firing the ONE real `agent_end` resolves A with A's OWN reply.
    fireAgentEnd("reply for A");
    await expect(turnA).resolves.toEqual({ text: "reply for A", usage: { totalTokens: 1 } });
  });

  it("never resolves one step's turn with another step's reply, regardless of send order", async () => {
    const { pi, fireAgentEnd } = fakePi();
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());

    const stepA = startAgent({ stepName: "step-a" });
    const stepB = startAgent({ stepName: "step-b" });

    const turnA = stepA.sendAndAwaitEnd("prompt from A");
    const rejectedTurnB = stepB.sendAndAwaitEnd("prompt from B").catch((err: Error) => err);

    fireAgentEnd("reply for A");

    const [resolvedA, resultB] = await Promise.all([turnA, rejectedTurnB]);
    expect(resolvedA).toEqual({ text: "reply for A", usage: { totalTokens: 1 } });
    expect(resultB).toBeInstanceOf(Error); // B never got A's reply — it got its own clear rejection instead
  });

  it("after A's turn settles, a fresh in-session turn is accepted normally (the guard is not sticky)", async () => {
    const { pi, fireAgentEnd, sentMessages } = fakePi();
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());

    const stepA = startAgent({ stepName: "step-a" });
    const turnA = stepA.sendAndAwaitEnd("prompt from A");
    fireAgentEnd("reply for A");
    await expect(turnA).resolves.toEqual({ text: "reply for A", usage: { totalTokens: 1 } });

    const stepB = startAgent({ stepName: "step-b" });
    const turnB = stepB.sendAndAwaitEnd("prompt from B");
    fireAgentEnd("reply for B");
    await expect(turnB).resolves.toEqual({ text: "reply for B", usage: { totalTokens: 1 } });

    expect(sentMessages).toEqual(["prompt from A", "prompt from B"]);
  });

  it("dispose() only clears a session's OWN in-flight turn, never a sibling's", async () => {
    const { pi, fireAgentEnd } = fakePi();
    const startAgent = createPiAgentBridge(pi)(fakeModelRegistry());

    const stepA = startAgent({ stepName: "step-a" });
    const stepB = startAgent({ stepName: "step-b" }); // never starts a turn

    const turnA = stepA.sendAndAwaitEnd("prompt from A");
    stepB.dispose(); // must be a no-op w.r.t. A's in-flight turn

    fireAgentEnd("reply for A");
    await expect(turnA).resolves.toEqual({ text: "reply for A", usage: { totalTokens: 1 } });
  });

  it("background and isolated requests never touch the shared in-session guard (both go through the subprocess path)", async () => {
    const { pi, sentMessages } = fakePi();
    const calls: { command: string; args: readonly string[] }[] = [];
    const execPi = {
      ...pi,
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    } as unknown as ExtensionAPI;
    const startAgent = createPiAgentBridge(execPi, (args) => ({ command: "pi", args }))(fakeModelRegistry());

    await startAgent({ stepName: "bg", background: true }).sendAndAwaitEnd("go");
    await startAgent({ stepName: "fan", isolated: true }).sendAndAwaitEnd("go");

    expect(calls).toHaveLength(2); // both routed to the subprocess path
    expect(sentMessages).toEqual([]); // neither ever called `pi.sendUserMessage`
  });
});
