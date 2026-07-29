/**
 * Argument completion for `/workflow` (spec §14): the grammar, the filtering, and the value assembly.
 *
 * Pure by design (spec §14.8) — no filesystem, no store, no PI session. The candidate sources are
 * injected, so the feature is testable exactly like the engine is and the extension is left holding
 * only the wiring (see completion-sources.ts).
 *
 * Two properties of PI's seam shape everything below (spec §14.2). The callback is handed the WHOLE
 * argument text up to the cursor, not the token under it; and the chosen `value` REPLACES that whole
 * text, with no trailing space appended. So every `value` is a full argument string (`"run
 * review-loop"`), `label` carries the short form the popup lists, and a verb that takes an argument has
 * to insert its own separating space or the user lands mid-token with the popup closed (spec §14.3).
 *
 * Completion is advisory (spec §14.1): it never validates, and every handler keeps checking its own
 * argument. What it does owe the user is that a *completed* argument is one the command will accept —
 * hence the per-verb status filters, which are derived from the predicates the handlers themselves use
 * rather than restated here.
 */
import { isLiveRun } from "./commands/lifecycle.ts"
import { type RunStatus, resumeAction } from "./resume-router.ts"
import type { RunSummary } from "./types.ts"

/** One popup row; structurally PI's `AutocompleteItem` (spec §14.2). */
export interface CompletionItem {
	/** The WHOLE argument text this replaces (spec §14.2), e.g. `"run review-loop"`. */
	readonly value: string
	/** The bare candidate, as listed in the popup. */
	readonly label: string
	/** Single-line annotation, rendered dimmed and only in a popup wider than 40 columns (spec §14.2). */
	readonly description?: string
}

/**
 * Where candidates come from. Both are read on a keystroke, so an implementation must be cheap and
 * read-only (spec §14.6); neither is expected to sort or cap — this module does both.
 */
export interface CompletionSources {
	/** Workflow names, already filename-derived (spec §14.6). Any order: sorted by name here. */
	workflows(): Promise<readonly string[]>
	/** Every recorded run, in any order: ordered newest-first here by `startedAt` (spec §14.5). */
	runs(): Promise<readonly RunSummary[]>
}

/** A verb of the `/workflow` grammar (spec §6), and what completing it inserts. */
interface Verb {
	readonly name: string
	/** Verbs taking an argument insert the separating space themselves (spec §14.4). */
	readonly takesArgument: boolean
	readonly description: string
}

/** The verb slot (spec §14.4), in the order §6 introduces them. */
const VERBS: readonly Verb[] = [
	{ name: "run", takesArgument: true, description: "start a workflow, or `run list` for recorded runs" },
	{ name: "create", takesArgument: false, description: "generate a new workflow by interview" },
	{ name: "list", takesArgument: false, description: "the workflows this project defines" },
	{ name: "status", takesArgument: true, description: "show a run's tree — the executing one when bare" },
	{ name: "resume", takesArgument: true, description: "continue a blocked, crashed, or cancelled run" },
	{ name: "cancel", takesArgument: true, description: "stop an executing or blocked run" },
	{ name: "delete", takesArgument: true, description: "permanently remove a stopped run" },
]

/** Reserved as `run`'s first argument, so it can never name a workflow (spec §6.3). */
const RESERVED_RUN_LIST = "list"

/** Runs accumulate until deleted (spec §6.5) and the interesting one is recent (spec §14.5). */
const MAX_RUN_ITEMS = 20

/**
 * Complete the argument text of `/workflow` (spec §14.4). `argumentPrefix` is everything after the
 * command name up to the cursor. Returns `null` — never `[]` — when there is nothing to offer, which
 * is what PI reads as "no popup" (spec §14.2).
 */
export async function completeWorkflowArgument(
	argumentPrefix: string,
	sources: CompletionSources,
): Promise<CompletionItem[] | null> {
	const tokens = argumentPrefix.split(/\s+/).filter(Boolean)

	// The cursor is still inside the last token only while the text does not end in a space; a trailing
	// space has already moved it on to the next slot, which is then being completed from empty.
	const insideToken = !/\s$/.test(argumentPrefix)
	const typed = insideToken ? (tokens.at(-1) ?? "") : ""
	const settled = insideToken ? tokens.slice(0, -1) : tokens

	const [verb] = settled
	if (verb === undefined) return verbItems(typed)
	if (settled.length > 1) return null // a second argument onward completes nothing (spec §14.4)
	return argumentItems(verb, typed, sources)
}

