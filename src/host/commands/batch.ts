/**
 * The batch arm of `run`.
 *
 * `kimchi workflow run <file-name|file.ts> [--input <json>|@<file>] [--result-out <path>]` — the
 * headless CLI host (src/host/cli.ts) runs one workflow to a terminal state in the foreground and
 * maps the outcome onto the process exit status, so a scheduler (a pod, a CI job) needs nothing but
 * `$?` to know what happened. The in-session `/workflow run` keeps the same verb for the attended
 * surface; this module holds the pieces ONLY the batch surface needs on top of the shared
 * {@link executeRun} lifecycle.
 *
 * Three things distinguish a batch run from an attended one, and each is load-bearing:
 *
 *  - **Blocking, never attended.** `/workflow run` answers a `blocked` run with the inline
 *    questionnaire (spec §10.2); a batch run has no human, so a block IS the outcome — reported,
 *    optionally persisted, and mapped to exit code 2. Nothing about the engine differs; the run
 *    lifecycle is the shared {@link executeRun}.
 *  - **The exit status is the contract** (`exitCodeForStatus`): 0 completed, 2 blocked, 3 cancelled,
 *    4 crashed or never-started. Codes 0/1 are the conventions everything already uses, so the
 *    workflow vocabulary starts at 2 and stays out of the way. Delivered through `process.exitCode`
 *    rather than `process.exit` — every durable write (the event log, the artifact) has already been
 *    awaited by the time it is set, and a hard exit could strap buffered stderr writes to a pipe.
 *  - **stdout stays machine-clean.** Progress is the plain append-only renderer on stderr
 *    (progress-plain.ts, §8.2), whichever mode the harness happens to be in — the batch surface
 *    exists for the mode matrix's headless rows, so the TUI surfaces have nothing to contribute to
 *    it, and `--result-out` (result-artifact.ts) is what a machine reads off stdout's behalf.
 */
import type { RunResult } from "../../engine/types.ts"
import { buildOutline } from "../../progress/outline.ts"
import type { ActiveRuns } from "../active-runs.ts"
import { createPlainProgress, type LineWriter } from "../progress-plain.ts"
import type { ProgressFor, ProgressSink } from "../progress-sink.ts"
import { summarizeRun } from "../summarize-run.ts"
import type { RunStore } from "../types.ts"
import { type CommandCtx, describe, reportResult, type StartAgent } from "./context.ts"
import { writeRunResultArtifact } from "./result-artifact.ts"
import { executeRun, resolveRunInvocation } from "./run.ts"

/**
 * The status → exit-code contract, centralised here because it is the whole reason the batch
 * surface exists: schedulers branch on `$?`, and every surface that reports a terminal state must
 * agree on these numbers. `blocked` (2) is a workflow asking for a human that is not there;
 * `cancelled` (3) covers both SIGINT/SIGTERM and an engine-level cancel; `crashed` (4) also covers
 * runs that never started — an unknown workflow, a malformed command line, or a rejected `--input`
 * fails the JOB the same way an engine crash does.
 */
export function exitCodeForStatus(status: RunResult["status"]): 0 | 2 | 3 | 4 {
	switch (status) {
		case "completed":
			return 0
		case "blocked":
			return 2
		case "cancelled":
			return 3
		case "crashed":
			return 4
	}
}

/**
 * The one surface a batch run renders to: plain, append-only lines on stderr (progress §8),
 * regardless of the harness mode. No widgets, no cards, nothing on stdout.
 */
export function plainProgressFor(write: LineWriter): ProgressFor {
	return (workflow) => {
		const plain = createPlainProgress(buildOutline(workflow), write)
		const sink: ProgressSink = {
			accept: (event) => plain.accept(event),
			update: () => {}, // plain lines have nothing to redraw between events (§8.3)
			seed: () => {}, // a fresh run has no history to replay
			reportedOutcome: () => false,
			dispose: () => {},
		}
		return sink
	}
}

/** A batch run's fully resolved invocation: what `run` parsing produced, with a target present. */
export interface BatchRunArgs {
	readonly target: string
	readonly inputArg: string | undefined
	readonly resultOut: string | undefined
}

/**
 * The seams a batch run needs from its process, injectable so the exit-code protocol is testable
 * without exiting a test runner. Defaults are the real process: `exitCode` (not `process.exit` —
 * see the module header) and stderr lines.
 */
export interface BatchRunDeps {
	readonly exit?: (code: number) => void
	/** Warnings (signal notices, artifact write failures). Default: stderr. */
	readonly warn?: (line: string) => void
	/** Plain progress lines. Default: stderr. */
	readonly stderr?: LineWriter
	/** Signal source (default: the real process). Injectable so a test can raise SIGINT without signalling anything real. */
	readonly signals?: BatchSignalSource
}

