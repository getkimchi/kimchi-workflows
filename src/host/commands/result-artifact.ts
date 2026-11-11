/**
 * The `--result-out` artifact: the JSON record both `run` surfaces — the headless CLI
 * (`kimchi workflow run`) and the in-session `/workflow run` — can be asked to persist at a run's
 * terminal state.
 *
 * `output` is the engine's `RunResult.output` (the workflow's final node output); `steps` collects
 * every completed step's output by its node path from the persisted log — the structured result a
 * batch consumer wants without having to learn the event-log format.
 *
 * A write failure is never fatal: it is reported back to the caller as text (CLI: stderr warning,
 * slash command: notify) and the run's outcome stands. A result file that cannot land must not
 * reclassify a run that already finished.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { RunEvent, RunResult } from "../../engine/types.ts"
import type { RunStore } from "../types.ts"
import { describe } from "./context.ts"

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
 * the caller warns and keeps the run's outcome.
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
 * The one operation both `--result-out` surfaces perform: relative paths resolve against the
 * invocation's cwd, the artifact is built from the run's own persisted log, and the failure text —
 * not an exception — comes back for the caller to warn with.
 */
export async function writeRunResultArtifact(
	store: Pick<RunStore, "loadEvents">,
	cwd: string,
	resultOut: string,
	runId: string,
	workflowName: string,
	result: RunResult,
): Promise<string | undefined> {
	const filePath = path.isAbsolute(resultOut) ? resultOut : path.resolve(cwd, resultOut)
	const artifact = resultArtifact(result, workflowName, await store.loadEvents(runId))
	return writeResultArtifact(filePath, artifact)
}
