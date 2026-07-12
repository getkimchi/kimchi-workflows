/**
 * Pure message/model helpers for the PI agent bridge (spec §2.2), split out from `pi-agent.ts` so they
 * are unit-testable offline. Every PI reference here is *type-only* (erased at runtime), so importing
 * this module pulls no PI/host/network code.
 */
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TokenUsage } from "../engine/types.ts";

/** The PI model registry (from the extension context) — referenced structurally for `find`. */
export type ModelRegistry = ExtensionContext["modelRegistry"];
/** The assistant/user message list carried by an `agent_end` event. */
export type AgentMessages = AgentEndEvent["messages"];

/** Resolve a `provider/modelId` string to a registry model; undefined if there is no slash or no hit. */
export function resolveModel(modelRegistry: Pick<ModelRegistry, "find">, modelString: string): ReturnType<ModelRegistry["find"]> {
  const slash = modelString.indexOf("/");
  if (slash === -1) return undefined;
  return modelRegistry.find(modelString.slice(0, slash), modelString.slice(slash + 1));
}

/** The last assistant message's concatenated text content (`""` when there is no assistant message). */
export function lastAssistantText(messages: AgentMessages): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && "role" in message && message.role === "assistant") {
      let text = "";
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
      }
      return text;
    }
  }
  return "";
}

/** The last assistant message's token usage (chat-completions `usage.totalTokens`), for token budgeting (spec §9.3). */
export function lastAssistantUsage(messages: AgentMessages): TokenUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && "role" in message && message.role === "assistant") {
      return { totalTokens: message.usage.totalTokens };
    }
  }
  return undefined;
}
