/**
 * The per-project execution lock (spec §7.2/§7.3): `<projectRoot>/.<app>/workflows/.run.lock`, holding
 * `{ runId, pid, host, startedAt }`. Replaces the old in-process-only guard (run-guard.ts) — the lock
 * lives in the filesystem, so it holds across concurrent PI sessions on the same project, not just
 * within one process.
 *
 * It stays in the AUTHORING directory (not with the run artifacts) because that directory is what
 * "this project" means — one lock per project, whatever session dir the current invocation happens to
 * be writing to. Dot-prefixed so `ls` on the directory an author works in shows only their own
 * `*.workflow.ts` sources.
 *
 * Host-layer only: the engine (src/engine) never imports this. If the engine ever needs to know
 * about the lock it goes through `HostPort`, per the project's ground rules.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import path from "node:path";
import type { RunEvent } from "../engine/types.ts";
import { workflowsDir } from "./project-dir.ts";
import type { RunStore } from "./types.ts";

/** The lock file's contents while held (spec §7.2). */
export interface LockInfo {
  readonly runId: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
}

/**
 * The two non-deterministic facts a lock decision needs (spec §7.3): who "we" are (pid + hostname),
 * and whether a given pid on THIS host is still alive. Injected so contention and reclaim are testable
 * deterministically and offline — no real process spawning in the unit suite.
 */
export interface ProcessEnv {
  readonly pid: number;
  readonly hostname: string;
  /** Is `pid` (on this host) still alive? Never called for a different host — liveness is meaningless across hosts (spec §7.3). */
  isAlive(pid: number): boolean;
}

