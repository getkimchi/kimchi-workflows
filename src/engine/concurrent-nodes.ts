/**
 * Concurrent-construct execution (spec §3.4/§3.5/§3.6/§8.6/§9.5, P3): `.parallel` and
 * `.foreach(concurrency > 1)`. Split out of execute.ts purely for file size — this is the mutually
 * recursive OTHER half of the same node walker. It needs to recurse back into execute.ts's
 * `runNodeSequence`/`runStepNode`/`leafNameOf` (a foreach item's/parallel arm's body is walked by the
 * former; a parallel arm itself by the latter), which execute.ts passes in as a `NodeWalker` (see
 * context.ts) rather than this file importing them — keeping the dependency one-directional
 * (execute.ts → here) instead of an import cycle.
 *
 * Every arm/item runs through the scheduler seam (scheduler.ts), bounded by this construct's own local
 * cap (a foreach's declared `concurrency`; the run's ceiling for a parallel, which declares none). The
 * run-wide ceiling itself is held one level down, by each STEP (`runStepNode`, execute.ts), so that
 * constructs can nest without a construct ever waiting for a slot it is itself occupying — see
 * scheduler.ts's header. Blocking (spec §8.6) suspends only its own arm — settling immediately with
 * its `questionnaire-asked` already recorded — while siblings keep running through the SAME pool. A
 * crash drains (spec §9.5): no new arms start, in-flight ones finish naturally, and any sibling that is
 * ALREADY blocked in the same round is abandoned (`step-cancelled`), not waited on. Resuming into a
 * construct with several simultaneously-blocked arms re-enters exactly the target, leaves every OTHER
 * still-blocked sibling untouched, and reports the next pending one (if any) rather than the whole
 * construct's assembled output.
 *
 * `.foreach(concurrency === 1)` (the default) keeps its EXACT pre-P3 sequential code path — spec
 * requires concurrency-1 behaviour stay unchanged, so it is not a degenerate case of the concurrent
 * path below, it is the same code that shipped before this phase.
 *
 * Zero imports from PI, `node:fs`, or any network lib — see src/engine/types.ts.
 */
import type { ForeachNode, ParallelNode, ScopeFrame } from "../flow/types.ts"
import {
	createRunContext,
	type ExecOutcome,
	emitNodeCompleted,
	iso,
	type NodeWalker,
	type PendingBlock,
	type Reentry,
	type RunState,
} from "./context.ts"
import {
	appendForeachItem,
	appendSegment,
	formatPath,
	type NodePath,
	staticChildKey,
	staticKeyOf,
} from "./node-path.ts"
import { runConcurrent } from "./scheduler.ts"
import type { HostPort } from "./types.ts"

// -- Shared settlement (spec §8.6/§9.5) --------------------------------------------------------------

/**
 * Settle a concurrent construct's per-arm/item outcomes into ONE `ExecOutcome` for the whole construct.
 * Precedence: `cancelled` > `crashed` (draining, spec §9.5 — any sibling STILL blocked, whether it just
 * settled that way in `outcomes` or was already pending from before in `stillBlocked`, is abandoned via
 * `step-cancelled` rather than waited on) > `blocked` (report the first, in the caller's supplied
 * order — item/arm order for a fresh round is the deterministic stand-in for "FIFO" the spec calls for,
 * since real ask-order is not deterministic under concurrency; true log-order FIFO is used across
 * separate resume calls, see resume-workflow.ts) > `ok` (built lazily via `onOk`, since assembling and
 * emitting `node-completed` should only happen once we know nothing else is pending).
 */
async function settleConcurrent(
	host: HostPort,
	state: RunState,
	outcomes: readonly ExecOutcome[],
	stillBlocked: readonly PendingBlock[],
	onOk: () => Promise<ExecOutcome>,
): Promise<ExecOutcome> {
	let cancelled: Extract<ExecOutcome, { kind: "cancelled" }> | undefined
	let crashed: Extract<ExecOutcome, { kind: "crashed" }> | undefined
	const blocked: Extract<ExecOutcome, { kind: "blocked" }>[] = []

	for (const outcome of outcomes) {
		if (outcome.kind === "cancelled") cancelled ??= outcome
		else if (outcome.kind === "crashed") crashed ??= outcome
		else if (outcome.kind === "blocked") blocked.push(outcome)
	}

	if (cancelled) return cancelled

	if (crashed) {
		for (const b of blocked) await emitStepCancelled(host, state, b.path)
		for (const b of stillBlocked) await emitStepCancelled(host, state, b.path)
		return crashed
	}

	if (blocked.length > 0 || stillBlocked.length > 0) {
		return blocked[0] ?? toBlockedOutcome(stillBlocked[0] as PendingBlock)
	}

	return onOk()
}

