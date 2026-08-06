/**
 * Shared execution state and per-run helpers for the engine. Pure — no PI/fs/network.
 */
import type { Questionnaire } from "../flow/questionnaire.ts"
import type { RunContext, ScopeFrame, StepLogger, WorkflowNode } from "../flow/types.ts"
import { nodeName } from "../flow/types.ts"
import { formatPath, type NodePath, staticPathOf } from "./node-path.ts"
import type { ConcurrencyGate } from "./scheduler.ts"
import type { HostPort } from "./types.ts"

/**
 * A step currently `blocked` elsewhere in the SAME concurrent construct, discovered from the log at
 * the top of a resume (spec §8.6): re-entry into one sibling must leave every OTHER pending one exactly
 * as it was — not restarted, not silently dropped — and report whichever remains next once the target
 * settles. `path` is the step's full DYNAMIC path (needed to navigate back into it later).
 */
export interface PendingBlock {
	readonly path: string
	readonly questionnaire: Questionnaire
	readonly conversation: readonly unknown[]
}

/** Immutable run identity + the mutable shared run context (`stepOutputs`) threaded through the node tree. */
export interface RunState {
	readonly runId: string
	readonly workflowName: string
	readonly initialInput: unknown
	/**
	 * Prior node/step outputs, keyed by STATIC node path (spec §5.4: loop iteration indices dropped,
	 * foreach item indices KEPT — see node-path.ts's module header) — a live view backing
	 * `ctx.getStepResult`, mutated as nodes complete.
	 */
	readonly stepOutputs: Map<string, unknown>
	/**
	 * Steps currently EXECUTING (spec §3.9), keyed the same way as `stepOutputs`. A step is added when it
	 * starts (fresh or answer-continuation) and removed the instant it settles (ok/blocked/crashed/
	 * cancelled) — `ctx.getStepResult` THROWS rather than returning `undefined` for a key present here,
	 * since a concurrent read cannot honestly observe an in-flight step (§3.9's "reads never race").
	 */
	readonly inFlight: Set<string>
	/**
	 * The run-wide concurrency ceiling (spec §3.6), one instance per run/resume call, shared by every
	 * construct — including nested workflows, which inherit it verbatim rather than creating their own
	 * (spec: "nested workflows inherit the root run's ceiling").
	 */
	readonly concurrencyGate: ConcurrencyGate
	/** Workflow default model for agent steps that declare none (spec §9.5). */
	readonly defaultModel?: string
	/**
	 * Resume-only (spec §8.2/§8.5): every foreach's recorded per-item outputs, keyed by the foreach's
	 * own DYNAMIC path (no item index — e.g. `until-valid#3/batch`), each value a map of item index →
	 * output. Lets ANY foreach in the tree — not just a top-level one — skip its completed items on
	 * resume, whether re-entering deep inside it (spec §8.5) or restarting it node-atomically (§8.2).
	 */
	readonly foreachItemHistory?: ReadonlyMap<string, ReadonlyMap<number, unknown>>
	/**
	 * Resume-only (spec §8.6): every step CURRENTLY blocked in the log, keyed by STATIC key, at the
	 * moment this resume began. A concurrent construct's re-entry consults this to recognize a sibling
	 * (not the re-entry target) that is still pending — left untouched — and, after the target settles,
	 * to report the NEXT one (FIFO by original ask order) if any remain. The re-entry TARGET itself is
	 * deleted from this map by the caller before execution starts, since it is being resolved right now.
	 */
	readonly pendingBlocks?: ReadonlyMap<string, PendingBlock>
	/**
	 * Names addressable from each scope (names-only addressing, spec 4.2), keyed by the scope's name
	 * chain (indices stripped, `/`-joined, `""` for the root) — built once per `execute()` from the
	 * definition by {@link buildDeclaredNameIndex}. What lets `getStepResult` prove an unknown name is a
	 * wiring bug (throw) while a declared-but-absent one stays a legitimate `undefined`.
	 */
	readonly nameIndex: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Walk the committed tree and enumerate, per scope, the names a bare `getStepResult` may resolve there
 * (names-only addressing, spec 4.2). Mirrors `assertScopeNames`' pools exactly (create-workflow.ts): a
 * branch contributes its own name AND its arm names to the enclosing scope (arms are PEER scopes, spec
 * §8.5), while a parallel contributes only its own name — its arms form their own child scope. Scope
 * keys carry no indices: membership is a property of the definition, not of a particular iteration or
 * item; value lookups keep using the static keys (foreach `@i` preserved).
 */
export function buildDeclaredNameIndex(nodes: readonly WorkflowNode[]): Map<string, ReadonlySet<string>> {
	const index = new Map<string, Set<string>>()
	const childChain = (chain: string, name: string) => (chain === "" ? name : `${chain}/${name}`)
	const scopeNames = (chain: string): Set<string> => {
		const existing = index.get(chain)
		if (existing) return existing
		const created = new Set<string>()
		index.set(chain, created)
		return created
	}

	const walk = (scope: readonly WorkflowNode[], chain: string): void => {
		const names = scopeNames(chain)
		for (const node of scope) {
			if (node.kind === "branch") {
				names.add(node.name)
				for (const arm of node.arms) {
					names.add(arm.name)
					walk(arm.body.nodes, childChain(chain, arm.name))
				}
			} else if (node.kind === "parallel") {
				names.add(node.name)
				const armScope = scopeNames(childChain(chain, node.name))
				for (const arm of node.arms) armScope.add(arm.name)
			} else {
				names.add(nodeName(node))
				if (node.kind === "loop" || node.kind === "foreach") walk(node.body.nodes, childChain(chain, node.name))
				else if (node.kind === "workflow") walk(node.workflow.nodes, childChain(chain, node.name))
			}
		}
	}

	walk(nodes, "")
	return index
}

/** Outcome of running a step under its policies (step-runner). Identity (`path`) is attached by the caller. */
export type StepOutcome =
	| { kind: "ok"; output: unknown }
	| { kind: "crashed"; error: string }
	| { kind: "cancelled" }
	// A step asked a `questions` batch (spec §10): the run blocks. `conversation` resumes the same loop.
	// `violation` is set only when a questionnaire step re-blocks because the delivered answers were
	// invalid. `elapsedMs`/`tokensUsed` (agent Q&A steps only, spec §9.4) are this attempt's running
	// budget totals at the moment of blocking — recorded onto the `questionnaire-asked` event so a later
	// answer-continuation can carry them forward instead of resetting (see types.ts's event comment).
	| {
			kind: "blocked"
			questionnaire: Questionnaire
			conversation: readonly unknown[]
			violation?: string
			elapsedMs?: number
			tokensUsed?: number
	  }

/** Outcome of executing a node or a node sequence. `ok` carries the value handed to the next node. */
export type ExecOutcome =
	| { kind: "ok"; output: unknown }
	| { kind: "crashed"; error: string; path?: string }
	| { kind: "cancelled"; path?: string }
	| {
			kind: "blocked"
			path: string
			questionnaire: Questionnaire
			conversation: readonly unknown[]
			violation?: string
	  }

/**
 * Answer-resume hint for a blocked Q&A step (spec §8.4/§8.5): reconstruct the step's session from
 * `conversation` and replay `answer` — continuing the SAME agent loop rather than re-running the step.
 * Lives here (not execute.ts) so both execute.ts and concurrent-nodes.ts can depend on it without
 * either importing the other (see {@link NodeWalker}).
 */
export interface AnswerResume {
	readonly answers: Record<string, unknown>
	readonly conversation: readonly unknown[]
	/**
	 * Budget carry across the block (spec §9.4): wall time spent `in_progress` and tokens used so far
	 * THIS attempt, read back from the `questionnaire-asked` event that recorded them. The continuation
	 * picks its budgets up from here instead of starting fresh — only a genuinely new retry attempt
	 * resets them (spec §9.1). Absent for a questionnaire step, which has no budget policy at all.
	 */
	readonly elapsedMs?: number
	readonly tokensUsed?: number
}

/**
 * Deep re-entry (spec §8.5): `path` is the REMAINING node-path segments from "here" down to the
 * blocked step, each construct popping its own leading segment before recursing into its
 * body/arm/iteration/item. When `path` is fully consumed (length 0) the current node IS the target: a
 * step applies `answer` (continuing its conversation) if present, or — for `resumeWorkflow`'s node-atomic
 * restart (spec §8.2/§8.3), which never carries an `answer` — simply runs fresh. A construct node
 * (branch/loop/foreach/parallel/workflow) with an EXHAUSTED path always restarts fresh (only a step can
 * be the final blocked target); one still descending (`path.length > 0`) skips re-emitting its own
 * "started" event, since it was already recorded before the run blocked.
 */
export interface Reentry {
	readonly path: NodePath
	readonly answer?: AnswerResume
}

/**
 * The two recursion points concurrent-nodes.ts needs back into execute.ts's node walker
 * (`runNodeSequence` for a foreach item's/parallel arm's body, `runStepNode` for a parallel arm itself,
 * `leafNameOf` to read a re-entry's next hop) — passed in rather than imported, so the two files stay a
 * one-directional dependency (execute.ts → concurrent-nodes.ts) instead of an import cycle.
 */
export interface NodeWalker {
	runNodeSequence(
		nodes: readonly import("../flow/types.ts").WorkflowNode[],
		host: HostPort,
		state: RunState,
		previousOutput: unknown,
		signal: AbortSignal,
		parentPath: NodePath,
		frames: readonly ScopeFrame[],
		startIndex?: number,
		reentry?: Reentry,
	): Promise<ExecOutcome>
	runStepNode(
		step: import("../flow/types.ts").StepDefinition,
		input: unknown,
		host: HostPort,
		state: RunState,
		signal: AbortSignal,
		parentPath: NodePath,
		frames: readonly ScopeFrame[],
		reentry?: Reentry,
	): Promise<ExecOutcome>
	leafNameOf(reentry: Reentry): string
}

export function iso(host: HostPort): string {
	return host.now().toISOString()
}

/**
 * Emit a construct's `node-completed` checkpoint (spec §8): the event every branch arm, branch, loop,
 * foreach, parallel, and nested workflow closes with, and the one a resume reads back to recover that
 * construct's output without re-running it (`rebuildStepOutputs`, resume-workflow.ts). One helper, so
 * the nine places that close a construct — spread across execute.ts and concurrent-nodes.ts — cannot
 * drift in shape.
 */
export async function emitNodeCompleted(
	host: HostPort,
	state: RunState,
	path: NodePath,
	output: unknown,
): Promise<void> {
	await host.emit({ type: "node-completed", runId: state.runId, path: formatPath(path), output, at: iso(host) })
}

/**
 * Build the run context a step body / condition / selector sees (spec §2.5/§3.9). `callerParentPath`
 * is the CALLING node's own enclosing scope (its ancestors, itself excluded) — indices are dropped
 * internally, since `stepOutputs` is static-keyed throughout (see {@link RunState.stepOutputs}).
 * `frames` are the enclosing construct frames, innermost last (iteration-context spec, Feature 1),
 * and `ownPath` is the caller's own formatted DYNAMIC path (a step's own path; for a
 * condition/selector/predicate, the construct's own path).
 */
export function createRunContext(
	state: RunState,
	callerParentPath: NodePath,
	frames: readonly ScopeFrame[],
	ownPath: string,
): RunContext {
	const staticParent = staticPathOf(callerParentPath)
	return {
		runId: state.runId,
		workflowName: state.workflowName,
		path: ownPath,
		scope: (name?: string) => {
			if (name === undefined) return frames.at(-1)
			for (let i = frames.length - 1; i >= 0; i--) {
				const frame = frames[i]
				if (frame && frame.name === name) return frame
			}
			return undefined
		},
		getStepResult: <T>(name: string) => resolveStepResult(state, staticParent, name) as T | undefined,
		getInitData: <T>() => state.initialInput as T | undefined,
	}
}

/**
 * Resolve a `getStepResult` argument (names-only addressing, spec 4.1/4.2): a BARE name, resolved
 * lexically to the nearest enclosing scope that DECLARES it — search the caller's own scope, then each
 * ancestor scope outward to the root. The nearest declaring scope wins outright: its value is returned
 * even when that is `undefined` (a step not yet reached, or skipped — a legitimate structural fact),
 * never falling through to a same-named node further out. This is deterministic by construction — at
 * every level there is at most one node with a given name (validated unique at `.commit()`, spec §3).
 *
 * Two hard errors, both provable wiring bugs rather than structural facts:
 *  - path syntax (`/`, `#`, `@`) in the argument — the path form was removed outright (spec 4.1);
 *  - a name NO scope on the caller's chain declares (spec 4.2) — the error lists what IS visible,
 *    which is strictly better than discovering the typo as a silent `undefined` three steps later.
 *
 * **Reads never race** (spec §3.9): a key currently in `inFlight` THROWS instead of resolving — a
 * concurrently executing step's result is not an honest `undefined`. Checked at every level of the
 * lexical walk, in lexical-priority order, so the nearest in-flight match wins over a coincidental
 * match further out.
 */
function resolveStepResult(state: RunState, staticCallerParentPath: NodePath, name: string): unknown {
	if (name.includes("/") || name.includes("#") || name.includes("@")) {
		throw new Error(
			`getStepResult("${name}"): path arguments were removed (names-only addressing, spec 4.1) — pass the bare step/construct name; it resolves lexically to the nearest enclosing scope that declares it`,
		)
	}
	for (let i = staticCallerParentPath.length; i >= 0; i--) {
		const prefix = staticCallerParentPath.slice(0, i)
		const key = prefix.length === 0 ? name : `${formatPath(prefix)}/${name}`
		assertNotInFlight(state.inFlight, key, name)
		const scopeChain = prefix.map((segment) => segment.name).join("/")
		if (state.nameIndex.get(scopeChain)?.has(name)) {
			return state.stepOutputs.get(key) // may be undefined: declared but not yet run / skipped (spec 4.2)
		}
	}

	const visible = new Set<string>()
	for (let i = staticCallerParentPath.length; i >= 0; i--) {
		const scopeChain = staticCallerParentPath
			.slice(0, i)
			.map((segment) => segment.name)
			.join("/")
		for (const declared of state.nameIndex.get(scopeChain) ?? []) visible.add(declared)
	}
	throw new Error(
		`getStepResult("${name}"): no step or construct named "${name}" is visible from this scope (names-only addressing, spec 4.2) — a mis-addressed read is a wiring bug, not a structural fact. Visible names: ${[...visible].sort().join(", ")}`,
	)
}

function assertNotInFlight(inFlight: ReadonlySet<string>, key: string, requested: string): void {
	if (inFlight.has(key)) {
		throw new Error(
			`getStepResult("${requested}"): step "${key}" is currently executing (spec §3.9) — a concurrent read cannot observe an in-flight step`,
		)
	}
}

export function createStepLogger(host: HostPort, runId: string, path: string): StepLogger {
	const log = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => {
		void host.emit({ type: "step-log", runId, path, level, message, data, at: iso(host) })
	}
	return {
		info: (message, data) => log("info", message, data),
		warn: (message, data) => log("warn", message, data),
		error: (message, data) => log("error", message, data),
	}
}