function verbItems(typed: string): CompletionItem[] | null {
	const matched = matching(VERBS, typed, (verb) => verb.name)
	return popup(
		matched.map((verb) => ({
			value: verb.takesArgument ? `${verb.name} ` : verb.name,
			label: verb.name,
			description: verb.description,
		})),
	)
}

/** The second slot: what each verb's own argument may be (spec §14.4). */
async function argumentItems(
	verb: string,
	typed: string,
	sources: CompletionSources,
): Promise<CompletionItem[] | null> {
	switch (verb) {
		case "run":
			return workflowItems(verb, typed, await sources.workflows())
		case "status":
			// No status filter: a run's tree is rebuilt from its log alone, so any recorded run can be shown,
			// live or long finished (progress §11.4). The id is optional there — bare means the executing run —
			// but a run that is not executing has no other way in, which is exactly what completing it buys.
			return runItems(verb, typed, await sources.runs(), () => true)
		case "resume":
			// Exactly the statuses `/workflow resume` accepts (spec §5.2/§6.2), asked of the router itself.
			return runItems(verb, typed, await sources.runs(), (status) => resumeAction(status).kind !== "error")
		case "cancel":
			return runItems(verb, typed, await sources.runs(), isLiveRun)
		case "delete":
			return runItems(verb, typed, await sources.runs(), (status) => !isLiveRun(status))
		default:
			return null // `create`, `list`, and anything unrecognised take no argument (spec §14.4)
	}
}

/**
 * `run`'s argument: the reserved `list` first (spec §6.3), then workflow names by name (spec §14.5).
 * The set is deduplicated so a `list.workflow.ts` cannot shadow the reserved word. No descriptions —
 * for a workflow the name *is* the file (spec §14.6).
 */
function workflowItems(verb: string, typed: string, workflows: readonly string[]): CompletionItem[] | null {
	const candidates = [...new Set([RESERVED_RUN_LIST, ...[...workflows].sort()])]
	return popup(matching(candidates, typed, (name) => name).map((name) => ({ value: `${verb} ${name}`, label: name })))
}

/**
 * A run-id argument, filtered to the statuses `verb` accepts, newest first, capped after filtering so
 * typing narrows into older runs (spec §14.5). The description is what makes an opaque id meaningful:
 * workflow name, status, current step (spec §6.3) — the columns `/workflow run list` shows.
 */
function runItems(
	verb: string,
	typed: string,
	runs: readonly RunSummary[],
	accepts: (status: RunStatus) => boolean,
): CompletionItem[] | null {
	const eligible = runs.filter((run) => accepts(run.status)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
	const matched = matching(eligible, typed, (run) => run.runId).slice(0, MAX_RUN_ITEMS)
	return popup(
		matched.map((run) => ({
			value: `${verb} ${run.runId}`,
			label: run.runId,
			description: `${run.workflowName}  ${run.status}  step=${run.currentStep ?? "-"}`,
		})),
	)
}

/**
 * Case-insensitive prefix match, falling back to substring (spec §14.5): the substring pass runs only
 * when nothing has the typed text as a prefix, so `r` offers `run`/`resume` rather than burying them
 * under every verb containing an r. Order is never rearranged — ties keep the source order.
 */
function matching<T>(candidates: readonly T[], typed: string, key: (candidate: T) => string): T[] {
	if (typed === "") return [...candidates]
	const needle = typed.toLowerCase()
	const prefixed = candidates.filter((candidate) => key(candidate).toLowerCase().startsWith(needle))
	return prefixed.length > 0
		? prefixed
		: candidates.filter((candidate) => key(candidate).toLowerCase().includes(needle))
}

/** `[]` is a popup with nothing in it; PI wants `null` for "no popup" (spec §14.2). */
function popup(items: CompletionItem[]): CompletionItem[] | null {
	return items.length > 0 ? items : null
}
