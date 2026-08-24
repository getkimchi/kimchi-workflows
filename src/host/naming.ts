/**
 * The filenames this package owns, and the one identity they are all derived from.
 *
 * A run used to be a `randomUUID()`. That id was the event log's name, and nothing else — step sessions
 * were named after the step, in a directory of their own. Now that a run's artifacts sit in the
 * harness's session directory (project-dir.ts) alongside the user's own sessions, every name this
 * package writes is read by a human at some point: in `/workflow run list`, in a session picker, in an
 * `ls`. So the run id is a SLUG — `workflow-<workflow-identity>-<8 hex>` — and it is the single identity
 * behind all of them: the event log is `<runId>.events.jsonl`, a step's trace session embeds the id's
 * hash, and `resume`/`cancel`/`delete` take the same string back (a prefix of it is enough, see
 * {@link matchRunId}). The `workflow-` prefix is what makes "everything a workflow run wrote" a glob.
 *
 * Names are sanitized rather than trusted: a runtime workflow identity and a node path go straight
 * into path segments (spec §3, §8.5). `.commit()` already rejects path syntax in a step NAME, but a
 * node path legitimately contains `/`, `#` and `@` (node-path.ts's separators), and explicit workflow
 * files can still have names the filesystem utilities below need to normalize.
 *
 * Host-layer only: the engine never sees these — it addresses everything by node path (spec §8.5).
 */
import { createHash, randomBytes } from "node:crypto"

/**
 * How much of a workflow's runtime identity a filename carries. Long enough to identify, short enough that
 * the id stays typeable — and, like a node path, TAGGED when it is truncated (see {@link capWithHash}).
 * A run id could get away without the tag, since it carries 8 random hex of its own; a resumable step's
 * session file could not. That name deliberately has no run component (see {@link resumeSessionFile}),
 * so for two workflows whose names agree for this many characters, plain truncation would leave nothing
 * at all to tell them apart: `release-…-service-alpha` and `release-…-service-beta` would share one
 * session file, and one workflow's worker would resume holding the other's conversation.
 */
const WORKFLOW_NAME_MAX = 40

/**
 * How much of a node path a session filename carries. Deep paths are real (`until-valid#3/batch@7/review`)
 * and a foreach over a long list produces many that differ only near the END — so an over-cap path is
 * truncated AND tagged with a hash of the whole thing, since plain truncation would collide silently and
 * hand two different items one session file.
 */
const NODE_PATH_MAX = 120

/** The random tail of a run id, and therefore the run's short form everywhere it appears. */
const RUN_HASH_LENGTH = 8

/** How much hash is appended to a truncated (or otherwise unrepresentable) name — enough to separate, not enough to dominate. */
const NAME_HASH_LENGTH = 6

/** Give up minting rather than spin: 8 consecutive collisions on 32 random bits is not a collision, it is a broken `isTaken`. */
const MINT_ATTEMPTS = 8

/**
 * Reduce an arbitrary author-supplied string to one filesystem-safe path segment: lowercase, anything
 * outside `[a-z0-9._-]` becomes `-`, runs of `-` collapse, leading/trailing `-` go. May return `""` (a
 * name made entirely of separators or non-ASCII); callers pass the result through {@link orHash} so a
 * name that survives sanitization as nothing still produces a distinct, stable filename.
 */
export function sanitizeSegment(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
}

function hashOf(raw: string, length: number): string {
	return createHash("sha256").update(raw).digest("hex").slice(0, length)
}

/** A sanitized name, or — when sanitization left nothing at all — a hash of the original, so distinct inputs stay distinct. */
function orHash(sanitized: string, raw: string): string {
	return sanitized || hashOf(raw, NAME_HASH_LENGTH)
}

/**
 * Cap a name at `max`, and tag any truncation with a hash of the ORIGINAL string.
 *
 * The tag is the whole point: names that need capping are long precisely because they are descriptive,
 * which is also what makes them likely to agree for their first `max` characters — a deep foreach path
 * differing only at its leaf, two workflows in one repo named for the same service. Plain truncation
 * maps those onto ONE filename, and a filename is an identity here: a shared session file means one
 * step resumes another's conversation. Truncate-and-tag keeps the readable prefix and restores the
 * distinction the truncation threw away.
 */
function capWithHash(sanitized: string, raw: string, max: number): string {
	if (sanitized.length <= max) return sanitized
	return `${sanitized.slice(0, max).replace(/-+$/, "")}-${hashOf(raw, NAME_HASH_LENGTH)}`
}

/** A workflow's runtime identity as it appears in a run id / session filename: sanitized, capped, tagged if truncated. */
export function sanitizeWorkflowName(identity: string): string {
	return capWithHash(orHash(sanitizeSegment(identity), identity), identity, WORKFLOW_NAME_MAX)
}

/**
 * A node path (spec §8.5) as it appears in a session filename. The separators are transliterated before
 * sanitizing — `/`→`.`, `#`→`-`, `@`→`-` — rather than being flattened to `-` along with everything
 * else, so the path's shape survives: `batch@7/review` reads as `batch-7.review`, not as one anonymous
 * run of dashes. An over-cap path is truncated and tagged ({@link capWithHash}), which is what keeps
 * two deep foreach items apart when their prefixes are identical.
 */
