/**
 * In-process single-active-run guard (spec §7). At most one run executes at a time in this
 * process; `/workflow run` and `/workflow resume` are rejected while one is active. Also holds
 * the active run's `AbortController` so `/workflow cancel` can abort it (spec §8.6).
 *
 * Deliberately based on an in-process handle, not stale store status: a run marked `in_progress`
 * in the store by a process that died is NOT tracked here.
 *
 * Known limitation: this does not coordinate across processes, so a stale `in_progress` left by a
 * crashed process elsewhere is not detected (resolved once such a run is resumed/cancelled).
 */
export interface ActiveRun {
  readonly runId: string;
  readonly controller: AbortController;
}

export interface RunGuard {
  /** The currently executing run, or undefined when idle. */
  readonly active: ActiveRun | undefined;
  /** Begin a run: returns its `AbortController`, or `undefined` if another run is already active. */
  begin(runId: string): AbortController | undefined;
  /** Mark the run finished. No-op if `runId` is not the active run. */
  end(runId: string): void;
}

export function createRunGuard(): RunGuard {
  let active: ActiveRun | undefined;

  return {
    get active() {
      return active;
    },
    begin(runId: string): AbortController | undefined {
      if (active) return undefined;
      const controller = new AbortController();
      active = { runId, controller };
      return controller;
    },
    end(runId: string): void {
      if (active?.runId === runId) {
        active = undefined;
      }
    },
  };
}
