import type { HostPort, RunEvent } from "../src/engine/types.ts";
import { createHostPort, type HostPortOptions } from "../src/host/host-port.ts";
import { createMemoryStore } from "../src/host/memory-store.ts";
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