function stderrLine(line: string): void {
	process.stderr.write(`${line}\n`)
}

/** `exitCode`, not `process.exit`: the log and the artifact are already flushed, and a hard exit could truncate piped stderr. */
function setProcessExitCode(code: number): void {
	process.exitCode = code
}

/** The two verbs of the process EventEmitter a batch run subscribes to — structurally both `process` and a bare `EventEmitter`. */
export interface BatchSignalSource {
	on(signal: string, handler: () => void): unknown
	off(signal: string, handler: () => void): unknown
}

/**
 * One run to its terminal state, with the batch contract on top: resolve and validate exactly like
 * `run` (any failure there is exit 4), then drive the run in the foreground. SIGINT/SIGTERM take
 * the engine's graceful cancellation path — the same durable `run-cancelled` + cooperative abort
 * `/workflow cancel` uses — and the run's eventual `cancelled` result is what exit 3 reports, so
 * the checkpoint that lets the run be resumed always lands before the process ends.
 */
export async function handleBatchRun(
	ctx: CommandCtx,
	store: RunStore,
	activeRuns: ActiveRuns,
	startAgent: StartAgent,
	args: BatchRunArgs,
	deps: BatchRunDeps = {},
): Promise<number> {
	const exit = deps.exit ?? setProcessExitCode
	const warn = deps.warn ?? stderrLine
	const progressFor = plainProgressFor(deps.stderr ?? stderrLine)

	let runId: string | undefined
	let settled = false
	let signalledBeforeStart = false
	const cancel = (signalName: string): void => {
		if (settled) return
		if (runId === undefined) {
			// Nothing is executing to cancel and nothing has been recorded yet: cancelled is the honest
			// status of a job that never started, and there is no log to flush first.
			signalledBeforeStart = true
			warn(`workflow: ${signalName} before the run started; exiting cancelled.`)
			exit(3)
			return
		}
		const cancelling = runId
		void (async () => {
			const [execution] = activeRuns.find(cancelling)
			if (!execution) return
			const currentStep = summarizeRun(await store.loadEvents(cancelling))?.currentStep
			// Persist FIRST, then abort (active-runs.ts's cancel does both): the checkpoint is durable
			// before the engine is asked to stop, and the engine's own terminal event lands before
			// `executeRun` resolves — that ordering IS "allow the event-log flush to complete" (§8.6).
			const outcome = await execution.cancel(() =>
				store.appendEvent({
					type: "run-cancelled",
					runId: cancelling,
					executionId: execution.lease.executionId,
					path: currentStep,
					source: "command",
					at: new Date().toISOString(),
				}),
			)
			if (outcome === "accepted") warn(`workflow: ${signalName} received; cancelling run ${cancelling}...`)
		})().catch((err) => warn(`workflow: could not record cancellation: ${describe(err)}`))
	}
	const onSigint = (): void => cancel("SIGINT")
	const onSigterm = (): void => cancel("SIGTERM")
	const signals = deps.signals ?? process
	signals.on("SIGINT", onSigint)
	signals.on("SIGTERM", onSigterm)
	try {
		const resolved = await resolveRunInvocation(ctx, args.target, args.inputArg)
		if (!resolved) {
			settled = true
			exit(4)
			return 4
		}
		if (signalledBeforeStart) return 3

		let executed: Awaited<ReturnType<typeof executeRun>>
		try {
			executed = await executeRun(
				store,
				activeRuns,
				startAgent,
				resolved.workflow,
				resolved.workflowSource,
				resolved.initialInput,
				progressFor,
				{
					onRunId: (id) => {
						runId = id
					},
				},
			)
		} catch (error) {
			ctx.ui.notify(`workflow: ${describe(error)}`, "error")
			settled = true
			exit(4)
			return 4
		}
		try {
			const code = exitCodeForStatus(executed.result.status)
			reportResult(ctx, resolved.workflow.name, executed.result, executed.progress.reportedOutcome())
			if (args.resultOut !== undefined) {
				const writeError = await writeRunResultArtifact(
					store,
					ctx.cwd,
					args.resultOut,
					executed.runId,
					resolved.workflow.name,
					executed.result,
				)
				if (writeError) warn(`workflow: ${writeError}`)
			}
			settled = true
			exit(code)
			return code
		} finally {
			executed.progress.dispose()
		}
	} finally {
		signals.off("SIGINT", onSigint)
		signals.off("SIGTERM", onSigterm)
	}
}
