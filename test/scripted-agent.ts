import type { AgentRequest, AgentSession } from "../src/engine/types.ts";

/** A scripted turn: a plain string reply, a thrown `Error`, or a reply with token usage for budgeting. */
export type ScriptedTurn = string | Error | { text: string; totalTokens: number };

export interface ScriptedAgent {
  startAgent: (request: AgentRequest) => AgentSession;
  /** Every message sent (prompt + corrections + answers) across all sessions, in order. */
  readonly messages: string[];
  /** The `model` seen by each opened session, in order. */
  readonly models: (string | undefined)[];
  /** The `history` seed seen by each opened session, in order (undefined for a fresh session). */
  readonly histories: (readonly unknown[] | undefined)[];
  /** The `background` flag seen by each opened session, in order. */
  readonly backgrounds: (boolean | undefined)[];
  /** The `isolated` flag (spec §2.2, static isolation) seen by each opened session, in order. */
  readonly isolateds: (boolean | undefined)[];
  /** Number of sessions opened (one per `startAgent`, i.e. per outer attempt / resume). */
  readonly opened: number;
  /** Number of `dispose()` calls. */
  readonly disposed: number;
}

/**
 * A scripted `startAgent` for offline agent-step tests. Each opened session replays its own script
 * turn-by-turn: the Nth `sendAndAwaitEnd` returns (or throws) `script[N]`. An `Error` entry is
 * thrown (transport error); a `string` is returned as the reply; a `{ text, totalTokens }` entry
 * additionally reports usage (for token-budget tests).
 *
 * Pass one script per expected session: `[[a, b], [c]]` scripts a first session that replies `a`
 * then `b` (e.g. across a steering repair), and a second fresh session (after an outer retry) that
 * replies `c`.
 */
export function scriptedAgent(sessionScripts: readonly (readonly ScriptedTurn[])[]): ScriptedAgent {
  const messages: string[] = [];
  const models: (string | undefined)[] = [];
  const histories: (readonly unknown[] | undefined)[] = [];
  const backgrounds: (boolean | undefined)[] = [];
  const isolateds: (boolean | undefined)[] = [];
  let opened = 0;
  let disposed = 0;
  let sessionIndex = 0;
  /** The step whose in-session turn is currently in flight — PI allows at most one (spec §2.2). */
  let inSessionTurn: string | undefined;

  const startAgent = (request: AgentRequest): AgentSession => {
    opened += 1;
    models.push(request.model);
    histories.push(request.history);
    backgrounds.push(request.background);
    isolateds.push(request.isolated);
    const script = sessionScripts[sessionIndex++] ?? [];
    const conversation: unknown[] = [...(request.history ?? [])];
    const sharesTheSession = request.background !== true && request.isolated !== true;
    let turn = 0;
    return {
      async sendAndAwaitEnd(message: string) {
        // Model PI's real constraint: a session hosts ONE conversation, so a second in-session turn
        // while another is in flight is an error there (spec §2.2). A double that quietly allows it is
        // how concurrent agent steps cross-talked in the real harness while every offline test stayed
        // green — the offline suite could not see the bug it was supposed to be guarding.
        if (sharesTheSession) {
          if (inSessionTurn) {
            throw new Error(
              `scripted agent: step "${request.stepName}" started an in-session turn while "${inSessionTurn}"'s turn was still in flight — it should have been isolated (spec §2.2)`,
            );
          }
          inSessionTurn = request.stepName;
        }
        try {
          messages.push(message);
          conversation.push({ role: "user", content: message });
          const response = script[turn++];
          if (response === undefined) throw new Error("scripted session ran out of responses");
          if (response instanceof Error) throw response;
          const text = typeof response === "string" ? response : response.text;
          conversation.push({ role: "assistant", content: text });
          return typeof response === "string" ? { text } : { text, usage: { totalTokens: response.totalTokens } };
        } finally {
          // Every exit path, including a scripted transport error: a turn that threw is no longer in
          // flight, and the retry that follows opens a fresh session PI would happily accept.
          if (sharesTheSession) inSessionTurn = undefined;
        }
      },
      getConversation() {
        return conversation;
      },
      dispose() {
        disposed += 1;
      },
    };
  };

  return {
    startAgent,
    messages,
    models,
    histories,
    backgrounds,
    isolateds,
    get opened() {
      return opened;
    },
    get disposed() {
      return disposed;
    },
  };
}
