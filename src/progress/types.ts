/**
 * The shapes the progress layer speaks in (progress §1, §2.1).
 *
 * Four modules pass three values between them — an {@link Outline} (static, from the definition), a
 * {@link ProgressView} (that outline joined with the log), and {@link ProgressRow}s (the view after
 * collapse) — and this file is where all three are declared so none of them owns another's vocabulary.
 *
 * Two constraints are load-bearing and invisible from any single field below:
 *
 *  - **Nothing here reaches a clock.** Every duration is already a NUMBER of milliseconds by the time
 *    it lands on a node; `project(outline, events, now)` is the one place `now` enters the layer, as a
 *    parameter. A renderer that could read the clock would be a renderer no test could pin (progress
 *    §2.1), and the whole-second guarantee of §4.8 would have nowhere to live.
 *  - **`state` is never computed here.** It is `deriveStepStates`' answer, copied (progress §3.1).
 *    Everything else on a node — counters, timings, badges, token sums — is what a *tree* needs and the
 *    state map does not carry. Two answers to "is this step done?" is the bug this layer is shaped to
 *    make impossible.
 *
 * `ProgressTheme` is the whole of the layer's dependency on a terminal: two functions, satisfied
 * structurally by PI's `Theme` and by a pair of identity functions in a test (progress §4.11).
 */
import type { RunStatus } from "../engine/run-status.ts"
import type { StepState } from "../engine/step-state.ts"
import type { RetryReason } from "../engine/types.ts"

/**
 * The theme colours this layer names — deliberately a small subset of PI's `ThemeColor`, so that PI's
 * `Theme` satisfies {@link ProgressTheme} structurally without the pure layer importing PI to say so.
 * At most three of them are live in a calm panel (progress §4.5): `accent` for what is happening,
 * `success` for what is done, `muted`/`dim` for everything structural.
 */
export type ProgressColour = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error" | "borderMuted"

/**
 * The minimal styling seam (progress §4.11). Padding and truncation are computed on PLAIN strings and
 * these are applied to the finished segments afterwards — ANSI-aware width arithmetic is a recurring
 * source of off-by-N corruption, and this ordering is what makes the renderer's output assertable
 * without a terminal.
 */
export interface ProgressTheme {
	fg(colour: ProgressColour, text: string): string
	bold(text: string): string
}

/** What a row IS, structurally. Mirrors `WorkflowNode`'s kinds plus the two the tree adds of its own. */
export type OutlineKind = "step" | "branch" | "branch-arm" | "loop" | "foreach" | "parallel" | "workflow"

/**
 * A projected row's kind: an outline kind, or a `foreach-item` — the one node kind with no outline
 * counterpart at all, since a foreach's length is unknown until `foreach-started` (progress §3.4) and
 * its items are instantiated from event paths rather than declared.
 */
export type ProgressKind = OutlineKind | "foreach-item"

/**
 * One node of the static tree (progress §1): every node of a `WorkflowDefinition` in declaration
 * order, nested as authored, each carrying the STATIC node path (spec §5.4) that keys it against the
 * log. Known before the run starts, and true of every run of that definition.
 *
 * `path` is a template in exactly one place: inside a `foreach` body it carries the foreach's bare name,
 * and `outline.ts`'s `foreachItemChildren` re-paths it per live item (`review-each@3/review`).
 */
export interface OutlineNode {
	readonly kind: OutlineKind
	/** The node's declared name — what the row is labelled by. */
	readonly name: string
	/** The static node path (spec §5.4) this node's events are keyed by. */
	readonly path: string
	readonly children: readonly OutlineNode[]
	/** Steps only: `optional` (spec §9.1) — the difference between the `⚠` and `✗` glyphs (progress §4.4). */
	readonly optional?: boolean
	/** Steps only: total attempts allowed (`retry.maxRetry + 1`) — the denominator of `retry 2/3` (progress §5.3). */
	readonly maxAttempts?: number
	/** Loops only: the declared `maxIterations` guard — the denominator of `↻ 2/10` (progress §4.6). */
	readonly maxIterations?: number
}

/** A workflow's static tree plus its name, which the panel header shows as an accent chip (progress §4.1). */
export interface Outline {
	readonly workflowName: string
	readonly nodes: readonly OutlineNode[]
}

/** A step's most recent retry (progress §3.2, §5.3): the attempt that failed and why. */
export interface RetryBadge {
	/** 1-based attempt that failed (`step-retry.attempt`). */
	readonly attempt: number
	/** Total attempts the step's policy allows, when the definition declares one. */
	readonly of?: number
	readonly reason: RetryReason
}

/** A loop's live position against its guard (progress §4.6): how close `↻ 8/10` is to the wall. */
export interface LoopCounter {
	readonly iteration: number
	readonly max: number
}

/** A foreach's live position (progress §4.6): a proportion, which is why it draws as a track. */
export interface ForeachCounter {
	/** Items with a recorded `foreach-item-completed`. */
	readonly done: number
	/** The selected length, from `foreach-started` (progress §3.4 — unknown, and so absent, before it). */
	readonly count: number
}

/**
 * One node of the outline joined with the log (progress §1's *projection*). A pure fold: the same
 * function serves the live widget, a resumed run, and the terminal card, which is the property that
 * stops the three from drifting (progress §2.4).
 */
