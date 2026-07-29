/**
 * The real candidate sources behind `/workflow` completion (spec §14.6/§14.7) — the only part of the
 * feature that touches a disk, so completions.ts can stay pure.
 *
 * Both sources run on a keystroke, which dictates their shape:
 *
 *  - **Workflow names come from filenames, never an import.** `discoverWorkflows` (spec §6.8) imports
 *    every candidate module through a fresh loader to read its declared name; per keystroke that
 *    recompiles the project's workflows and re-executes their module bodies. One `readdir` and a suffix
 *    strip execute nothing. The cost is that a workflow whose declared name differs from its filename is
 *    not completable — it stays listable and runnable, and the convention it breaks is the one §6.8
 *    already asks for.
 *  - **The run listing is memoized for one second.** Listing parses every run's log, so a burst of
 *    keystrokes must cost one read; one second is short enough that nothing has to invalidate it after a
 *    run starts, is cancelled, or is deleted (spec §14.6).
 *
 * The location is captured rather than resolved per call because the completion callback is handed no
 * context at all — no `cwd`, no session manager, no store (spec §14.2). It captures BOTH values the
 * command handler builds its store from (spec §14.7): authored workflows are keyed by project root
 * (§6.8) and a run's artifacts by the harness's session directory (§8.9), and `runArtifactsDir` needs
 * the pair to resolve either way. The extension re-captures them from every `session_start`; this copy
 * exists for completion only, and the handlers keep resolving from their own invocation's context.
 */
import { readdir } from "node:fs/promises"
import type { CompletionSources } from "./completions.ts"
import { createFsStore } from "./fs-store.ts"
import { runArtifactsDir, workflowsDir } from "./project-dir.ts"
import type { RunSummary } from "./types.ts"
import { WORKFLOW_SUFFIX } from "./workflow-catalog.ts"

/** How long one run listing is reused for (spec §14.6). */
const RUNS_MEMO_MS = 1000

/** Completion sources bound to a location the extension re-points on every session start. */
export interface ProjectCompletionSources extends CompletionSources {
	/** Point the sources at the project and session directory of the session that just started (spec §14.7). */
	setProject(cwd: string, sessionDir: string): void
}

export function createCompletionSources(): ProjectCompletionSources {
	// The pre-first-start fallback (spec §14.7): a keystroke cannot wait for `session_start`, and an empty
	// session dir is exactly what `--no-session` hands the handlers, which `runArtifactsDir` already covers.
	let cwd = process.cwd()
	let sessionDir = ""
	let memo: { at: number; runs: Promise<readonly RunSummary[]> } | undefined

	return {
		setProject(nextCwd: string, nextSessionDir: string): void {
			cwd = nextCwd
			sessionDir = nextSessionDir
			memo = undefined // the memo holds another location's runs
		},

		async workflows(): Promise<readonly string[]> {
			const entries = await readdir(workflowsDir(cwd)).catch(() => [] as string[])
			return entries
				.filter((entry) => entry.endsWith(WORKFLOW_SUFFIX))
				.map((entry) => entry.slice(0, -WORKFLOW_SUFFIX.length))
		},

		runs(): Promise<readonly RunSummary[]> {
			const at = Date.now()
			if (!memo || at - memo.at >= RUNS_MEMO_MS) {
				// Completion is advisory (spec §14.1): a corrupt or unreadable log costs the user suggestions,
				// never the keystroke.
				memo = {
					at,
					runs: createFsStore(runArtifactsDir(cwd, sessionDir))
						.list()
						.catch(() => []),
				}
			}
			return memo.runs
		},
	}
}
