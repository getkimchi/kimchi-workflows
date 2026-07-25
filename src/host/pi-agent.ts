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
 * `background` requests (spec §2.2/§9.2): `ExtensionAPI` exposes no subagent-run primitive of its
 * own — there is no `runAgent`/`spawnAgent`/anything that opens an isolated agent conversation and
 * hands back a session. The one REAL mechanism PI gives an extension for isolation is shelling out to
 * a SECOND `pi` CLI process — exactly what PI's own bundled `examples/extensions/subagent/index.ts`
 * does, via `pi --mode json -p --no-session [--model ...] "<prompt>"`, parsing the NDJSON
 * `message_end` events for the final assistant message. That subprocess exits after one reply, so it
 * is inherently one-shot, not resumable — which is exactly why step-runner.ts never steers a
 * `background` step and instead lets invalid output fall back to the repeat policy (spec §9.2); it is
 * also why `getConversation()` below returns `[]` rather than any prior turns — there is nothing to
 * seed a resume with, and `.commit()` already rejects `background` + `asks` so one is never needed.
 *
 * The spawn itself goes through `pi.exec` — the "run a shell command to completion" helper every
 * extension already has — rather than PI's own raw `child_process.spawn` (which streams `message_end`
 * events as they arrive, for a subagent tool's live progress UI). A background workflow step has no
 * such UI: it only ever needs the FINAL structured output, so awaiting the whole process and parsing
 * its complete stdout in one pass (`parseNdjsonMessages`, pi-agent-messages.ts) is simpler and just as
 * correct. The parsing itself is pure and covered offline by captured fixture lines
 * (test/pi-agent-messages.test.ts) — the process spawn is the one part that genuinely cannot be
 * exercised without a real binary.
 *
 * `resolvePiInvocation` (below) picks WHICH binary that spawn targets — deliberately not a hardcoded
 * literal `"pi"`, since this module stays host-agnostic (no product-specific coupling beyond the
 * `ExtensionAPI` surface): a background step must respawn whatever harness is ACTUALLY running it
 * right now (kimchi, plain `pi`, or any other embedder), not a guess. It mirrors upstream's own
 * `examples/extensions/subagent/index.ts` (`getPiInvocation`) — the file this header already cites as
 * the isolation mechanism's model — confirmed live in the P7 harness pass: the plain global `pi`
 * binary has no knowledge of a host-specific provider (e.g. kimchi's own `kimchi-dev` gateway), so a
 * literal `"pi"` silently spawns the wrong binary whenever the embedding harness is anything other
 * than vanilla `pi` itself.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRequest, AgentSession, AgentTurn, ConversationMessage } from "../engine/types.ts";
import { type AgentMessages, lastAssistantText, lastAssistantUsage, type ModelRegistry, parseNdjsonMessages, resolveModel } from "./pi-agent-messages.ts";

export type AgentStarter = (request: AgentRequest) => AgentSession;

/** What to spawn (`pi.exec`'s first two arguments) for a background subagent, given the CLI args after the binary name. */
export type PiInvocationResolver = (args: readonly string[]) => { command: string; args: readonly string[] };

/**
 * Respawn the CURRENTLY RUNNING harness process itself, so a background subagent always lands in the
 * same host it was launched from (same provider registry, same auth) — never a different product.
 * Three cases, in order, matching upstream's `getPiInvocation`:
 *   1. Dev/interpreter invocation (`node`/`bun script.ts ...`): `process.argv[1]` is a real file on
 *      disk → respawn `[process.execPath, thatScript, ...args]`.
 *   2. A compiled single-file executable (e.g. kimchi's built binary, or `pi`'s): `process.execPath`'s
 *      basename is not a generic runtime name → respawn `process.execPath` directly.
 *   3. Last resort — matches the previous hardcoded behaviour: literal `"pi"` on `PATH`.
 */
export function resolvePiInvocation(args: readonly string[]): { command: string; args: readonly string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/**
 * Create the PI agent bridge. Call once per extension instance (registers one `agent_end` listener),
 * then obtain a per-run `AgentStarter` bound to the command's model registry. `invocationResolver`
 * defaults to {@link resolvePiInvocation}; tests inject a fixed stub instead of depending on the live
 * process's own argv/execPath.
 */
export function createPiAgentBridge(pi: ExtensionAPI, invocationResolver: PiInvocationResolver = resolvePiInvocation): (modelRegistry: ModelRegistry) => AgentStarter {
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
      return backgroundSession(pi, modelRegistry, request, invocationResolver);
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

/**
 * A background subagent's session (spec §2.2): one `pi --mode json -p --no-session` subprocess per
 * `sendAndAwaitEnd` call (step-runner.ts calls it exactly once — a background step's repair budget is
 * forced to 0, spec §9.2 — but nothing here assumes that; a second call just spawns a second process).
 * Isolated by construction: a fresh CLI invocation gets its own context window and tool loop, with no
 * access to the parent session's history — `request.history` is always undefined for a background
 * request (see AgentRequest's doc, engine/types.ts) so there is nothing to seed it with anyway.
 */
function backgroundSession(pi: ExtensionAPI, modelRegistry: ModelRegistry, request: AgentRequest, invocationResolver: PiInvocationResolver): AgentSession {
  return {
    async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
      const args = ["--mode", "json", "-p", "--no-session"];
      if (request.model) {
        // Resolved (and rejected) up front, same as the interactive path: a typo'd model should fail
        // clearly here rather than surface as an opaque nonzero exit from the child process.
        if (!resolveModel(modelRegistry, request.model)) {
          throw new Error(`unknown model "${request.model}" (expected provider/modelId)`);
        }
        args.push("--model", request.model);
      }
      args.push(message);

      const invocation = invocationResolver(args);
      const result = await pi.exec(invocation.command, [...invocation.args]);
      if (result.code !== 0) {
        throw new Error(`background subagent step "${request.stepName}" exited with code ${result.code}: ${result.stderr.trim() || "(no stderr)"}`);
      }

      const messages = parseNdjsonMessages(result.stdout);
      return { text: lastAssistantText(messages), usage: lastAssistantUsage(messages) };
    },
    getConversation(): readonly ConversationMessage[] {
      return []; // one-shot: never resumed with seeded history (spec §2.2/§10.1 — background can't ask)
    },
    dispose(): void {},
  };
}