function toBlockedOutcome(block: PendingBlock): Extract<ExecOutcome, { kind: "blocked" }> {
	return { kind: "blocked", path: block.path, questionnaire: block.questionnaire, conversation: block.conversation }
}

/**
 * The `onOk` a concurrent construct settles with (see {@link settleConcurrent}): checkpoint the
 * construct's assembled output, then hand it to the next node. Deferred rather than emitted eagerly
 * because a construct with any arm still pending has not completed at all — `output` is captured by
 * reference, so arms that settle before this runs are included.
 */
function completeNode(host: HostPort, state: RunState, path: NodePath, output: unknown): () => Promise<ExecOutcome> {
	return async () => {
		await emitNodeCompleted(host, state, path, output)
		return { kind: "ok", output }
	}
}

async function emitStepCancelled(host: HostPort, state: RunState, path: string): Promise<void> {
	await host.emit({ type: "step-cancelled", runId: state.runId, path, at: iso(host) })
}

// -- Foreach (spec §3.4/§8.5) -------------------------------------------------------------------------

/**
 * Foreach: run the body once per selected item, with the item as input. Output is the per-item outputs
 * in order, regardless of completion order. Per-item checkpoint (spec §8.2): `state.foreachItemHistory`
 * (built once at resume start from `foreach-item-completed` events) lets THIS foreach — wherever it
 * sits in the tree — skip every item already recorded, whether resuming node-atomically (no `reentry`,
 * spec §8.2/§8.3) or re-entering a deeper block inside a still-in-flight item (spec §8.5).
 */
export async function runForeachNode(
	walker: NodeWalker,
	node: ForeachNode,
	input: unknown,
	host: HostPort,
	state: RunState,
	signal: AbortSignal,
	parentPath: NodePath,
	frames: readonly ScopeFrame[],
	reentry?: Reentry,
): Promise<ExecOutcome> {
	const foreachPath = appendSegment(parentPath, node.name)
	const ctx = createRunContext(state, parentPath, frames, formatPath(foreachPath))
	const items = node.selector(ctx) // pure, deterministic — a resume re-runs it to the same array (spec §3.4)

	// A non-array selector result is a deterministic wiring failure (spec §3.4), exactly like an
	// input-schema violation (§3.8): crash immediately, before any lifecycle event, rather than treating
	// it as zero items — `.length` on a non-array is `undefined`, which a naive bound would silently
	// treat as an empty foreach instead of the wiring bug it actually is.
	if (!Array.isArray(items)) {
		return {
			kind: "crashed",
			error: `foreach "${node.name}" selector did not return an array (spec §3.4)`,
			path: formatPath(foreachPath),
		}
	}

	if (!reentry) {
		await host.emit({
			type: "foreach-started",
			runId: state.runId,
			path: formatPath(foreachPath),
			count: items.length,
			at: iso(host),
		})
	}

	const history = state.foreachItemHistory?.get(formatPath(foreachPath))

	if (node.concurrency <= 1) {
		return runForeachSequential(
			walker,
			node,
			input,
			host,
			state,
			signal,
			parentPath,
			frames,
			foreachPath,
			items,
			history,
			reentry,
		)
	}
	if (reentry) {
		return runForeachConcurrentReentry(
			walker,
			node,
			host,
			state,
			signal,
			parentPath,
			frames,
			foreachPath,
			items,
			history,
			reentry,
		)
	}
	return runForeachConcurrentFresh(walker, node, host, state, signal, parentPath, frames, foreachPath, items, history)
}

/** The foreach frame an item's body (or a step inside it) sees: position + the ITEM itself (spec 1.6). */
function foreachFrame(node: ForeachNode, index: number, items: readonly unknown[]): ScopeFrame {
	return { kind: "foreach", name: node.name, itemIndex: index, itemCount: items.length, input: items[index] }
}

/**
 * Sequential foreach body (concurrency 1, or the default) — the pre-P3 code path, behaviour unchanged
 * outside feedback mode. With `feedback` (foreach-feedback spec, Feature 3) the body's hand-off input
 * is the PREVIOUS item's effective output — item 0 receives the foreach's upstream `input` — with the
 * loop's pass-through rule (3.2: an item producing no output forwards what it received). The item
 * itself is delivered through the frame (`ctx.scope(name)?.input`) in both modes. On resume the fed
 * value is rebuilt by walking the recovered history prefix under the same pass-through rule, so a
 * re-run item receives exactly what a continuous run would have fed it.
 */
