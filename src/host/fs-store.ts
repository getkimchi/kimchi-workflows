import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunEvent } from "../engine/types.ts";
import { summarizeRun } from "./summarize-run.ts";
import type { RunMeta, RunStore, RunSummary } from "./types.ts";

/**
 * Filesystem `RunStore` (spec §8.7): append-only JSONL under `<projectRoot>/.pi/workflows/`,
 * one file per run (`<run-id>.jsonl`) plus a `<run-id>.meta.json` sidecar, so runs are
 * independently keyed and listable/resumable across sessions and process restarts.
 */
export function createFsStore(projectRoot: string): RunStore {
  const dir = path.join(projectRoot, ".pi", "workflows");

  // Serialize all appends through a single tail promise so writes land in call order regardless
  // of whether the caller awaits them. The engine emits `step-log` events fire-and-forget (`void
  // host.emit(...)`); without this queue such a write could reorder against a later awaited event
  // or still be in flight when the terminal event resolves — losing/reordering the log line in the
  // short-lived CLI. Because the terminal `run-completed`/`run-crashed` emit *is* awaited and is
  // last in the chain, awaiting it flushes every prior append.
  let tail: Promise<void> = Promise.resolve();

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  const logFilePath = (runId: string) => path.join(dir, `${runId}.jsonl`);
  const metaFilePath = (runId: string) => path.join(dir, `${runId}.meta.json`);

  /**
   * Read a run's log, tolerating one truncated line at the END and nothing else.
   *
   * A process killed mid-append (the very case the lock's stale-reclaim exists for, spec §7.3) can
   * leave a half-written final line. That append never completed, so the event it carried never
   * happened, and dropping it is exactly right. A malformed line anywhere EARLIER is genuine
   * corruption and throws naming the file and line: skipping those would silently rewrite history —
   * lose a `run-cancelled` and a run the user stopped comes back to life (spec §8.4).
   */
  async function readEvents(filePath: string): Promise<RunEvent[]> {
    const content = await readFile(filePath, "utf8").catch(() => "");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const events: RunEvent[] = [];
    for (const [index, line] of lines.entries()) {
      try {
        events.push(JSON.parse(line) as RunEvent);
      } catch (err) {
        if (index === lines.length - 1) break; // truncated tail: the write never landed
        throw new Error(`corrupt run log ${filePath} at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return events;
  }

  return {
    appendEvent(event: RunEvent): Promise<void> {
      const write = tail.then(async () => {
        await ensureDir();
        await appendFile(logFilePath(event.runId), `${JSON.stringify(event)}\n`, "utf8");
      });
      // Advance the tail but swallow this write's rejection there, so one failed append does not
      // break ordering (or silently skip) every subsequent one. The caller still sees the real
      // error via the returned `write` promise.
      tail = write.catch(() => {});
      return write;
    },
    async loadEvents(runId: string): Promise<RunEvent[]> {
      return readEvents(logFilePath(runId));
    },
    async saveMeta(runId: string, meta: RunMeta): Promise<void> {
      await ensureDir();
      await writeFile(metaFilePath(runId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    },
    async loadMeta(runId: string): Promise<RunMeta | undefined> {
      const content = await readFile(metaFilePath(runId), "utf8").catch(() => undefined);
      return content === undefined ? undefined : (JSON.parse(content) as RunMeta);
    },
    async delete(runId: string): Promise<void> {
      await Promise.all([rm(logFilePath(runId), { force: true }), rm(metaFilePath(runId), { force: true })]);
    },
    async list(): Promise<RunSummary[]> {
      await ensureDir();
      const entries = await readdir(dir).catch(() => [] as string[]);
      const summaries: RunSummary[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const summary = summarizeRun(await readEvents(path.join(dir, entry)));
        if (summary) summaries.push(summary);
      }
      summaries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return summaries;
    },
  };
}
