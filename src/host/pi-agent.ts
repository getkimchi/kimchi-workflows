/**
 * Real PI-harness implementation of the engine's agent seam (`HostPort.startAgent`, spec §2.2).
 *
 * A session: resolve + `setModel(model)`, `sendUserMessage(prompt)`, await the `agent_end` event,
 * and return the last assistant message's text. Compiles against the real
 * `@earendil-works/pi-coding-agent` types (`AgentEndEvent = { messages }`).
 *
 * A single `agent_end` listener is registered per bridge (the extension holds one bridge for its
 * lifetime); since the blocking guard (spec §7) runs one step at a time, a single pending resolver
 * is unambiguous. `pi.on` exposes no unsubscribe, so `dispose()` clears the pending resolver rather
 * than removing the listener.
 *
 * `getConversation()` returns the last `agent_end` messages so a blocked Q&A step can be resumed
 * (spec §8.4). Cross-process history replay (seeding a fresh PI session from a stored conversation)
 * is a real-harness concern deferred to 6b — the deterministic proof of the mechanism is offline.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRequest, AgentSession, AgentTurn, ConversationMessage } from "../engine/types.ts";
import { type AgentMessages, lastAssistantText, lastAssistantUsage, type ModelRegistry, resolveModel } from "./pi-agent-messages.ts";

export type AgentStarter = (request: AgentRequest) => AgentSession;

/**
 * Create the PI agent bridge. Call once per extension instance (registers one `agent_end` listener),
 * then obtain a per-run `AgentStarter` bound to the command's model registry.
 */
export function createPiAgentBridge(pi: ExtensionAPI): (modelRegistry: ModelRegistry) => AgentStarter {
  let pending: ((turn: AgentTurn) => void) | undefined;
  let lastConversation: AgentMessages = [];

  pi.on("agent_end", (event) => {
    lastConversation = event.messages;
    const resolve = pending;
    if (!resolve) return;
    pending = undefined;
    resolve({ text: lastAssistantText(event.messages), usage: lastAssistantUsage(event.messages) });
  });

  return (modelRegistry) => (request) => ({
    async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
      if (request.model) {
        const model = resolveModel(modelRegistry, request.model);
        if (!model) {
          throw new Error(`unknown model "${request.model}" (expected provider/modelId)`);
        }
        const ok = await pi.setModel(model);
        if (!ok) {
          throw new Error(`no API key available for model "${request.model}"`);
        }
      }
      return new Promise<AgentTurn>((resolve) => {
        pending = resolve;
        pi.sendUserMessage(message);
      });
    },
    getConversation(): readonly ConversationMessage[] {
      return lastConversation;
    },
    dispose(): void {
      pending = undefined;
    },
  });
}
