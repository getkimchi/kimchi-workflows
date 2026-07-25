import { describe, expect, it } from "vitest";
import { type AgentMessages, lastAssistantText, lastAssistantUsage, type ModelRegistry, parseNdjsonMessages, resolveModel } from "../src/host/pi-agent-messages.ts";

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

// -- parseNdjsonMessages (background subagent stdout, spec §2.2) -----------------------------------
//
// Fixture lines shaped exactly like PI's own `--mode json` output (the same `message_end` envelope
// PI's bundled examples/extensions/subagent/index.ts parses off a spawned `pi` process's stdout).

const messageEndLine = (message: object) => JSON.stringify({ type: "message_end", message });
const assistantLine = (text: string, totalTokens: number) => messageEndLine({ role: "assistant", content: [{ type: "text", text }], usage: { totalTokens } });

describe("parseNdjsonMessages", () => {
  it("extracts the message from each message_end line, in order", () => {
    const ndjson = [assistantLine("first", 3), assistantLine("second", 7)].join("\n");

    const messages = parseNdjsonMessages(ndjson);

    expect(lastAssistantText(messages)).toBe("second");
    expect(lastAssistantUsage(messages)).toEqual({ totalTokens: 7 });
  });

  it("ignores non-message_end event types interleaved in the stream", () => {
    const ndjson = [JSON.stringify({ type: "turn_start" }), JSON.stringify({ type: "tool_call", id: "1" }), assistantLine("done", 4), JSON.stringify({ type: "turn_end" })].join(
      "\n",
    );

    expect(lastAssistantText(parseNdjsonMessages(ndjson))).toBe("done");
  });

  it("skips blank lines and lines that are not valid JSON, rather than failing the whole parse", () => {
    const ndjson = ["", "   ", "not json at all {", assistantLine("ok", 1), ""].join("\n");

    expect(lastAssistantText(parseNdjsonMessages(ndjson))).toBe("ok");
  });

  it("skips a JSON line with no message_end shape (missing type, missing message, or a different type)", () => {
    const ndjson = [JSON.stringify({ hello: "world" }), JSON.stringify({ type: "message_end" }), JSON.stringify(null), assistantLine("survives", 2)].join("\n");

    expect(lastAssistantText(parseNdjsonMessages(ndjson))).toBe("survives");
  });

  it("returns an empty message list for empty stdout", () => {
    expect(parseNdjsonMessages("")).toEqual([]);
  });
});