async function runForeachSequential(
	walker: NodeWalker,
	node: ForeachNode,
	input: unknown,
	host: HostPort,
	state: RunState,
	signal: AbortSignal,
	parentPath: NodePath,
	frames: readonly ScopeFrame[],
	foreachPath: NodePath,
	items: readonly unknown[],
	history: ReadonlyMap<number, unknown> | undefined,
	reentry: Reentry | undefined,
): Promise<ExecOutcome> {
	const targetIndex = reentry ? reentry.path[0]?.index : undefined
	if (reentry && targetIndex === undefined) {
		throw new Error(`resume: foreach "${node.name}" re-entry path is missing its item index (definition drift?)`)
	}
	const startIndex = targetIndex ?? firstMissingIndex(history, items.length)
	const feedback = node.feedback === true

	let fed = input
	const results: unknown[] = new Array(items.length)
	for (let index = 0; index < startIndex; index++) {
		results[index] = history?.get(index)
		// Pass-through over the recovered prefix (3.2): a recorded `undefined` (a failed optional item)
		// forwards the value it received rather than erasing it.
		if (results[index] !== undefined) fed = results[index]
	}

	let innerReentry: Reentry | undefined = reentry ? { path: reentry.path.slice(1), answer: reentry.answer } : undefined

	for (let index = startIndex; index < items.length; index++) {
		if (signal.aborted) return { kind: "cancelled" }
		const itemPath = appendForeachItem(parentPath, node.name, index)
		const thisItemReentry = innerReentry
		if (!thisItemReentry) {
			await host.emit({
				type: "foreach-item-started",
				runId: state.runId,
				path: formatPath(itemPath),
				index,
				at: iso(host),
			})
		}

		const outcome = await walker.runNodeSequence(
			node.body.nodes,
			host,
			state,
			feedback ? fed : items[index],
			signal,
			itemPath,
			[...frames, foreachFrame(node, index, items)],
			0,
			thisItemReentry,
		)
		if (outcome.kind !== "ok") return outcome

		results[index] = outcome.output
		if (outcome.output !== undefined) fed = outcome.output // pass-through (3.2)
		await host.emit({
			type: "foreach-item-completed",
			runId: state.runId,
			path: formatPath(itemPath),
			index,
			output: outcome.output,
			at: iso(host),
		})
		innerReentry = undefined
	}

	await emitNodeCompleted(host, state, foreachPath, results)
	return { kind: "ok", output: results }
}

/**
 * Concurrent foreach, fresh round (spec §3.4/§9.5) — also used by `resumeWorkflow`'s node-atomic
 * restart, which supplies `history` for whatever items already checkpointed. `history` is NOT assumed
 * to be a contiguous prefix (concurrency completes items out of order): every non-history index runs.
 */
async function runForeachConcurrentFresh(
	walker: NodeWalker,
	node: ForeachNode,
	host: HostPort,
	state: RunState,
	signal: AbortSignal,
	parentPath: NodePath,
	frames: readonly ScopeFrame[],
	foreachPath: NodePath,
	items: readonly unknown[],
	history: ReadonlyMap<number, unknown> | undefined,
): Promise<ExecOutcome> {
	const results: unknown[] = new Array(items.length)
	const toRun: number[] = []
	for (let index = 0; index < items.length; index++) {
		if (history?.has(index)) results[index] = history.get(index)
		else toRun.push(index)
	}

	const emitOk = completeNode(host, state, foreachPath, results)
	if (toRun.length === 0) return emitOk()

	const localLimit = Math.min(node.concurrency, toRun.length)
	const settled = await runConcurrent(
		toRun,
		async (index) => {
			const itemPath = appendForeachItem(parentPath, node.name, index)
			await host.emit({
				type: "foreach-item-started",
				runId: state.runId,
				path: formatPath(itemPath),
				index,
				at: iso(host),
			})
			const outcome = await walker.runNodeSequence(
				node.body.nodes,
				host,
				state,
				items[index],
				signal,
				itemPath,
				[...frames, foreachFrame(node, index, items)],
				0,
				undefined,
			)
			if (outcome.kind === "ok") {
				results[index] = outcome.output
				await host.emit({
					type: "foreach-item-completed",
					runId: state.runId,
					path: formatPath(itemPath),
					index,
					output: outcome.output,
					at: iso(host),
				})
			}
			return outcome
		},
		localLimit,
		(outcome) => outcome.kind === "crashed" || outcome.kind === "cancelled",
	)

	const outcomes = settled.filter((o): o is ExecOutcome => o !== undefined)
	return settleConcurrent(host, state, outcomes, [], emitOk)
}

