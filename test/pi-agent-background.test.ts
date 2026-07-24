import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPiAgentBridge } from "../src/host/pi-agent.ts";
import type { ModelRegistry } from "../src/host/pi-agent-messages.ts";

/** The bridge only calls `pi.on("agent_end", ...)` at construction time; nothing else is exercised here. */
function fakePi(): ExtensionAPI {
  return { on: () => {} } as unknown as ExtensionAPI;
}

function fakeModelRegistry(): ModelRegistry {
  return { find: () => undefined } as unknown as ModelRegistry;
}

describe("createPiAgentBridge background requests (spec §2.2 — P4 step-0 finding: no PI subagent primitive)", () => {
  it("throws naming exactly what is missing, rather than silently running the step in the shared interactive session", () => {
    const startAgent = createPiAgentBridge(fakePi())(fakeModelRegistry());

    expect(() => startAgent({ stepName: "bg", background: true })).toThrow(/subagent execution wired/);
  });

  it("does not throw for an ordinary (non-background) request", () => {
    const startAgent = createPiAgentBridge(fakePi())(fakeModelRegistry());

    expect(() => startAgent({ stepName: "fg" })).not.toThrow();
  });
});