export function sanitizeNodePath(nodePath: string): string {
	const flattened = nodePath.replace(/\//g, ".").replace(/[#@]/g, "-")
	return capWithHash(orHash(sanitizeSegment(flattened), nodePath), nodePath, NODE_PATH_MAX)
}

/** A run id's random tail — the short form a user can type instead of the whole slug (see {@link matchRunId}). */
export function runIdHash(runId: string): string {
	return runId.slice(-RUN_HASH_LENGTH)
}

/**
 * Mint a run id: `workflow-<workflow-identity>-<8 hex>` (spec §8.9 — the id the whole run is keyed by).
 *
 * `isTaken` is asked before the id is used, because unlike a UUID this one is only 32 random bits behind
 * a name many runs share — a project that runs the same workflow often WILL collide eventually, and a
 * collision is not cosmetic: the second run would append its events onto the first run's log and both
 * would then read as one incoherent run. `hex` is injectable so the retry path is testable without
 * waiting for a real 1-in-4-billion event.
 */
export async function mintRunId(
	workflowIdentity: string,
	isTaken: (runId: string) => Promise<boolean>,
	hex: () => string = randomHex,
): Promise<string> {
	const stem = `workflow-${sanitizeWorkflowName(workflowIdentity)}`
	for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
		const candidate = `${stem}-${hex()}`
		if (!(await isTaken(candidate))) return candidate
	}
	throw new Error(`could not mint a free run id for workflow "${workflowIdentity}" after ${MINT_ATTEMPTS} attempts`)
}

function randomHex(): string {
	return randomBytes(RUN_HASH_LENGTH / 2).toString("hex")
}

/**
 * The session file a `resumable` step continues across runs (spec §2.2): `workflow-<wf>-key-<key>.jsonl`.
 *
 * Deliberately carries NO run component. `resumeKey` exists precisely to span executions — a worker
 * time-boxed out of one round and re-run in the next must pick up where it left off — so mixing the run
 * id in would give every run a fresh file and turn `resumable` into a silent no-op.
 */
export function resumeSessionFile(workflowName: string, resumeKey: string): string {
	return `workflow-${sanitizeWorkflowName(workflowName)}-key-${sanitizeNodePath(resumeKey)}.jsonl`
}

/**
 * The session file a NON-resumable execution records itself into (spec §2.2):
 * `workflow-<wf>-run-<hash>-<path>-a<attempt>.jsonl`. Unique per execution — a fresh look at the world
 * is the point of an isolated step — but no longer thrown away, so what a step was told, replied and
 * spent stays readable afterwards.
 *
 * The `-run-` / `-key-` infixes keep the two namespaces structurally disjoint: no step name, path or
 * author-chosen key can make a trace collide with a keyed session, whatever it is called. That guarantee
 * used to come from putting traces in a `traces/` subdirectory, which is gone — everything a run writes
 * now lives in one flat directory beside the harness's own sessions.
 */
export function traceSessionFile(workflowName: string, runId: string, nodePath: string, attempt: number): string {
	return `workflow-${sanitizeWorkflowName(workflowName)}-run-${runIdHash(runId)}-${sanitizeNodePath(nodePath)}-a${attempt}.jsonl`
}

/** The display name a spawned step session is launched with (`--name`), so it reads as something in a picker rather than as a filename. */
export function stepSessionName(workflowName: string, nodePath: string, runId: string): string {
	return `${workflowName}/${nodePath} #${runIdHash(runId)}`
}

/** How a `/workflow resume|cancel|delete` argument resolved against the runs actually on disk. */
export type RunIdMatch =
	| { readonly kind: "ok"; readonly runId: string }
	| { readonly kind: "unknown" }
	| { readonly kind: "ambiguous"; readonly candidates: readonly string[] }

/**
 * Resolve a user-typed run reference (spec §6.2/§6.4/§6.5): exact id, then the 8-hex tail alone, then
 * any unique prefix. Mirrors the harness's own session lookup, which tries an exact id before falling
 * back to `startsWith` — a user who just watched `/workflow run list` print
 * `workflow-deploy-3f2a1c4b` should be able to type `3f2a1c4b`.
 *
 * Exact wins outright, so a run id that happens to be a prefix of another is always addressable. Anything
 * short enough to match several runs is reported AMBIGUOUS with the candidates rather than resolved by
 * picking one — the operations behind this are cancel and delete.
 */
export function matchRunId(known: readonly string[], arg: string): RunIdMatch {
	if (arg.length === 0) return { kind: "unknown" }
	if (known.includes(arg)) return { kind: "ok", runId: arg }

	for (const candidates of [known.filter((id) => runIdHash(id) === arg), known.filter((id) => id.startsWith(arg))]) {
		if (candidates.length === 1) return { kind: "ok", runId: candidates[0] as string }
		if (candidates.length > 1) return { kind: "ambiguous", candidates }
	}
	return { kind: "unknown" }
}