/**
 * Concurrent foreach re-entry (spec §8.5/§8.6): navigate straight to the blocked TARGET item and
 * continue its same loop; every OTHER item is either recovered from `history` (already completed),
 * left untouched (`state.pendingBlocks` — a sibling ALSO still blocked from the same original round),
 * or — defensively, should not normally arise since a fresh round always attempts every item before
 * settling `blocked` — run fresh.
 */
async function runForeachConcurrentReentry(
	walker: NodeWalker,
	node: ForeachNode,
	host: HostPort,
	state: RunState,
	signal: AbortSignal,
	parentPath: NodePath,
	frames: readonly ScopeFrame[],
	foreachPath: NodePath,
	items: readonly unknown[],
	history: ReadonlyMap<number, unknown> | undefined,
	reentry: Reentry,
): Promise<ExecOutcome> {
	const targetIndex = reentry.path[0]?.index
	if (targetIndex === undefined) {
		throw new Error(`resume: foreach "${node.name}" re-entry path is missing its item index (definition drift?)`)
	}

	const results: unknown[] = new Array(items.length)
	const stillBlocked: PendingBlock[] = []
	const extraToRun: number[] = []

	for (let index = 0; index < items.length; index++) {
		if (index === targetIndex) continue
		if (history?.has(index)) {
			results[index] = history.get(index)
			continue
		}
		const key = staticKeyOf(appendForeachItem(parentPath, node.name, index))
		const pending = state.pendingBlocks?.get(key)
		if (pending) {
			stillBlocked.push(pending)
			continue
		}
		extraToRun.push(index)
	}

	const targetPath = appendForeachItem(parentPath, node.name, targetIndex)
	const itemReentry: Reentry = { path: reentry.path.slice(1), answer: reentry.answer }
	const targetOutcome = await walker.runNodeSequence(
		node.body.nodes,
		host,
		state,
		items[targetIndex],
		signal,
		targetPath,
		[...frames, foreachFrame(node, targetIndex, items)],
		0,
		itemReentry,
	)
	if (targetOutcome.kind === "ok") {
		results[targetIndex] = targetOutcome.output
		await host.emit({
			type: "foreach-item-completed",
			runId: state.runId,
			path: formatPath(targetPath),
			index: targetIndex,
			output: targetOutcome.output,
			at: iso(host),
		})
	}

	const extraOutcomes: ExecOutcome[] = []
	for (const index of extraToRun) {
		if (signal.aborted) {
			extraOutcomes.push({ kind: "cancelled" })
			break
		}
		const extraPath = appendForeachItem(parentPath, node.name, index)
		await host.emit({
			type: "foreach-item-started",
			runId: state.runId,
			path: formatPath(extraPath),
			index,
			at: iso(host),
		})
		const outcome = await walker.runNodeSequence(
			node.body.nodes,
			host,
			state,
			items[index],
			signal,
			extraPath,
			[...frames, foreachFrame(node, index, items)],
			0,
			undefined,
		)
		if (outcome.kind === "ok") {
			results[index] = outcome.output
			await host.emit({
				type: "foreach-item-completed",
				runId: state.runId,
				path: formatPath(extraPath),
				index,
				output: outcome.output,
				at: iso(host),
			})
		}
		extraOutcomes.push(outcome)
	}

	return settleConcurrent(
		host,
		state,
		[targetOutcome, ...extraOutcomes],
		stillBlocked,
		completeNode(host, state, foreachPath, results),
	)
}

/** The first item index with no recorded `foreach-item-completed` (0 if none recorded at all). */
function firstMissingIndex(history: ReadonlyMap<number, unknown> | undefined, length: number): number {
	if (!history) return 0
	for (let i = 0; i < length; i++) {
		if (!history.has(i)) return i
	}
	return length
}

// -- Parallel (spec §3.5) -------------------------------------------------------------------------------

/**
 * Parallel: structural fan-out over independent steps, all run concurrently through the shared run-wide
 * gate (spec §3.6) — no local cap beyond the arm count itself. Output is keyed by each arm's own step
 * name, independent of completion order. Arms nest under the parallel's own path segment
 * (`parallelName/armName`), like a loop/foreach body — not peers, unlike branch arms. Re-entry (a
 * blocked arm being answered) mirrors the concurrent-foreach re-entry: recover completed siblings from
 * `stepOutputs`, leave still-blocked ones (`state.pendingBlocks`) untouched, resolve the target, and
 * report the next pending sibling (if any) rather than the whole construct's output.
 */
