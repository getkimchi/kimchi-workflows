/**
 * Process-local half of execution ownership. Different run ids may overlap; one run id may have only
 * one execution in this process. The durable store lease enforces that same rule across processes.
 */
import { createProcessExecutionOwner, createRunExecutionLease } from "./run-lease.ts"
import type { RunExecutionLease } from "./types.ts"

export interface ActiveRun {
	readonly runId: string
	readonly lease: RunExecutionLease
	readonly controller: AbortController
	readonly cancellationRecorded: boolean
	/** False once cancellation persistence begins, closing the late-event race before the disk write. */
	acceptsEvents(): boolean
	/** Persist cancellation once, then abort. Concurrent callers share the same durable operation. */
	cancel(persist: () => Promise<void>): Promise<"accepted" | "already-recorded" | "already-settled">
	/** Atomically close cancellation admission, waiting for an already-admitted cancellation if needed. */
	settle(): Promise<boolean>
}

export interface ActiveRuns {
	/** Every execution currently owned by this process, in start order. */
	readonly active: readonly ActiveRun[]
	/** Register an acquired execution. Rejects a duplicate execution of the same run id. */
	start(lease: RunExecutionLease | string): ActiveRun
	/** Remove this exact execution. */
	finish(run: ActiveRun): void
	/** The local execution of `runId` (an array for compatibility with existing resolution code). */
	find(runId: string): readonly ActiveRun[]
}

export function createActiveRuns(): ActiveRuns {
	const active = new Set<ActiveRun>()

	return {
		get active() {
			return [...active]
		},
		start(candidate) {
			const lease = typeof candidate === "string" ? createRunExecutionLease(candidate, fallbackOwner) : candidate
			if ([...active].some((run) => run.runId === lease.runId)) {
				throw new Error(`run ${lease.runId} already has an execution in this process`)
			}
			let state: "running" | "persisting-cancellation" | "cancelled" | "settling" = "running"
			let cancellation: Promise<"accepted" | "already-recorded"> | undefined
			const controller = new AbortController()
			const run: ActiveRun = {
				runId: lease.runId,
				lease,
				controller,
				get cancellationRecorded() {
					return state === "cancelled"
				},
				acceptsEvents() {
					return state === "running"
				},
				cancel(persist) {
					if (cancellation !== undefined) return cancellation.then(() => "already-recorded")
					if (state === "settling") return Promise.resolve("already-settled")
					state = "persisting-cancellation"
					cancellation = (async () => {
						try {
							await persist()
							state = "cancelled"
							controller.abort()
							return "accepted" as const
						} catch (error) {
							state = "running"
							cancellation = undefined
							throw error
						}
					})()
					return cancellation
				},
				async settle() {
					if (state === "running") {
						state = "settling"
						return false
					}
					if (state === "settling") return false
					const pendingCancellation = cancellation
					if (pendingCancellation !== undefined) {
						return pendingCancellation.then(() => state === "cancelled")
					}
					return state === "cancelled"
				},
			}
			active.add(run)
			return run
		},
		finish(run) {
			active.delete(run)
		},
		find(runId) {
			return [...active].filter((run) => run.runId === runId)
		},
	}
}

const fallbackOwner = createProcessExecutionOwner()
