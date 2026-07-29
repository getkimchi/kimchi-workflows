import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import type { RunEvent } from "../engine/types.ts"
import { summarizeRun } from "./summarize-run.ts"
import type { RunStore, RunSummary } from "./types.ts"

/** What marks a file in the artifacts directory as a run's event log rather than one of its step sessions. */
export const RUN_LOG_SUFFIX = ".events.jsonl"

/**
 * Filesystem `RunStore` (spec §8.9): append-only JSONL, one file per run, so runs are independently
 * keyed and listable/resumable across sessions and process restarts.
 *
 * `dir` is the already-resolved run-artifacts directory (project-dir.ts's `runArtifactsDir`), not a
 * project root: WHERE a run's artifacts belong is one decision, made once, by whoever holds the
 * harness context — this file only owns the format.
 *
 * That directory also holds every step SESSION file this run spawns (spec §2.2), which is why the log
 * carries the `.events.jsonl` suffix and why `list()` filters on it: a bare `.jsonl` scan would try to
 * read each step session as a run log. In the other direction nothing needs doing — the log is not a
 * session file and the harness's own reader returns `null` for anything whose first line is not
 * `{"type":"session"}`, with every enumerator dropping nulls. There is no `.meta.json` sidecar any
 * more: `workflowFilePath` is a `run-meta` event in the log itself (engine/types.ts), so a run is
 * exactly one file and `delete` is exactly one unlink.
 */
export function createFsStore(dir: string): RunStore {
	// Serialize all appends through a single tail promise so writes land in call order regardless
	// of whether the caller awaits them. The engine emits `step-log` events fire-and-forget (`void
	// host.emit(...)`); without this queue such a write could reorder against a later awaited event
	// or still be in flight when the terminal event resolves — losing/reordering the log line in the
	// short-lived CLI. Because the terminal `run-completed`/`run-crashed` emit *is* awaited and is
	// last in the chain, awaiting it flushes every prior append.
	let tail: Promise<void> = Promise.resolve()

	async function ensureDir(): Promise<void> {
		await mkdir(dir, { recursive: true })
	}

	const logFilePath = (runId: string) => path.join(dir, `${runId}${RUN_LOG_SUFFIX}`)

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
		const content = await readFile(filePath, "utf8").catch(() => "")
		const lines = content.split("\n").filter((line) => line.trim().length > 0)
		const events: RunEvent[] = []
		for (const [index, line] of lines.entries()) {
			try {
				events.push(JSON.parse(line) as RunEvent)
			} catch (err) {
				if (index === lines.length - 1) break // truncated tail: the write never landed
				throw new Error(
					`corrupt run log ${filePath} at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}
		return events
	}

	return {
		appendEvent(event: RunEvent): Promise<void> {
			const write = tail.then(async () => {
				await ensureDir()
				await appendFile(logFilePath(event.runId), `${JSON.stringify(event)}\n`, "utf8")
			})
			// Advance the tail but swallow this write's rejection there, so one failed append does not
			// break ordering (or silently skip) every subsequent one. The caller still sees the real
			// error via the returned `write` promise.
			tail = write.catch(() => {})
			return write
		},
		async loadEvents(runId: string): Promise<RunEvent[]> {
			return readEvents(logFilePath(runId))
		},
		async delete(runId: string): Promise<void> {
			await rm(logFilePath(runId), { force: true })
		},
		async list(): Promise<RunSummary[]> {
			// Deliberately does NOT create the directory: `list()` is a pure read, and completion calls it on
			// a keystroke (spec §14.6) — typing `/workflow ` in a session that has never run a workflow must
			// not deposit an artifacts directory. A missing directory is simply no runs.
			const entries = await readdir(dir).catch(() => [] as string[])
			const summaries: RunSummary[] = []
			for (const entry of entries) {
				if (!entry.endsWith(RUN_LOG_SUFFIX)) continue
				const summary = summarizeRun(await readEvents(path.join(dir, entry)))
				if (summary) summaries.push(summary)
			}
			summaries.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
			return summaries
		},
	}
}
