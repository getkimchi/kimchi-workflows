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
 *
 * `background` requests (spec §2.2/§9.2, P4 step-0 finding): `ExtensionAPI` — this file's entire PI
 * surface — exposes no subagent-run primitive. There is no `runAgent`/`spawnAgent`/anything that opens
 * an isolated agent conversation and hands back a session; the full method list is `on`, tool/command/
 * shortcut/flag registration, `sendMessage`/`sendUserMessage` (both act on the ONE shared interactive
 * session), `exec` (a generic "run a shell command to completion" helper), and provider/model
 * management. The one REAL mechanism PI gives an extension for isolation is shelling out to a SECOND
 * `pi` CLI process — exactly what PI's own bundled `examples/extensions/subagent/index.ts` does, via
 * `pi --mode json -p --no-session [--model ...] "<prompt>"`, parsing the NDJSON `message_end` events
 * for the final assistant message (see also its `docs/extensions.md` catalog entry: "Spawn sub-agents
 * | registerTool, exec"). That subprocess exits after one reply, so it is inherently one-shot, not
 * resumable — which is exactly why step-runner.ts never steers a `background` step and instead lets
 * invalid output fall back to the repeat policy (spec §9.2).
 *
 * That subprocess wiring is NOT implemented below: it would duplicate ~200 lines of untested,
 * unverifiable-offline process-spawn/NDJSON-parsing logic (no model/API access in this environment to
 * exercise it against a real `pi` binary), which is a worse failure mode than saying so plainly. This
 * throws loudly instead — naming exactly what is missing — rather than either (a) silently running the
 * step inside the shared interactive session (which would violate the isolation `background` promises:
 * shared history, shared tool config, shared transcript) or (b) returning a session object that quietly
 * pretends to work. Wiring it for real is future work: spawn `pi --mode json -p --no-session` (or
 * shell it via `pi.exec`) per background request, reusing `lastAssistantText`/`lastAssistantUsage`
 * below to parse the child's final `message_end` the same way the interactive path already does.
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

  return (modelRegistry) => (request) => {
    if (request.background) {
      throw new Error(
        `agent step "${request.stepName}" declares background: true, but this PI host has no subagent execution wired ` +
          "(PI's ExtensionAPI exposes no subagent-run primitive — only a real subprocess-spawn implementation, following " +
          "PI's own examples/extensions/subagent pattern, would satisfy it; see the comment atop src/host/pi-agent.ts)",
      );
    }
    return {
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
    };
  };
}
