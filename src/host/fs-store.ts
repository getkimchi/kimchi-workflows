import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import type { RunEvent } from "../engine/types.ts"
import { createRunExecutionLease, isLocalProcessAlive, sameLease } from "./run-lease.ts"
import { summarizeRun } from "./summarize-run.ts"
import type {
	InspectedRunExecution,
	RunExecutionLease,
	RunExecutionOwner,
	RunExecutionStore,
	RunStore,
	RunSummary,
} from "./types.ts"

/** What marks a file in the artifacts directory as a run's event log rather than one of its step sessions. */
export const RUN_LOG_SUFFIX = ".events.jsonl"
export const RUN_LEASE_SUFFIX = ".execution.json"

/** Raised when atomic lease acquisition proves this exact run id already has an executor. */
export class RunExecutionAlreadyOwnedError extends Error {
	constructor(readonly execution: InspectedRunExecution) {
		const { host, pid } = execution.lease.owner
		super(`run ${execution.lease.runId} is already owned by PID ${pid} on ${host}`)
		this.name = "RunExecutionAlreadyOwnedError"
	}
}

export interface FsStoreOptions {
	/** Omit for read-only callers such as completion; execution methods are then unavailable. */
	readonly executionOwner?: RunExecutionOwner
	readonly now?: () => Date
	readonly generateExecutionId?: () => string
	readonly isProcessAlive?: (owner: RunExecutionOwner) => boolean | Promise<boolean>
}

// Stores are constructed per command invocation, while a live run and `/workflow cancel` are separate
// invocations. Queue by absolute file path at module scope so their appends still have one in-process
// order: cancellation can flush behind every already-accepted event before it aborts the executor.
const fileTails = new Map<string, Promise<void>>()
const MAX_LEASE_RACE_RETRIES = 3

function serialize(filePath: string, work: () => Promise<void>): Promise<void> {
	const previous = fileTails.get(filePath) ?? Promise.resolve()
	const next = previous.then(work)
	const tracked = next
		.catch(() => {})
		.finally(() => {
			if (fileTails.get(filePath) === tracked) fileTails.delete(filePath)
		})
	fileTails.set(filePath, tracked)
	return next
}

/**
 * Filesystem `RunStore` (spec §8.9): one append-only JSONL history per run, plus a temporary atomic
 * execution lease while work is live. Runs remain independently keyed and listable/resumable across
 * sessions and process restarts.
 *
 * `dir` is the already-resolved run-artifacts directory (project-dir.ts's `runArtifactsDir`), not a
 * project root: WHERE a run's artifacts belong is one decision, made once, by whoever holds the
 * harness context — this file only owns the format.
 *
 * That directory also holds every step SESSION file this run spawns (spec §2.2), which is why the log
 * carries the `.events.jsonl` suffix and why `list()` filters on it: a bare `.jsonl` scan would try to
 * read each step session as a run log. In the other direction nothing needs doing — the log is not a
 * session file and the harness's own reader returns `null` for anything whose first line is not
 * `{"type":"session"}`, with every enumerator dropping nulls. Workflow provenance and observable
 * ownership remain in the log (`run-meta` and `run-execution-started`); the `.execution.json` sidecar
 * is coordination state only and exists no longer than the active execution.
 */
