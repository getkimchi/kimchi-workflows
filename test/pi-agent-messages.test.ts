import { describe, expect, it } from "vitest";
import { type AgentMessages, lastAssistantText, lastAssistantUsage, type ModelRegistry, resolveModel } from "../src/host/pi-agent-messages.ts";

// The real PI `AgentMessage` / `Model` types carry many fields these pure readers never touch. We feed
// them minimal fixtures via one localized assertion each (no `any`); the readers only read the fields
// asserted below.
const asMessages = (items: readonly object[]): AgentMessages => items as unknown as AgentMessages;
type FoundModel = ReturnType<ModelRegistry["find"]>;

// -- resolveModel (fake ModelRegistry) --------------------------------------------------------------

describe("resolveModel", () => {
  const hit = { id: "kimchi-dev/kimi-k2.7" } as unknown as FoundModel;
  function fakeRegistry() {
    const calls: [string, string][] = [];
    const find = (provider: string, modelId: string): FoundModel => {
      calls.push([provider, modelId]);
      return provider === "kimchi-dev" && modelId === "kimi-k2.7" ? hit : undefined;
    };
    return { calls, find };
  }

  it("splits provider/modelId and returns the registry hit", () => {
    const registry = fakeRegistry();
    expect(resolveModel(registry, "kimchi-dev/kimi-k2.7")).toBe(hit);
    expect(registry.calls).toEqual([["kimchi-dev", "kimi-k2.7"]]);
  });

  it("returns undefined for an unresolvable model (registry miss)", () => {
    const registry = fakeRegistry();
    expect(resolveModel(registry, "kimchi-dev/nope")).toBeUndefined();
  });

  it("returns undefined without querying the registry when there is no slash", () => {
    const registry = fakeRegistry();
    expect(resolveModel(registry, "kimi-k2.7")).toBeUndefined();
    expect(registry.calls).toEqual([]);
  });
});

// -- lastAssistantText ------------------------------------------------------------------------------

describe("lastAssistantText", () => {
  it("returns empty string when there is no assistant message", () => {
    expect(lastAssistantText(asMessages([]))).toBe("");
    expect(lastAssistantText(asMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }]))).toBe("");
  });

  it("concatenates multi-part text content, ignoring non-text parts", () => {
    const messages = asMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "tool_use", id: "1" },
          { type: "text", text: "world" },
        ],
        usage: { totalTokens: 5 },
      },
    ]);
    expect(lastAssistantText(messages)).toBe("Hello world");
  });

  it("picks the LAST assistant message among mixed roles", () => {
    const messages = asMessages([
      { role: "assistant", content: [{ type: "text", text: "first" }], usage: { totalTokens: 1 } },
      { role: "user", content: [{ type: "text", text: "middle" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }], usage: { totalTokens: 2 } },
    ]);
    expect(lastAssistantText(messages)).toBe("second");
  });
});

// -- lastAssistantUsage -----------------------------------------------------------------------------

describe("lastAssistantUsage", () => {
  it("returns the last assistant message's totalTokens when present", () => {
    const messages = asMessages([
      { role: "assistant", content: [{ type: "text", text: "a" }], usage: { totalTokens: 10 } },
      { role: "assistant", content: [{ type: "text", text: "b" }], usage: { totalTokens: 42 } },
    ]);
    expect(lastAssistantUsage(messages)).toEqual({ totalTokens: 42 });
  });

  it("returns undefined when there is no assistant message", () => {
    expect(lastAssistantUsage(asMessages([]))).toBeUndefined();
    expect(lastAssistantUsage(asMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }]))).toBeUndefined();
  });
});
