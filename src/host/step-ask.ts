/**
 * A follow-up question to a step's recorded conversation (inspection, specs/progress-ui.md §14.13) —
 * the workflows answer to "ask the subagent" in PI's subagent view.
 *
 * The step's transcript file IS a PI session: the isolated path spawns `--session <file>` against it,
 * and the in-session path writes sidecars in PI's own entry shape under the same naming rule — so the
 * follow-up is one more spawned-worker turn against that same file. The question APPENDS to the
 * conversation, which is the point: a later resume of a resumable step continues with the follow-up
 * in context, exactly as if the step had been asked mid-flight. That also makes the ask a real
 * (billable) model turn, and it runs under the same spawned-worker posture a background step does
 * (yolo permissions — a worker has no UI to confirm prompts in).
 *
 * Never a step execution: no engine events, no run state, no bus publication. It is a read-modify of
 * a display artifact guarded by the bridge's claim map, and it never touches the run's event log.
 */
import { existsSync } from "node:fs"
import { stepSessionName } from "./naming.ts"
import { claimFollowUpFile, type PiInvocationResolver, resolvePiInvocation } from "./pi-agent.ts"
import { stepTranscriptFile } from "./step-transcript.ts"
import { runSubagent, type SubagentSpawner, subagentSpawner } from "./subagent-process.ts"

/** What an ask needs to know about the step being asked — everything the transcript loader knows. */
export interface AskStepArgs {
	readonly dir: string
	readonly workflowName: string
	readonly runId: string
	readonly path: string
	readonly attempt: number
	readonly resumeKey?: string
	/** The step's declared model, if any — the follow-up speaks to the same model the step did. */
	readonly model?: string
	/** The spawn seam, exactly as the bridge's background session takes it. */
	readonly spawnSubagent?: SubagentSpawner
	readonly invocationResolver?: PiInvocationResolver
}

/**
 * Ask a step's conversation one question; resolves with the follow-up's answer text.
 *
 * Throws (with a user-readable message) when there is no conversation to continue, the file is
 * claimed by a running execution, or the spawned turn failed — the caller notifies, never throws
 * through the command (§7.6.1).
 */
export async function askStep(args: AskStepArgs, question: string): Promise<string> {
	const file = stepTranscriptFile(args.dir, {
		workflowName: args.workflowName,
		runId: args.runId,
		path: args.path,
		attempt: args.attempt,
		...(args.resumeKey ? { resumeKey: args.resumeKey } : {}),
	})
	if (!existsSync(file)) {
		throw new Error(`no conversation recorded for step "${args.path}" — nothing to ask yet`)
	}
	// The spawned worker's argv is the background step's shape exactly (pi-agent.ts's backgroundSession):
	// JSON mode, the step's own session file, a legible session name. The model rides along when the step
	// declared one, so the follow-up speaks to the model that built the conversation.
	const workerArgs = [
		"--mode",
		"json",
		"-p",
		"--session",
		file,
		"--name",
		stepSessionName(args.workflowName, args.path, args.runId),
	]
	if (args.model) workerArgs.push("--model", args.model)
	const invocation = (args.invocationResolver ?? resolvePiInvocation)(workerArgs)
	const release = claimFollowUpFile(file)
	try {
		const result = await runSubagent(
			args.spawnSubagent ?? subagentSpawner,
			invocation.command,
			invocation.args,
			question,
			undefined,
			{ KIMCHI_PERMISSIONS: "yolo" },
		)
		if (result.code !== 0) {
			throw new Error(`the follow-up exited with code ${result.code}: ${result.stderrTail.trim() || "(no stderr)"}`)
		}
		const text = result.turn.text.trim()
		if (!text) throw new Error("the follow-up ended without an answer")
		return text
	} finally {
		release()
	}
}