export function createFsStore(dir: string, options: FsStoreOptions = {}): RunStore {
	async function ensureDir(): Promise<void> {
		await mkdir(dir, { recursive: true })
	}

	const logFilePath = (runId: string) => path.join(dir, `${runId}${RUN_LOG_SUFFIX}`)
	const leaseFilePath = (runId: string) => path.join(dir, `${runId}${RUN_LEASE_SUFFIX}`)
	const retirementFilePath = (runId: string) => path.join(dir, `${runId}${RUN_LEASE_SUFFIX}.retiring`)

	/**
	 * Read a run's log, tolerating one truncated line at the END and nothing else.
	 *
	 * A process killed mid-append can leave a half-written final line. That append never completed, so
	 * the event it carried never
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

	let executions: RunExecutionStore | undefined
	if (options.executionOwner) {
		const executionOwner = options.executionOwner
		const processAlive = options.isProcessAlive ?? isLocalProcessAlive

		const inspect = async (runId: string): Promise<InspectedRunExecution | undefined> => {
			let lease: RunExecutionLease
			try {
				lease = JSON.parse(await readFile(leaseFilePath(runId), "utf8")) as RunExecutionLease
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
				throw error
			}
			if (
				lease.version !== 1 ||
				lease.runId !== runId ||
				typeof lease.executionId !== "string" ||
				typeof lease.acquiredAt !== "string" ||
				typeof lease.owner?.ownerId !== "string" ||
				typeof lease.owner.host !== "string" ||
				!Number.isInteger(lease.owner.pid) ||
				lease.owner.pid <= 0 ||
				typeof lease.owner.processStartedAt !== "string"
			) {
				throw new Error(`invalid workflow execution lease ${leaseFilePath(runId)}`)
			}
			if (lease.owner.ownerId === executionOwner.ownerId) return { lease, state: "owned" }
			if (lease.owner.host !== hostname()) return { lease, state: "foreign" }
			return { lease, state: (await processAlive(lease.owner)) ? "live" : "dead" }
		}

		const acquire = async (runId: string): Promise<RunExecutionLease> => {
			await ensureDir()
			const lease = createRunExecutionLease(runId, executionOwner, options.now, options.generateExecutionId)
			for (let retry = 0; retry <= MAX_LEASE_RACE_RETRIES; retry += 1) {
				try {
					await writeFile(leaseFilePath(runId), `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx" })
					return lease
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
					const existing = await inspect(runId)
					if (existing) throw new RunExecutionAlreadyOwnedError(existing)
					if (retry === MAX_LEASE_RACE_RETRIES) {
						throw new Error(`run ${runId} execution lease changed repeatedly during acquisition; retry the command`)
					}
					// The owner released between exclusive-create and inspection. Retry the same execution
					// identity; another winner still produces the precise ownership error above.
				}
			}
			throw new Error(`run ${runId} execution lease acquisition exhausted unexpectedly`)
		}

		const retire = async (lease: RunExecutionLease, beforeRelease: () => Promise<void>): Promise<boolean> => {
			const markerPath = retirementFilePath(lease.runId)
			const marker = {
				lease,
				owner: executionOwner,
				at: (options.now ?? (() => new Date()))().toISOString(),
			}
			for (let retry = 0; retry <= MAX_LEASE_RACE_RETRIES; retry += 1) {
				try {
					await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" })
					break
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
					// A reclaimer can itself crash. Reclaim its marker only when that local process is
					// provably dead; foreign-host markers remain conservative, like their leases.
					let existing: { owner?: RunExecutionOwner }
					try {
						existing = JSON.parse(await readFile(markerPath, "utf8")) as { owner?: RunExecutionOwner }
					} catch {
						return false
					}
					if (!existing.owner || existing.owner.host !== hostname()) return false
					if (await processAlive(existing.owner)) return false
					await rm(markerPath, { force: true })
					if (retry === MAX_LEASE_RACE_RETRIES) return false
				}
			}

			try {
				const current = await inspect(lease.runId)
				if (!current || !sameLease(current.lease, lease)) return false
				await beforeRelease()
				await rm(leaseFilePath(lease.runId), { force: true })
				return true
			} finally {
				await rm(markerPath, { force: true })
			}
		}

		executions = {
			acquire,
			inspect,
			retire,
			release: (lease) => retire(lease, async () => {}),
		}
	}

	return {
		executions,
		appendEvent(event: RunEvent): Promise<void> {
			const filePath = logFilePath(event.runId)
			return serialize(filePath, async () => {
				await ensureDir()
				await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8")
			})
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
