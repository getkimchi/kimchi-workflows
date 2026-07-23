import { randomUUID } from "node:crypto";
import type { AgentRequest, AgentSession, HostPort } from "../engine/types.ts";
import type { RunStore } from "./types.ts";

/** Overrides for the non-deterministic `HostPort` inputs. Handy for deterministic tests. */
export interface HostPortOptions {
  /** Supply run ids (default: `crypto.randomUUID`). */
  generateRunId?: () => string;
  /** Supply the clock (default: `() => new Date()`). */
  now?: () => Date;
  /** Supply the delay used for retry backoff / budget timers (default: a real, abortable `setTimeout`). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Supply agent execution (default: throws — a store-only host does not support agent steps). */
  startAgent?: (request: AgentRequest) => AgentSession;
}

/**
 * Build the engine's `HostPort` on top of any `RunStore`. Real usage backs it with the
 * filesystem store (src/host/fs-store.ts) plus a real `startAgent`; tests back it with the
 * in-memory store (src/host/memory-store.ts) and a scripted `startAgent`.
 */
export function createHostPort(store: RunStore, options: HostPortOptions = {}): HostPort {
  return {
    generateRunId: options.generateRunId ?? randomUUID,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? defaultSleep,
    startAgent:
      options.startAgent ??
      (() => {
        throw new Error("this HostPort has no agent support (no startAgent provided); agent steps cannot run");
      }),
    emit: (event) => store.appendEvent(event),
  };
}

/** Real timer that resolves after `ms`, or early if `signal` aborts (clearing the timer so it does not linger). */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