/** The real seam: this process's pid/hostname, liveness via a zero-signal `kill` probe (no side effect on a live process). */
export function createProcessEnv(): ProcessEnv {
  return { pid: process.pid, hostname: osHostname(), isAlive: isPidAlive };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but we lack permission to signal it — still alive. Anything else (ESRCH
    // in particular) means no such process.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockFilePath(projectRoot: string): string {
  return path.join(workflowsDir(projectRoot), ".run.lock");
}

/**
 * Exclusive create (spec §7.2: "atomic"): `wx` fails with `EEXIST` if the file already exists, so this
 * is never check-then-write — a second concurrent caller cannot observe "absent" and then overwrite a
 * file the first caller just created.
 */
async function tryCreate(filePath: string, info: LockInfo): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, JSON.stringify(info), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function readLock(filePath: string): Promise<LockInfo | undefined> {
  const content = await readFile(filePath, "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as LockInfo;
  } catch {
    return undefined; // corrupt/partially-written lock file — treat as absent rather than crash the caller
  }
}

export type AcquireResult =
  | { readonly ok: true; readonly reclaimed?: LockInfo }
  | { readonly ok: false; readonly reason: "held"; readonly holder: LockInfo }
  | { readonly ok: false; readonly reason: "foreign-host"; readonly holder: LockInfo }
  | { readonly ok: false; readonly reason: "contended" };

/**
 * Acquire the lock at `filePath` for `info` (spec §7.2/§7.3):
 *  - free                       → create it, `ok: true`.
 *  - held, live pid, same host  → refuse, naming the holder (spec §7.2).
 *  - held, different host       → refuse; pid liveness is meaningless across hosts (spec §7.3).
 *  - held, dead pid, same host  → RECLAIM: delete the stale file, then re-attempt the atomic create.
 *    That second `tryCreate` is the actual tie-break if another contender reclaims the SAME stale lock
 *    concurrently — `unlink` may succeed for both (or fail harmlessly with `ENOENT` for the loser), but
 *    only one `wx` create can win, so only one caller ever gets `reclaimed` back. The caller is
 *    responsible for appending the crash event to the reclaimed run (spec §7.3) — this function only
 *    decides who holds the lock.
 */
async function acquireLock(filePath: string, info: LockInfo, env: ProcessEnv): Promise<AcquireResult> {
  if (await tryCreate(filePath, info)) return { ok: true };

  const existing = await readLock(filePath);
  if (!existing) {
    // The holder released (or we raced a partial write) between our failed create and this read.
    // One more attempt; if it still loses, report contention rather than looping.
    return (await tryCreate(filePath, info)) ? { ok: true } : { ok: false, reason: "contended" };
  }

  if (existing.host !== env.hostname) {
    return { ok: false, reason: "foreign-host", holder: existing };
  }
  if (env.isAlive(existing.pid)) {
    return { ok: false, reason: "held", holder: existing };
  }

  await unlink(filePath).catch(() => {}); // ENOENT here just means another reclaimer beat us to the delete
  return (await tryCreate(filePath, info)) ? { ok: true, reclaimed: existing } : { ok: false, reason: "contended" };
}

async function releaseLock(filePath: string, runId: string): Promise<void> {
  const existing = await readLock(filePath);
  if (existing?.runId === runId) {
    await unlink(filePath).catch(() => {});
  }
}

/** This process's currently held run + its abort signal, if any — the one thing that can meaningfully own a live `AbortController` (mirrors the old in-process guard's shape). */
export interface ActiveRun {
  readonly runId: string;
  readonly controller: AbortController;
}

export type BeginResult =
  | { readonly ok: true; readonly controller: AbortController; readonly reclaimed?: LockInfo }
  | { readonly ok: false; readonly reason: "held"; readonly holder: LockInfo }
  | { readonly ok: false; readonly reason: "foreign-host"; readonly holder: LockInfo }
  | { readonly ok: false; readonly reason: "contended" };

/**
 * The single execution slot per project (spec §7): backed by the file lock, not an in-process flag, so
 * it holds across concurrent PI sessions on the same project (spec §7.2). `active` still tracks only
 * THIS process's own current run, since only the process actually executing can hold a live
 * `AbortController` for `/workflow cancel` to abort.
 *
 * `projectRoot`/`store` are passed per call (like `RunStore` itself), not bound at construction, so one
 * `RunLock` instance can serve the extension's whole lifetime while each command supplies its own
 * per-invocation store.
 */
export interface RunLock {
  readonly active: ActiveRun | undefined;
  /**
   * Acquire the project lock for `runId` (spec §7.2/§7.3). On a successful reclaim of a stale lock,
   * appends a `run-crashed` event to the abandoned run's log via `store` — UNDER the newly acquired
   * lock, before this resolves — leaving it resumable (spec §7.3).
   */
  begin(runId: string, projectRoot: string, store: Pick<RunStore, "appendEvent">): Promise<BeginResult>;
  /** Release the lock (spec §7.1: on completion, crash, cancel, or block). No-op if `runId` is not this process's current holder. */
  end(runId: string, projectRoot: string): Promise<void>;
}

export function createRunLock(env: ProcessEnv = createProcessEnv(), now: () => Date = () => new Date()): RunLock {
  let active: ActiveRun | undefined;

  return {
    get active() {
      return active;
    },
    async begin(runId, projectRoot, store) {
      const filePath = lockFilePath(projectRoot);
      const info: LockInfo = { runId, pid: env.pid, host: env.hostname, startedAt: now().toISOString() };
      const result = await acquireLock(filePath, info, env);
      if (!result.ok) return result;

      if (result.reclaimed) {
        const holder = result.reclaimed;
        const crash: RunEvent = {
          type: "run-crashed",
          runId: holder.runId,
          error: `run abandoned: its process (pid ${holder.pid} on host ${holder.host}) is no longer alive`,
          at: now().toISOString(),
        };
        await store.appendEvent(crash);
      }

      const controller = new AbortController();
      active = { runId, controller };
      return { ok: true, controller, reclaimed: result.reclaimed };
    },
    async end(runId, projectRoot) {
      if (active?.runId !== runId) return;
      await releaseLock(lockFilePath(projectRoot), runId);
      active = undefined;
    },
  };
}
