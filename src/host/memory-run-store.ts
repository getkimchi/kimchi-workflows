import type { RunEvent } from "../engine/types.ts";
import { summarizeRun } from "./summarize-run.ts";
import type { RunMeta, RunStore, RunSummary } from "./types.ts";

/**
 * In-memory `RunStore`. Used as the backing store for the fake `HostPort` in engine tests
 * (no filesystem, no PI, no network) — see test/helpers.ts.
 */
export function createMemoryRunStore(): RunStore {
  const eventsByRun = new Map<string, RunEvent[]>();
  const metaByRun = new Map<string, RunMeta>();

  return {
    async appendEvent(event: RunEvent): Promise<void> {
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
    async saveMeta(runId: string, meta: RunMeta): Promise<void> {
      metaByRun.set(runId, meta);
    },
    async loadMeta(runId: string): Promise<RunMeta | undefined> {
      return metaByRun.get(runId);
    },
    async delete(runId: string): Promise<void> {
      eventsByRun.delete(runId);
      metaByRun.delete(runId);
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
