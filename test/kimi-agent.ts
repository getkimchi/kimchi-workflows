import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentRequest, AgentSession, AgentTurn } from "../src/engine/types.ts";

/**
 * Shared helpers for the gated integration tests: resolve the kimchi API key and build a real
 * `startAgent` backed by the kimchi OpenAI-compatible gateway (one call per turn). Not a `.test.ts`
 * file, so vitest does not collect it as a test.
 */
const KIMI_CHAT_URL = "https://llm.kimchi.dev/openai/v1/chat/completions";

/** Resolve KIMCHI_API_KEY from the environment or `../kimchi-dev/.env`; undefined when unavailable. */
export function resolveKimiApiKey(): string | undefined {
  if (process.env.KIMCHI_API_KEY) return process.env.KIMCHI_API_KEY;
  try {
    const envPath = path.resolve(import.meta.dirname, "../../kimchi-dev/.env");
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && match[1] === "KIMCHI_API_KEY") {
        return match[2]?.replace(/^["']|["']$/g, "").trim();
      }
    }
  } catch {
    // .env not readable — treated as "no key"; callers self-skip.
  }
  return undefined;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * A `startAgent` backed by real kimi chat completions. The gateway is stateless, so each turn sends
 * the FULL accumulated conversation (seeded with `history` on a resumed session) — this is what lets
 * a parked Q&A step's answer turn carry the prior question's context (spec §8.4).
 */
export function createKimiAgentStarter(apiKey: string): (request: AgentRequest) => AgentSession {
  return (request) => {
    const modelId = toModelId(request.model);
    const conversation: ChatMessage[] = [...((request.history ?? []) as readonly ChatMessage[])];
    return {
      async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
        conversation.push({ role: "user", content: message });
        const { text, totalTokens } = await callKimiChat(apiKey, modelId, conversation);
        conversation.push({ role: "assistant", content: text });
        return { text, usage: totalTokens === undefined ? undefined : { totalTokens } };
      },
      getConversation() {
        return conversation;
      },
      dispose() {
        /* no persistent resources */
      },
    };
  };
}

/** One-shot single-user-message call returning just the text (used by the steering integration test). */
export async function callKimi(apiKey: string, modelId: string, message: string): Promise<string> {
  return (await callKimiChat(apiKey, modelId, [{ role: "user", content: message }])).text;
}

export async function callKimiChat(apiKey: string, modelId: string, messages: readonly ChatMessage[]): Promise<{ text: string; totalTokens?: number }> {
  const response = await fetch(KIMI_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages, temperature: 0 }),
  });
  if (!response.ok) {
    throw new Error(`kimi gateway HTTP ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
  return { text: data.choices?.[0]?.message?.content ?? "", totalTokens: data.usage?.total_tokens };
}

export function toModelId(model: string | undefined): string {
  if (!model) return "kimi-k2.7";
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}
