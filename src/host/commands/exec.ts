/**
 * `/workflow exec <file-name|file.ts> [--result-out <path>] [--input <json>|@<file>]` — the batch
 * entry point: run one workflow to a terminal state in the foreground and map the outcome onto the
 * process exit status, so a scheduler (a pod, a CI job) needs nothing but `$?` to know what happened.
 *
 * Three things distinguish it from `run`, and each is load-bearing:
 *
 *  - **Blocking, never attended.** `run` answers a `blocked` run with the inline questionnaire
 *    (spec §10.2); `exec` has no human, so a block IS the outcome — reported, optionally persisted,
 *    and mapped to exit code 2. Nothing about the engine differs; the run lifecycle is the shared
 *    {@link executeRun}.
 *  - **The exit status is the contract** (`exitCodeForStatus`): 0 completed, 2 blocked, 3 cancelled,
 *    4 crashed or never-started. Codes 0/1 are the conventions everything already uses, so the
 *    workflow vocabulary starts at 2 and stays out of the way. Delivered through `process.exitCode`
 *    rather than `process.exit` — every durable write (the event log, the artifact) has already been
 *    awaited by the time it is set, and a hard exit would strap buffered stderr writes to a pipe.
 *  - **stdout stays machine-clean.** Progress is the plain append-only renderer on stderr
 *    (progress-plain.ts, §8.2), whichever mode the harness happens to be in — `exec` exists for the
 *    mode matrix's headless rows, so the TUI surfaces have nothing to contribute here.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { RunEvent, RunResult } from "../../engine/types.ts"
import { buildOutline } from "../../progress/outline.ts"
import type { ActiveRuns } from "../active-runs.ts"
import { createPlainProgress, type LineWriter } from "../progress-plain.ts"
import type { ProgressFor, ProgressSink } from "../progress-sink.ts"
import { summarizeRun } from "../summarize-run.ts"
import type { RunStore } from "../types.ts"
import { type CommandCtx, describe, reportResult, type StartAgent } from "./context.ts"
import { executeRun, parseRunArgs, resolveRunInvocation } from "./run.ts"

/** A parsed `/workflow exec` argument line. `inputArg` is verbatim, exactly as `run` sees it. */
export interface ParsedExecArgs {
	readonly target: string | undefined
	readonly inputArg: string | undefined
	readonly resultOut: string | undefined
	readonly error: string | undefined
}

/**
 * `--result-out` must be its own token, exactly like `--input` (run.ts's INPUT_FLAG_RE). The value is
 * the next token — quoted when it contains spaces, so `--result-out "my dir/result.json"` survives.
 */
