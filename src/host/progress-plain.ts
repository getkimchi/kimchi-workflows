/**
 * Headless progress (progress §8): one plain, unstyled, append-only line per state transition.
 *
 * This is the surface for `json` and `print` mode — benchmark runs and CI, which is to say the runs
 * that actually matter. Per LESSONS, every serious bug in this project was invisible offline and
 * obvious within one live run, and those live runs are exactly the headless ones; a progress feature
 * that only worked when someone was watching a terminal would miss all of them.
 *
 * Three properties, each load-bearing:
 *
 *  - **Plain words, not glyphs** (§8.1). This stream is read in log files and CI output where the
 *    theme, the width, and often the font are all unknown.
 *  - **stderr, never stdout** (§8.2) — a correctness requirement, not a preference. In JSON mode stdout
 *    IS the event protocol; in print mode it is the assistant's answer, which callers parse.
 *    Interleaving progress into either corrupts a contract someone depends on. The stream is injected
 *    here rather than written directly so that fact is testable, and so nothing in this file can reach
 *    stdout by accident.
 *  - **Append-only, never a redraw** (§8.3). The parent's stderr is shared with everything else in the
 *    process, and cursor movement in a stream being appended to from more than one place corrupts all
 *    of it.
 *
 * A per-event mapping rather than a re-projection: a transition is exactly what an append-only log
 * wants to record, and the panel's collapse/alignment machinery has nothing to contribute to a line.
 */
import type { RunEvent } from "../engine/types.ts"
import { formatClock, formatDuration, formatTokens } from "../progress/render.ts"
import type { Outline, OutlineNode } from "../progress/types.ts"

/** Prefix on every line, so a workflow's output is greppable out of a CI log that carries much else. */
const PREFIX = "[workflow]"

/** Width of the verb column — enough for the longest verb, so the names below it line up. */
const VERB = 5

/** Where a headless line goes. Injected so a test can capture it and so stdout is unreachable from here. */
export type LineWriter = (line: string) => void

export interface PlainProgress {
	accept(event: RunEvent): void
}

/**
 * A headless line writer for one run. `outline` supplies the one fact the log does not carry on its
 * own — a loop's declared `maxIterations`, so `iteration 2/10` can say how close the guard is.
 */
export function createPlainProgress(outline: Outline, write: LineWriter): PlainProgress {
	const guards = loopGuards(outline)
	const startedAt = new Map<string, number>()
	const tokens = new Map<string, number>()
	const settled = new Set<string>()
	let runStartedAt: number | undefined
	let runTokens = 0

	const took = (path: string, at: string): string | undefined => {
		const from = startedAt.get(path)
		return from === undefined ? undefined : formatDuration(ms(at) - from)
	}

	const spent = (path: string): string | undefined => {
		const total = tokens.get(path)
		return total ? `${formatTokens(total)} tok` : undefined
	}

	const closing = (verdict: string, at: string): string => {
		const elapsed = runStartedAt === undefined ? undefined : formatClock(ms(at) - runStartedAt)
		return `${PREFIX} ${[verdict, `${settled.size} steps`, elapsed, runTokens > 0 ? `${formatTokens(runTokens)} tok` : undefined].filter(Boolean).join(" · ")}`
	}

	return {
		accept(event: RunEvent): void {
			switch (event.type) {
				case "run-started":
					runStartedAt = ms(event.at)
					write(`${PREFIX} ${event.workflowName} ${event.runId} started`)
					break
				case "run-resumed":
					runStartedAt = ms(event.at)
					write(`${PREFIX} ${event.runId} resumed`)
					break
				case "step-started":
					startedAt.set(event.path, ms(event.at))
					write(step("run", event.path))
					break
				case "step-completed":
					settled.add(event.path)
					write(step("done", event.path, [took(event.path, event.at), spent(event.path)]))
					break
				case "step-failed":
					settled.add(event.path)
					write(`${step("fail", event.path, [took(event.path, event.at), "optional"])} ${event.error}`)
					break
				case "step-cancelled":
					settled.add(event.path)
					write(step("stop", event.path))
					break
				case "step-retry":
					write(`${step("retry", event.path, [`attempt ${event.attempt}`])} ${event.reason}`)
					break
				case "questionnaire-asked":
					write(step("wait", event.path, [`${event.questionnaire.questions.length} questions`]))
					break
				case "answers-provided":
					startedAt.set(event.path, ms(event.at))
					write(step("run", event.path, ["answered"]))
					break
				case "loop-iteration": {
					const guard = guards.get(loopKeyOf(event.path))
					write(
						step("loop", loopKeyOf(event.path), [
							`iteration ${event.iteration}${guard === undefined ? "" : `/${guard}`}`,
						]),
					)
					break
				}
				case "foreach-started":
					write(step("each", event.path, [`${event.count} items`]))
					break
				case "branch-arm":
					// Only the skip is news: a TAKEN arm announces itself through its own steps' lines.
					if (!event.taken) {
						settled.add(event.path)
						write(step("skip", event.path))
					}
					break
				case "agent-usage":
					tokens.set(event.path, (tokens.get(event.path) ?? 0) + event.totalTokens)
					runTokens += event.totalTokens
					break
				case "run-completed":
					write(closing("completed", event.at))
					break
				case "run-crashed":
					write(`${closing("crashed", event.at)} — ${event.error}`)
					break
				case "run-cancelled":
					write(closing("cancelled", event.at))
					break
				default:
					break // run-meta, node lifecycle, foreach items, step-log: the lines above already cover the work
			}
		},
	}
}

/** `  done  until-green#2/test (18.2s, 4.1k tok)` — verb column, path, then whatever qualifies it. */
function step(verb: string, path: string, details: readonly (string | undefined)[] = []): string {
	const shown = details.filter((detail): detail is string => detail !== undefined && detail.length > 0)
	return `${PREFIX}   ${verb.padEnd(VERB)} ${path}${shown.length > 0 ? ` (${shown.join(", ")})` : ""}`
}

/** A loop-iteration event's path is the iteration (`until-green#2`); its guard is declared on the loop. */
function loopKeyOf(path: string): string {
	const cut = path.lastIndexOf("#")
	return cut === -1 ? path : path.slice(0, cut)
}

/** Every loop's declared `maxIterations`, keyed by static path — the one thing the log does not carry. */
function loopGuards(outline: Outline): Map<string, number> {
	const guards = new Map<string, number>()
	const visit = (nodes: readonly OutlineNode[]): void => {
		for (const node of nodes) {
			if (node.kind === "loop" && node.maxIterations !== undefined) guards.set(node.path, node.maxIterations)
			visit(node.children)
		}
	}
	visit(outline.nodes)
	return guards
}

function ms(iso: string): number {
	const parsed = Date.parse(iso)
	return Number.isNaN(parsed) ? 0 : parsed
}
