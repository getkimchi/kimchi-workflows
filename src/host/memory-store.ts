import type { RunEvent } from "../engine/types.ts";
import { summarizeRun } from "./summarize-run.ts";
import type { RunStore, RunSummary } from "./types.ts";

/**
 * An in-memory store, plus the whole log as one ordered sequence.
 *
 * `RunStore.loadEvents` is per-run by design, but a test usually wants "everything that happened, in
 * order" — which the store already knows. Exposing it here means tests read the log rather than
 * wrapping `emit` to collect a second copy of it.
 */
export interface MemoryStore extends RunStore {
  /** Every appended event across every run, in append order. Live: reflects appends as they happen. */
  readonly events: readonly RunEvent[];
}

/**
 * In-memory `RunStore`. Used as the backing store for the fake `HostPort` in engine tests
 * (no filesystem, no PI, no network) — see test/helpers.ts.
 */
export function createMemoryStore(): MemoryStore {
  const eventsByRun = new Map<string, RunEvent[]>();
  const log: RunEvent[] = [];

  return {
    get events(): readonly RunEvent[] {
      return log;
    },
    async appendEvent(event: RunEvent): Promise<void> {
      log.push(event);
      const existing = eventsByRun.get(event.runId);
      if (existing) {
        existing.push(event);
      } else {
        eventsByRun.set(event.runId, [event]);
      }
    },
    async loadEvents(runId: string): Promise<RunEvent[]> {
      return [...(eventsByRun.get(runId) ?? [])];
    },
    async delete(runId: string): Promise<void> {
      eventsByRun.delete(runId);
      // Keep the flat log consistent with the per-run view: a deleted run leaves no trace (spec §6.5).
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i]?.runId === runId) log.splice(i, 1);
      }
    },
    async list(): Promise<RunSummary[]> {
      const summaries: RunSummary[] = [];
      for (const events of eventsByRun.values()) {
        const summary = summarizeRun(events);
        if (summary) summaries.push(summary);
      }
      summaries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return summaries;
    },
  };
}
