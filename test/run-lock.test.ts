import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveRunStatus } from "../src/engine/run-status.ts";
import type { RunEvent } from "../src/engine/types.ts";
import { createMemoryStore } from "../src/host/memory-store.ts";
import { createRunLock, type LockInfo, type ProcessEnv } from "../src/host/run-lock.ts";

/** A fake `ProcessEnv` (spec §7.3): fixed pid/hostname, and a liveness table the test controls — the
 * whole point of the injected seam is that no real process is ever spawned or signalled. */
function fakeEnv(overrides: Partial<ProcessEnv> & { pid: number; hostname?: string }): ProcessEnv {
  return {
    pid: overrides.pid,
    hostname: overrides.hostname ?? "host-a",
    isAlive: overrides.isAlive ?? (() => true),
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function lockFilePath(projectRoot: string): string {
  return path.join(projectRoot, ".pi", "workflows", "run.lock");
}

async function readLockFile(projectRoot: string): Promise<LockInfo> {
  const content = await readFile(lockFilePath(projectRoot), "utf8");
  return JSON.parse(content) as LockInfo;
}

describe("run lock (spec §7.2/§7.3): per-project file lock", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), "pi-workflows-lock-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("a free lock is acquired: the file records runId/pid/host/startedAt", async () => {
    const store = createMemoryStore();
    const lock = createRunLock(fakeEnv({ pid: 111 }), fixedClock("2026-01-01T00:00:00.000Z"));

    const result = await lock.begin("run-a", projectRoot, store);

    expect(result.ok).toBe(true);
    expect(lock.active?.runId).toBe("run-a");
    expect(await readLockFile(projectRoot)).toEqual({ runId: "run-a", pid: 111, host: "host-a", startedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("contention: a second contender with a LIVE pid on the same host is refused, naming the holder — the first acquirer is untouched", async () => {
    const store = createMemoryStore();
    const first = createRunLock(fakeEnv({ pid: 111 }), fixedClock("2026-01-01T00:00:00.000Z"));
    const second = createRunLock(fakeEnv({ pid: 222, isAlive: (pid) => pid === 111 }), fixedClock("2026-01-01T00:01:00.000Z"));

    const won = await first.begin("run-a", projectRoot, store);
    expect(won.ok).toBe(true);

    const lost = await second.begin("run-b", projectRoot, store);
    expect(lost).toMatchObject({ ok: false, reason: "held", holder: { runId: "run-a", pid: 111, host: "host-a" } });
    expect(second.active).toBeUndefined();

    // The file is untouched by the loser — proves the acquire path never overwrites (atomic create, not check-then-write).
    expect(await readLockFile(projectRoot)).toMatchObject({ runId: "run-a", pid: 111 });
  });

  it("a different host is refused regardless of liveness — pid liveness is meaningless across hosts (spec §7.3)", async () => {
    const store = createMemoryStore();
    const holder = createRunLock(fakeEnv({ pid: 111, hostname: "host-a" }), fixedClock("2026-01-01T00:00:00.000Z"));
    await holder.begin("run-a", projectRoot, store);

    // isAlive would say "dead" if consulted — but a foreign host must never consult it at all.
    let consulted = false;
    const contender = createRunLock(
      fakeEnv({
        pid: 222,
        hostname: "host-b",
        isAlive: () => {
          consulted = true;
          return false;
        },
      }),
      fixedClock("2026-01-01T00:01:00.000Z"),
    );

    const result = await contender.begin("run-b", projectRoot, store);
    expect(result).toMatchObject({ ok: false, reason: "foreign-host", holder: { runId: "run-a", host: "host-a" } });
    expect(consulted).toBe(false);
  });

  it("reclaim: a dead pid on the same host is reclaimed, and exactly one crash event is appended to the abandoned run", async () => {
    const store = createMemoryStore();
    const dead = createRunLock(fakeEnv({ pid: 111 }), fixedClock("2026-01-01T00:00:00.000Z"));
    await dead.begin("abandoned-run", projectRoot, store);

    const reclaimer = createRunLock(fakeEnv({ pid: 222, isAlive: (pid) => pid !== 111 }), fixedClock("2026-01-01T00:01:00.000Z"));
    const result = await reclaimer.begin("new-run", projectRoot, store);

    expect(result).toMatchObject({ ok: true, reclaimed: { runId: "abandoned-run", pid: 111 } });
    expect(reclaimer.active?.runId).toBe("new-run");

    // The lock file now names the reclaimer, not the abandoned run.
    expect(await readLockFile(projectRoot)).toMatchObject({ runId: "new-run", pid: 222 });

    // Exactly one crash event, for the abandoned run, and it names the dead pid/host so the message is diagnosable.
    const crashEvents = store.events.filter((event): event is Extract<RunEvent, { type: "run-crashed" }> => event.type === "run-crashed");
    expect(crashEvents).toHaveLength(1);
    expect(crashEvents[0]).toMatchObject({ runId: "abandoned-run" });
    expect(crashEvents[0]?.error).toMatch(/111/);
    expect(crashEvents[0]?.error).toMatch(/host-a/);
  });

  it("reclaim leaves the abandoned run resumable: its derived status is crashed, not stuck blocked/in_progress", async () => {
    const store = createMemoryStore();
    // Simulate an abandoned run mid-execution: run-started + step-started, no completion.
    await store.appendEvent({ type: "run-started", runId: "abandoned-run", workflowName: "w", input: undefined, at: "t0" });
    await store.appendEvent({ type: "step-started", runId: "abandoned-run", stepIndex: 0, stepName: "s", input: undefined, at: "t0" });

    const dead = createRunLock(fakeEnv({ pid: 111 }), fixedClock("2026-01-01T00:00:00.000Z"));
    await dead.begin("abandoned-run", projectRoot, store); // records the (soon-to-be-stale) lock

    const reclaimer = createRunLock(fakeEnv({ pid: 222, isAlive: (pid) => pid !== 111 }), fixedClock("2026-01-01T00:01:00.000Z"));
    await reclaimer.begin("new-run", projectRoot, store);

    expect(deriveRunStatus(await store.loadEvents("abandoned-run"))).toBe("crashed");
  });

  it("atomicity: two concurrent reclaimers of the same stale lock — exactly one wins, exactly one crash event is appended", async () => {
    const store = createMemoryStore();
    const dead = createRunLock(fakeEnv({ pid: 111 }), fixedClock("2026-01-01T00:00:00.000Z"));
    await dead.begin("abandoned-run", projectRoot, store);

    const a = createRunLock(fakeEnv({ pid: 222, isAlive: (pid) => pid !== 111 }), fixedClock("2026-01-01T00:01:00.000Z"));
    const b = createRunLock(fakeEnv({ pid: 333, isAlive: (pid) => pid !== 111 }), fixedClock("2026-01-01T00:01:00.000Z"));

    // Real fs, genuinely concurrent: the atomic `wx` create is the only thing standing between this
    // being a real race and a corrupted/double-reclaimed lock.
    const [resultA, resultB] = await Promise.all([a.begin("run-a", projectRoot, store), b.begin("run-b", projectRoot, store)]);

    const outcomes = [resultA, resultB];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ reason: "contended" });

    const crashEvents = store.events.filter((event) => event.type === "run-crashed" && event.runId === "abandoned-run");
    expect(crashEvents).toHaveLength(1); // not two — only the winner appends
  });

  it("release: end() removes the lock file so a subsequent begin() succeeds", async () => {
    const store = createMemoryStore();
    const lock = createRunLock(fakeEnv({ pid: 111 }), fixedClock("2026-01-01T00:00:00.000Z"));
    await lock.begin("run-a", projectRoot, store);

    await lock.end("run-a", projectRoot);

    expect(lock.active).toBeUndefined();
    await expect(readLockFile(projectRoot)).rejects.toThrow();

    const other = createRunLock(fakeEnv({ pid: 222 }), fixedClock("2026-01-01T00:01:00.000Z"));
    const result = await other.begin("run-b", projectRoot, store);
    expect(result.ok).toBe(true);
  });

  it("release: end() is a no-op when runId is not this lock's current holder", async () => {
    const store = createMemoryStore();
    const lock = createRunLock(fakeEnv({ pid: 111 }), fixedClock("2026-01-01T00:00:00.000Z"));
    await lock.begin("run-a", projectRoot, store);

    await lock.end("some-other-run", projectRoot);

    expect(lock.active?.runId).toBe("run-a"); // untouched
    await expect(readLockFile(projectRoot)).resolves.toBeDefined(); // file still there
  });

  it("acquisition never overwrites: a lock file written outside this lock's own begin() is respected, not clobbered", async () => {
    // Regression for "atomic create, not check-then-write": pre-seed the lock file directly (as if a
    // completely different process wrote it), then confirm begin() detects and refuses it rather than
    // blindly writing over it.
    const store = createMemoryStore();
    const preseeded: LockInfo = { runId: "external-run", pid: 999, host: "host-a", startedAt: "2025-12-31T00:00:00.000Z" };
    await mkdir(path.dirname(lockFilePath(projectRoot)), { recursive: true });
    await writeFile(lockFilePath(projectRoot), JSON.stringify(preseeded));

    const contender = createRunLock(fakeEnv({ pid: 111, isAlive: () => true }), fixedClock("2026-01-01T00:01:00.000Z"));
    const result = await contender.begin("run-a", projectRoot, store);

    expect(result).toMatchObject({ ok: false, reason: "held", holder: preseeded });
    expect(await readLockFile(projectRoot)).toEqual(preseeded); // untouched
  });
});