export async function runParallelNode(
	walker: NodeWalker,
	node: ParallelNode,
	input: unknown,
	host: HostPort,
	state: RunState,
	signal: AbortSignal,
	parentPath: NodePath,
	frames: readonly ScopeFrame[],
	reentry?: Reentry,
): Promise<ExecOutcome> {
	const parallelPath = appendSegment(parentPath, node.name)
	const armFrames: readonly ScopeFrame[] = [...frames, { kind: "parallel", name: node.name, input }]

	if (reentry) {
		// Unlike a branch arm (a PEER of the branch's own path), a parallel arm nests UNDER the parallel's
		// own name (`parallelName/armName`) — so the re-entry path's leading segment here is still the
		// PARALLEL's own name (already consumed by `runNodeSequence`/`matchesReentryTarget` to dispatch
		// here in the first place); pop it to reach the ARM's own segment before matching against arms.
		const innerReentry: Reentry = { path: reentry.path.slice(1), answer: reentry.answer }
		return runParallelReentry(walker, node, input, host, state, signal, parallelPath, armFrames, innerReentry)
	}

	await host.emit({
		type: "node-started",
		runId: state.runId,
		path: formatPath(parallelPath),
		nodeKind: "parallel",
		at: iso(host),
	})

	const settled = await runConcurrent(
		node.arms,
		async (armStep) => {
			const outcome = await walker.runStepNode(armStep, input, host, state, signal, parallelPath, armFrames, undefined)
			return { name: armStep.name, outcome }
		},
		// A parallel declares no cap of its own (spec §3.5) — its lane count IS the run's ceiling, so a
		// 20-arm fan-out runs `maxConcurrency` at a time (spec §3.6) and, once an arm crashes, the arms
		// that have not started yet never do (drain-then-crash, spec §9.5).
		state.concurrencyGate.limit,
		(result) => result.outcome.kind === "crashed" || result.outcome.kind === "cancelled",
	)

	const output: Record<string, unknown> = {}
	const outcomes: ExecOutcome[] = []
	for (const entry of settled) {
		if (!entry) continue
		outcomes.push(entry.outcome)
		if (entry.outcome.kind === "ok") output[entry.name] = entry.outcome.output
	}

	return settleConcurrent(host, state, outcomes, [], completeNode(host, state, parallelPath, output))
}

async function runParallelReentry(
	walker: NodeWalker,
	node: ParallelNode,
	input: unknown,
	host: HostPort,
	state: RunState,
	signal: AbortSignal,
	parallelPath: NodePath,
	armFrames: readonly ScopeFrame[],
	reentry: Reentry,
): Promise<ExecOutcome> {
	const targetName = walker.leafNameOf(reentry)
	const output: Record<string, unknown> = {}
	const stillBlocked: PendingBlock[] = []
	const extraOutcomes: ExecOutcome[] = []
	let targetOutcome: ExecOutcome | undefined

	for (const armStep of node.arms) {
		if (armStep.name === targetName) {
			const armReentry: Reentry = { path: reentry.path.slice(1), answer: reentry.answer }
			targetOutcome = await walker.runStepNode(armStep, input, host, state, signal, parallelPath, armFrames, armReentry)
			continue
		}

		const key = staticChildKey(parallelPath, armStep.name)
		if (state.stepOutputs.has(key)) {
			output[armStep.name] = state.stepOutputs.get(key)
			continue
		}
		const pending = state.pendingBlocks?.get(key)
		if (pending) {
			stillBlocked.push(pending)
			continue
		}
		// Defensive: an arm neither completed nor blocked nor the target — should not normally arise (a
		// fresh parallel round always attempts every arm before settling blocked).
		if (signal.aborted) {
			extraOutcomes.push({ kind: "cancelled" })
			continue
		}
		const outcome = await walker.runStepNode(armStep, input, host, state, signal, parallelPath, armFrames, undefined)
		if (outcome.kind === "ok") output[armStep.name] = outcome.output
		extraOutcomes.push(outcome)
	}

	if (!targetOutcome) {
		throw new Error(
			`resume: parallel "${node.name}" re-entry target "${targetName}" not found among its arms (definition drift?)`,
		)
	}
	if (targetOutcome.kind === "ok") output[targetName] = targetOutcome.output

	return settleConcurrent(
		host,
		state,
		[targetOutcome, ...extraOutcomes],
		stillBlocked,
		completeNode(host, state, parallelPath, output),
	)
}