export interface ProgressNode {
	readonly kind: ProgressKind
	/** The row's label. For a foreach item, its body step's name plus an item stub (progress §3.6). */
	readonly name: string
	/** The instantiated static node path — a foreach item's carries its index (spec §5.4's exception). */
	readonly path: string
	/**
	 * `deriveStepStates`' answer for a step or a branch arm (progress §3.1), and a roll-up of the
	 * subtree for a construct, which has no step state of its own to look up.
	 */
	readonly state: StepState
	readonly children: readonly ProgressNode[]
	/**
	 * Wall time: the settled duration once the node has an end event, otherwise the live measurement
	 * against `now`. Absent for a node that never started — a duration of `0` and "never ran" are
	 * different facts and the renderer must be able to tell them apart.
	 */
	readonly elapsedMs?: number
	/**
	 * True when `elapsedMs` was measured against `now` rather than against a recorded end event. The
	 * renderer formats these to WHOLE SECONDS (progress §4.8), which is what makes two renders inside
	 * one second byte-identical; a settled duration keeps its tenths because it can never change again.
	 */
	readonly live: boolean
	/** Tokens spent under this node: its own `agent-usage` for a step, the subtree's sum for a construct (progress §4.9). */
	readonly tokens: number
	/** Steps only, and only when declared `optional` — a failure here cost the step, not the run (spec §9.1). */
	readonly optional: boolean
	readonly retry?: RetryBadge
	/** `agent-steer` corrections so far this execution (progress §3.2's `repair N`). */
	readonly repairs?: number
	/** Questions pending on a `blocked` node — its own batch, or the subtree's total for a construct. */
	readonly questions?: number
	/** The recorded error for a step that failed for good (`step-failed`) — surfaced by the card, not the row (progress §4.10). */
	readonly failureReason?: string
	readonly loop?: LoopCounter
	readonly foreach?: ForeachCounter
	/**
	 * Foreach only: leaf steps in ONE item's body, from the static template. With {@link pendingItems}
	 * this is what lets the footer count a fan-out's whole size the moment `foreach-started` declares it,
	 * without materialising a row for any of it (progress §3.8, §6.4.1).
	 */
	readonly perItemSteps?: number
	/** Foreach only: declared items with no events yet — outstanding work that has no row (progress §3.8). */
	readonly pendingItems?: number
	/** Branch/parallel: how many arms this construct declares (progress §4.9's `2 arms`). */
	readonly arms?: number
	/**
	 * Branch/parallel: how many of those arms were not skipped. A multi-match branch (spec §3.2) runs
	 * only the arms whose condition held, so a finished branch reporting `✓ 2 arms` when one was never
	 * eligible is a claim about work that never happened — the summary reads `✓ 1 of 2 arms` instead.
	 */
	readonly armsTaken?: number
	/** Sub-workflow-bodied kinds (nested workflow, branch arm, multi-step foreach item): leaf steps in the subtree — the `✓ 4 steps` of a collapsed summary (progress §6.1). */
	readonly steps?: number
}

/**
 * A run's outline joined with its log (progress §3), plus what the frame needs: the header's identity
 * and clock, the footer's tally and cost.
 */
export interface ProgressView {
	readonly workflowName: string
	/** The run id, from the log. The header shows only its trailing hash (progress §4.1). */
	readonly runId?: string
	/** `deriveRunStatus`' answer; absent for a log with no `run-started` at all. */
	readonly status?: RunStatus
	/** Wall time since the latest `run-started`/`run-resumed`, frozen at the terminal event. */
	readonly elapsedMs?: number
	/** True while `elapsedMs` is still measured against `now` (see {@link ProgressNode.live}). */
	readonly live: boolean
	/** Every `agent-usage` in the log, summed — the only place an isolated step's spend is visible (progress §5.4). */
	readonly tokens: number
	/** Leaf steps that have settled (completed, skipped, crashed, or cancelled) — the footer bar's numerator. */
	readonly stepsSettled: number
	/** Leaf steps in the projected tree, live foreach items included. */
	readonly stepsTotal: number
	/** The `run-crashed` error, when the run crashed. */
	readonly failureReason?: string
	readonly nodes: readonly ProgressNode[]
}

/**
 * One drawable line of the tree: a node, its depth, and the connector guides above it (progress §4.3).
 *
 * `guides` has exactly `depth` entries. Each says whether the ancestor at that level (the node itself,
 * at the last entry) has a following sibling — which is all the renderer needs to draw `│ ` for a
 * continuing level, `└ ` for a last child, and two spaces where a level has run out. Depth 0 has no
 * connector columns at all.
 */
export interface ProgressRow {
	readonly node: ProgressNode
	readonly depth: number
	readonly guides: readonly boolean[]
	/** True when this construct folded to a summary row (progress §6.1): its children are NOT in the row list. */
	readonly collapsed: boolean
	/**
	 * True when this construct's children DO follow it in the row list — the `▾`/`▸` distinction of
	 * progress §4.4. Carried on the row rather than re-derived by the renderer so that the collapse rules
	 * (§6.1–§6.3) are stated in exactly one place; a renderer guessing at them would drift the moment one
	 * of the three changes.
	 */
	readonly expanded: boolean
}
