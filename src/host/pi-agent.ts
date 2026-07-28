/**
 * Real PI-harness implementation of the engine's agent seam (`HostPort.startAgent`, spec §2.2).
 *
 * A session: resolve + `setModel(model)`, `sendUserMessage(prompt)`, await the `agent_end` event,
 * and return the last assistant message's text. Compiles against the real
 * `@earendil-works/pi-coding-agent` types (`AgentEndEvent = { messages }`).
 *
 * A single `agent_end` listener is registered per bridge (the extension holds one bridge for its
 * lifetime) — `pi.on` exposes no unsubscribe, so `dispose()` clears the bridge's OWN in-flight turn
 * rather than removing the listener. That listener backs every IN-SESSION turn (never `background` or
 * statically `isolated` ones, spec §2.2 — those go through `backgroundSession` below, a real subprocess
 * per turn, with no shared listener to correlate). There is at most one real PI session, so at most one
 * in-session turn may ever be awaiting that listener at a time: `inFlight` tracks exactly that one turn
 * by an identity private to the session that started it, and a second `sendAndAwaitEnd` attempted while
 * one is already in flight is REJECTED outright — never silently swapped in as the thing the listener
 * resolves next. Before P3's `.parallel`/`.foreach(concurrency>1)` landed this could never happen (the
 * engine only ever ran one step at a time); the guard here is what makes that no longer an assumption
 * this file quietly depends on — see `flow/isolation.ts` for the static decision (tagged onto each step
 * at `.commit()`) that is now supposed to keep it from happening at all, and `AgentRequest.isolated`'s
 * doc (engine/types.ts) for the seam.
 *
 * `getConversation()` returns the last `agent_end` messages so a blocked Q&A step can be resumed
 * (spec §8.4). Within one live PI process that alone is enough — PI's own session already has the
 * context. Across a harness restart it is not: the fresh process's PI session starts with none of the
 * pre-restart turns, so `AgentRequest.history` (the stored conversation) must be seeded back in, or the
 * agent would answer a follow-up having forgotten what it asked and why. PI exposes exactly one
 * documented mechanism for that: the `context` extension event, fired before every outgoing LLM call
 * and wired straight into `AgentLoopConfig.transformContext` (`core/sdk.ts`) — "Injecting context from
 * external sources" per `docs/extensions.md`. There is no session-seeding constructor (no
 * `newSession({ messages })`, no way to pre-load `agent.state.messages` from an extension) — this is
 * the closest real capability to it, so the bridge below registers ONE shared `context` handler
 * (mirroring the `agent_end` listener's one-per-bridge-lifetime shape) that prepends whichever session's
 * `history` is currently active. It stays active for the WHOLE session, not just its first turn: PI's
 * own accumulated state does not fold the injected prefix back in (`transformContext` is a pre-call
 * view, not a state mutation), so a mid-attempt steering repair would otherwise see the seed vanish
 * after turn one. The pure prepend itself (`seedHistory`) lives in pi-agent-messages.ts, unit-tested
 * offline; only the PI wiring — registering the listener and tracking which session owns the active
 * seed — lives here.
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
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRequest, AgentSession, AgentTurn, ConversationMessage } from "../engine/types.ts";
import { type AgentMessages, lastAssistantText, lastAssistantUsage, type ModelRegistry, parseNdjsonMessages, resolveModel, seedHistory } from "./pi-agent-messages.ts";

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
 * Permission-bypass flags the CURRENT process was launched with, which every subagent it spawns must be
 * launched with too.
 *
 * `resolvePiInvocation` above respawns the harness that is running right now precisely so a subagent
 * inherits its provider, auth and model registry rather than guessing at them. Permission posture is the
 * one part of that inheritance the argv does not carry for free: the parent's mode is decided from ITS
 * argv, and a fresh process reads its own. So a run launched with permissions bypassed was spawning
 * subagents that re-armed the classifier — measured on a benchmark run, **59 tool calls refused inside
 * subagent sessions while the parent had none**, including `mkdir -p` and `test -f`, with one task lost
 * outright because its worker could not install a package the task itself required and burned its budget
 * trying to talk its way around the refusal. The parent had no such trouble.
 *
 * Inheriting is safe in the only direction that matters: a flag has to be present in the PARENT's own
 * argv to be forwarded, so this can never make a child more permissive than the process that started it,
 * and a normally-launched session keeps its subagents' checks armed. It is deliberately a small, explicit
 * allowlist rather than a general argv passthrough — forwarding the parent's whole command line would
 * hand a subagent its `--session`, its prompt, and anything else the embedder happened to pass.
 */
const PERMISSION_BYPASS_FLAGS = ["--dangerously-skip-permissions", "--yolo"] as const;

export function inheritedPermissionArgs(argv: readonly string[] = process.argv): string[] {
  return PERMISSION_BYPASS_FLAGS.filter((flag) => argv.includes(flag));
}

/** Where a resumable isolated step's session file lives; the harness creates the file, we own the directory. */
function resumeSessionPath(resumeKey: string): string {
  const dir = process.env.PI_WORKFLOW_SESSIONS_DIR ?? path.join(process.cwd(), ".pi", "workflows", "sessions");
  mkdirSync(dir, { recursive: true });
  // The key is a step name, which `.commit()` has already cleared of path syntax (spec §3).
  return path.join(dir, `${resumeKey}.jsonl`);
}

/**
 * Create the PI agent bridge. Call once per extension instance (registers one `agent_end` listener),
 * then obtain a per-run `AgentStarter` bound to the command's model registry. `invocationResolver`
 * defaults to {@link resolvePiInvocation}; tests inject a fixed stub instead of depending on the live
 * process's own argv/execPath.
 */
