import type { HostPort, RunEvent } from "../src/engine/types.ts";
import { createHostPort, type HostPortOptions } from "../src/host/host-port.ts";
import { createMemoryStore } from "../src/host/memory-store.ts";
import type { BeginResult, RunLock } from "../src/host/run-lock.ts";
import type { RunStore } from "../src/host/types.ts";

export interface TestHost {
  host: HostPort;
  store: RunStore;
  /** Every `host.sleep(ms)` requested by the engine, in order — lets tests assert retry backoff. */
  sleepCalls: number[];
  /**
   * The whole log in order, across every run this host drives — live, so it can be read mid-run as
   * well as after. Saves each test wrapping `emit` to collect a second copy of what the store holds;
   * `store.loadEvents(runId)` is the same events narrowed to one run.
   */
  events: readonly RunEvent[];
}

/**
 * A fully host-agnostic "fake host" for engine tests: no PI, no filesystem, no network — an
 * in-memory `RunStore` behind the same `createHostPort` adapter the real filesystem-backed host
 * uses. Exposes the store and a record of sleep requests.
 *
 * `sleep` defaults to instant + recorded (so retry tests are fast and can assert backoff); pass
 * `now`/`generateRunId`/`sleep` to override.
 */
export function createTestHost(options: HostPortOptions = {}): TestHost {
  const store = createMemoryStore();
  const sleepCalls: number[] = [];
  const host = createHostPort(store, {
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
    ...options,
  });
  return { host, store, sleepCalls, events: store.events };
}

/**
 * A fake `RunLock` for tests that exercise `runGuarded`/`handleCancel` orchestration without touching
 * the filesystem — the real file-backed lock's contention/reclaim/atomicity are covered directly in
 * test/run-lock.test.ts. Mirrors the old in-process guard: at most one active runId in memory at a
 * time; `begin`/`end` ignore the `projectRoot`/`store` arguments (present only to satisfy `RunLock`'s
 * shape) since there is no real lock file to touch.
 */
export function createFakeRunLock(): RunLock {
  let active: { runId: string; controller: AbortController } | undefined;

  return {
    get active() {
      return active;
    },
    async begin(runId: string): Promise<BeginResult> {
      if (active) {
        return { ok: false, reason: "held", holder: { runId: active.runId, pid: -1, host: "fake-host", startedAt: "" } };
      }
      const controller = new AbortController();
      active = { runId, controller };
      return { ok: true, controller };
    },
    async end(runId: string): Promise<void> {
      if (active?.runId === runId) active = undefined;
    },
  };
}