const RESULT_OUT_FLAG_RE = /(^|\s)--result-out(\s+("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)))?/

/**
 * Parse `/workflow exec <file-name|file.ts> [--result-out <path>] [--input <json>|@<file>]`.
 *
 * `--result-out` is extracted FIRST, wherever it sits on the line, and the remainder is handed to
 * `run`'s own {@link parseRunArgs}, so target and `--input` follow precisely the grammar `run`
 * already documents. Keeping `--input` last is still the sane habit: its payload runs to the end of
 * the line, and a payload containing the literal flag text would be disturbed by the extraction.
 */
export function parseExecArgs(raw: string): ParsedExecArgs {
	const trimmed = raw.trim()
	const withFlag = RESULT_OUT_FLAG_RE.exec(trimmed)
	if (!withFlag) {
		const parsed = parseRunArgs(trimmed)
		return { ...parsed, resultOut: undefined }
	}

	// Groups: 1 = leading whitespace, 2 = the whole ` value` tail, 4/6 = quoted inners, 7 = the bare token.
	const value = withFlag[4] ?? withFlag[6] ?? withFlag[7] ?? ""
	const remainder = (trimmed.slice(0, withFlag.index) + trimmed.slice(withFlag.index + withFlag[0].length)).trim()
	if (!value)
		return {
			target: undefined,
			inputArg: undefined,
			resultOut: undefined,
			error: "--result-out requires a value: <path>",
		}
	if (RESULT_OUT_FLAG_RE.test(remainder))
		return { target: undefined, inputArg: undefined, resultOut: undefined, error: "duplicate --result-out" }
	const parsed = parseRunArgs(remainder)
	return { ...parsed, resultOut: value }
}

/**
 * The status → exit-code contract, centralised here because it is the whole reason `exec` exists:
 * schedulers branch on `$?`, and every surface that reports a terminal state must agree on these
 * numbers. `blocked` (2) is a workflow asking for a human that is not there; `cancelled` (3) covers
 * both SIGINT/SIGTERM and an engine-level cancel; `crashed` (4) also covers runs that never started —
 * an unknown workflow or a rejected `--input` fails the JOB the same way an engine crash does.
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
 * The `--result-out` artifact: what the run's own record knows at its terminal state. `output` is
 * the engine's `RunResult.output` (the workflow's final node output); `steps` collects every
 * completed step's output by its node path from the persisted log — the structured result a batch
 * consumer wants without having to learn the event-log format.
 */
export interface RunResultArtifact {
	readonly runId: string
	readonly workflowName: string
	readonly status: RunResult["status"]
	readonly output: unknown
	readonly steps: Record<string, unknown>
	readonly error?: string
	readonly path?: string
}

export function resultArtifact(
	result: RunResult,
	workflowName: string,
	events: readonly RunEvent[],
): RunResultArtifact {
	const steps: Record<string, unknown> = {}
	for (const event of events) {
		if (event.type === "step-completed" && event.runId === result.runId) steps[event.path] = event.output
	}
	return {
		runId: result.runId,
		workflowName,
		status: result.status,
		output: result.output,
		steps,
		...(result.error === undefined ? {} : { error: result.error }),
		...(result.path === undefined ? {} : { path: result.path }),
	}
}

/**
 * Persist the artifact, creating parent directories. Returns the failure text when the write fails —
 * never throws: a result file that cannot land must not reclassify a run that already finished, so
 * the caller warns and keeps the semantic exit code.
 */
export async function writeResultArtifact(filePath: string, artifact: RunResultArtifact): Promise<string | undefined> {
	try {
		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
		return undefined
	} catch (err) {
		return `could not write the result file "${filePath}": ${describe(err)}`
	}
}

/**
 * The one surface `exec` renders to: plain, append-only lines on stderr (progress §8), regardless of
 * the harness mode. No widgets, no cards, nothing on stdout.
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

/**
 * The seams `exec` needs from its process, injectable so the exit-code protocol is testable without
 * exiting a test runner. Defaults are the real process: `exitCode` (not `process.exit` — see the
 * module header) and stderr lines.
 */
export interface ExecDeps {
	readonly exit?: (code: number) => void
	/** Warnings (signal notices, artifact write failures). Default: stderr. */
	readonly warn?: (line: string) => void
	/** Plain progress lines. Default: stderr. */
	readonly stderr?: LineWriter
	/** Signal source (default: the real process). Injectable so a test can raise SIGINT without signalling anything real. */
	readonly signals?: ExecSignalSource
}

function stderrLine(line: string): void {
	process.stderr.write(`${line}\n`)
}

/** `exitCode`, not `process.exit`: the log and the artifact are already flushed, and a hard exit could truncate piped stderr. */
function setProcessExitCode(code: number): void {
	process.exitCode = code
}

/** The two verbs of the process EventEmitter `exec` subscribes to — structurally both `process` and a bare `EventEmitter`. */
export interface ExecSignalSource {
	on(signal: string, handler: () => void): unknown
	off(signal: string, handler: () => void): unknown
}

/**
 * `/workflow exec` — resolve and validate exactly like `run` (any failure there is exit 4), then
 * drive the run to its terminal state in the foreground. SIGINT/SIGTERM take the engine's graceful
 * cancellation path — the same durable `run-cancelled` + cooperative abort `/workflow cancel` uses —
 * and the run's eventual `cancelled` result is what exit 3 reports, so the checkpoint that lets the
 * run be resumed always lands before the process ends.
 */
export async function handleExec(
	ctx: CommandCtx,
	store: RunStore,
	activeRuns: ActiveRuns,
	startAgent: StartAgent,
	args: Pick<ParsedExecArgs, "target" | "inputArg" | "resultOut"> & { target: string },
	deps: ExecDeps = {},
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
				const filePath = path.isAbsolute(args.resultOut) ? args.resultOut : path.resolve(ctx.cwd, args.resultOut)
				const artifact = resultArtifact(executed.result, resolved.workflow.name, await store.loadEvents(executed.runId))
				const writeError = await writeResultArtifact(filePath, artifact)
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