export function createPiAgentBridge(pi: ExtensionAPI, invocationResolver: PiInvocationResolver = resolvePiInvocation): (modelRegistry: ModelRegistry) => AgentStarter {
  // The ONE in-session turn currently awaiting the shared `agent_end` listener, if any (see the header
  // comment). `token` is an identity private to the session that started the turn — not the step name,
  // since the SAME step name can legitimately open several sessions across retries/repairs, and dispose()
  // must only ever clear a turn it itself started, never a sibling's.
  let inFlight: { readonly token: object; readonly stepName: string; readonly resolve: (turn: AgentTurn) => void } | undefined;
  let lastConversation: AgentMessages = [];
  // The one answer-resumed session (spec §8.4) currently entitled to have its stored `history` seeded
  // into every outgoing LLM call — see the header comment. Token-guarded exactly like `inFlight`, so a
  // session can only ever clear the seed IT set (never a sibling's), and cleared in `dispose()`.
  let activeHistory: { readonly token: object; readonly history: AgentMessages } | undefined;

  pi.on("agent_end", (event) => {
    lastConversation = event.messages;
    const turn = inFlight;
    if (!turn) return; // no in-session turn was awaiting this event (only background/isolated steps ran)
    inFlight = undefined;
    turn.resolve({ text: lastAssistantText(event.messages), usage: lastAssistantUsage(event.messages) });
  });

  pi.on("context", (event: ContextEvent) => {
    if (!activeHistory) return; // the common case: no resumed session is currently in flight
    const seeded = seedHistory(activeHistory.history, event.messages as AgentMessages);
    return seeded ? { messages: seeded } : undefined;
  });

  return (modelRegistry) => (request) => {
    // Isolation (spec §2.2/§12.2): a `background` step, and now also any step the ENGINE decided is
    // statically isolated (can overlap with a sibling — `.parallel`/`.foreach(concurrency>1)`, see
    // `AgentRequest.isolated`'s doc), both run through the same one-shot subprocess path. Neither ever
    // touches `inFlight` — there is no shared listener to correlate a subprocess's own reply with.
    if (request.background || request.isolated) {
      return backgroundSession(pi, modelRegistry, request, invocationResolver);
    }

    const token = {}; // this session's own identity — see `inFlight`'s doc above
    // An answer-resume (spec §8.4) arrives with its blocked step's stored conversation — seed it into
    // this session's outgoing LLM calls via the shared `context` handler above, for the session's whole
    // lifetime (cleared in `dispose()`). A fresh run's `request.history` is always undefined, so the
    // overwhelmingly common case never touches `activeHistory` at all.
    if (request.history) {
      activeHistory = { token, history: request.history as AgentMessages };
    }
    return {
      async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
        // Safety net, not the primary mechanism (spec §2.2): static isolation is what is SUPPOSED to
        // keep two in-session turns from ever overlapping. If it somehow fails — a bug elsewhere, a step
        // the static analysis missed — this must fail LOUDLY and SPECIFICALLY rather than silently
        // overwrite `inFlight` and let the eventual `agent_end` resolve the WRONG caller with the OTHER
        // step's reply (the live cross-talk this bridge exists to rule out). Failing here also means the
        // second `sendUserMessage` is never even issued — PI itself never sees two turns racing.
        if (inFlight) {
          throw new Error(
            `pi-agent bridge: step "${request.stepName}" tried to start an in-session agent turn while step ` +
              `"${inFlight.stepName}"'s turn is still in flight. A PI session hosts one conversation at a time ` +
              "(spec §2.2) — this step should have been statically isolated (background subprocess); refusing " +
              `to let the two turns cross-talk rather than resolving one with the other's reply.`,
          );
        }

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
          inFlight = { token, stepName: request.stepName, resolve };
          pi.sendUserMessage(message);
        });
      },
      getConversation(): readonly ConversationMessage[] {
        return lastConversation;
      },
      dispose(): void {
        // Only clear OUR OWN pending turn — never one a differently-identified session left in flight
        // (should not arise given the guard above, but dispose() must stay safe regardless, spec §2.2).
        if (inFlight?.token === token) inFlight = undefined;
        if (activeHistory?.token === token) activeHistory = undefined;
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
      // `--session <path>` both writes and RESUMES that file (the CLI's own wording), so a step asking
      // to continue across executions (`AgentRequest.resumeKey`) simply names the same file each time:
      // the second run starts with everything the first one had read, tried and learned, instead of
      // rediscovering it. Everything else stays ephemeral — a fresh, small context per step is what
      // makes a chain of isolated steps cheap, and a verifier's whole value is not remembering.
      // Permission posture is inherited, not defaulted (see `inheritedPermissionArgs`): a subagent of a
      // run that bypasses permissions must bypass them too, or it re-arms the classifier and spends its
      // budget arguing with a prompt no one is there to answer.
      const args = [
        "--mode",
        "json",
        "-p",
        ...(request.resumeKey ? ["--session", resumeSessionPath(request.resumeKey)] : ["--no-session"]),
        ...inheritedPermissionArgs(),
      ];
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
      // Hand the attempt's signal to the child (spec §8.8/§9.4). Without it a cancelled run reports
      // itself stopped while this process keeps spending tokens and writing files, a wall-time budget
      // fails the attempt but orphans the process it was supposed to bound, and — with no budget, the
      // default — an unresponsive subagent hangs the run with nothing able to interrupt it.
      const result = await pi.exec(invocation.command, [...invocation.args], { signal: request.signal });
      if (request.signal?.aborted) {
        throw new Error(`background subagent step "${request.stepName}" was aborted`);
      }
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
