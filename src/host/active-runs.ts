/**
 * Non-exclusive bookkeeping for workflow executions owned by this process.
 *
 * This is deliberately a registry, not a guard: starting a run always succeeds, including when other
 * executions of the same run id are already present. The host needs the controllers only so
 * `/workflow cancel` can signal local work and `/workflow status` can resolve an unambiguous bare
 * command. Runs executing in other processes are intentionally outside this registry.
 */
export interface ActiveRun {
	readonly runId: string
	readonly controller: AbortController
}

export interface ActiveRuns {
	/** Every execution currently owned by this process, in start order. */
	readonly active: readonly ActiveRun[]
	/** Register a new execution. Never rejects or displaces another execution. */
	start(runId: string): ActiveRun
	/** Remove this exact execution, leaving any sibling execution of the same run untouched. */
	finish(run: ActiveRun): void
	/** Every local execution of `runId`. More than one is legal because this registry enforces no lock. */
	find(runId: string): readonly ActiveRun[]
}

export function createActiveRuns(): ActiveRuns {
	const active = new Set<ActiveRun>()

	return {
		get active() {
			return [...active]
		},
		start(runId) {
			const run = { runId, controller: new AbortController() }
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
