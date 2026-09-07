/**
 * Host side of the output-tool contract (engine/output-tools.ts): the handoff that lets a SPAWNED step
 * register `workflow_submit_result`/`workflow_submit_questions` typed by that step's own schema, and the registration
 * itself.
 *
 * Why a handoff at all: a background/isolated step runs as a fresh `kimchi` process (pi-agent.ts), and
 * tools are registered once at extension load. A per-step schema therefore has to reach that process
 * before it loads — hence a file whose path travels in the environment. The process boundary is what
 * makes per-step tool schemas possible at all; a single long-lived process could not do it.
 *
 * The handlers acknowledge and terminate the PI tool loop while stamping an attributed submission in
 * the tool result's `details`. PI persists that record before the logical run settles, so the in-session
 * bridge can recover it from the session without maintaining another transcript. Termination is essential:
 * without it PI asks the model for another reply, delaying the questionnaire/result and allowing a later
 * duplicate submission to replace it.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Container } from "@earendil-works/pi-tui"
import type { TSchema } from "typebox"
import {
	isOutputToolName,
	type StepSubmissionIdentity,
	SUBMIT_QUESTIONS_TOOL,
	SUBMIT_RESULT_TOOL,
	submitQuestionsParameters,
	submitResultParameters,
	WORKFLOW_STEP_SUBMISSION_TYPE,
	type WorkflowStepSubmissionDetails,
} from "../engine/output-tools.ts"

/** Env var naming the JSON file that describes which output tools a spawned step should register. */
export const STEP_OUTPUT_TOOLS_ENV = "KIMCHI_WORKFLOW_STEP_OUTPUT_TOOLS"

/** The complete per-execution contract handed to an in-process or spawned workflow step. */
export interface StepOutputToolSpec {
	readonly outputSchema: TSchema
	readonly asks?: boolean
	/** Filled from the active AgentRequest by the host, never by the model. */
	readonly identity: StepSubmissionIdentity
}

/**
 * Workflow output tools are an internal transport, not user-facing agent activity. Standard PI
 * removes a self-rendered tool row when both slots return empty components. Hosts that replace PI's
 * tool renderers may choose to show their own activity row, but the package still requests no UI.
 */
const HIDDEN_TOOL_RENDERING = {
	renderShell: "self" as const,
	renderCall: () => new Container(),
	renderResult: () => new Container(),
}

/**
 * Write the handoff for one step and return its path.
 *
 * TypeBox 1.x schemas are plain objects with no symbol metadata, so a JSON round-trip is lossless —
 * verified, and the reason this can be a file at all.
 */
export function writeStepOutputToolSpec(dir: string, fileStem: string, spec: StepOutputToolSpec): string {
	const file = path.join(dir, `${fileStem}.output-tools.json`)
	writeFileSync(file, JSON.stringify(spec), "utf8")
	return file
}

/** Delete a handoff once the child that needed it has started; never throws. */
export function removeStepOutputToolSpec(file: string): void {
	rmSync(file, { force: true })
}

/** Read a handoff written by {@link writeStepOutputToolSpec}; undefined if it is missing or unreadable. */
export function readStepOutputToolSpec(file: string): StepOutputToolSpec | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as StepOutputToolSpec
		if (!parsed || typeof parsed !== "object" || !parsed.outputSchema || !isStepSubmissionIdentity(parsed.identity)) {
			return undefined
		}
		return parsed
	} catch {
		// A missing or corrupt handoff means no tools, and with no text channel the step will fail — but it
		// must fail through the engine's own violation path, not by throwing out of extension load.
		return undefined
	}
}

function isStepSubmissionIdentity(identity: unknown): identity is StepSubmissionIdentity {
	if (!identity || typeof identity !== "object") return false
	const record = identity as Record<string, unknown>
	return typeof record.runId === "string" && typeof record.path === "string" && typeof record.attempt === "number"
}

/** Build the framework-owned record PI will persist on the successful tool result. */
function submissionDetails(
	spec: StepOutputToolSpec,
	kind: WorkflowStepSubmissionDetails["kind"],
	payload: unknown,
): WorkflowStepSubmissionDetails {
	return { type: WORKFLOW_STEP_SUBMISSION_TYPE, kind, ...spec.identity, payload }
}

/**
 * Register the output tools for a step.
 *
 * Registration alone does NOT scope them: `ExtensionAPI` has no unregister, and a definition stays in the
 * runtime's tool map for the process's life. In a spawned step that is harmless — the process is the
 * step. In a shared session it is not, so callers there must pair this with {@link activeToolsForStep}.
 */
export function registerStepOutputTools(pi: ExtensionAPI, spec: StepOutputToolSpec): void {
	pi.registerTool(
		defineTool({
			name: SUBMIT_RESULT_TOOL,
			label: "Submit result",
			...HIDDEN_TOOL_RENDERING,
			description:
				"Submit this step's result. Pass the result as the `result` argument. Call this once you are done; you may explain your reasoning around the call.",
			parameters: submitResultParameters(spec.outputSchema),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: "Result submitted." }],
				details: submissionDetails(spec, "result", params),
				terminate: true,
			}),
		}),
	)

	if (!spec.asks) return

	pi.registerTool(
		defineTool({
			name: SUBMIT_QUESTIONS_TOOL,
			label: "Submit questions",
			...HIDDEN_TOOL_RENDERING,
			description:
				"Ask the user for information instead of submitting a result. Batch every question you need into one call. The run pauses until the answers come back.",
			parameters: submitQuestionsParameters(),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: "Questions submitted. The run will resume with the answers." }],
				details: submissionDetails(spec, "questions", params),
				terminate: true,
			}),
		}),
	)
}

/**
 * The active tool set for a step, given what was active before the workflow touched it.
 *
 * A shared session runs every step in one process, so a tool registered for one step is visible to all
 * the others unless the ACTIVE set is narrowed per step. Three leaks this closes: a step that cannot
 * block still seeing `workflow_submit_questions` (which the engine rejects, burning its repair budget); a step
 * with no contract still seeing `workflow_submit_result` typed by the PREVIOUS step's schema (its output would
 * silently become `""`); and both tools surviving into the user's own session after the run.
 *
 * Pass `baseline` back with no spec to restore it.
 */
export function activeToolsForStep(baseline: readonly string[], spec?: StepOutputToolSpec): string[] {
	const rest = baseline.filter((name) => !isOutputToolName(name))
	if (!spec) return rest
	return spec.asks ? [...rest, SUBMIT_RESULT_TOOL, SUBMIT_QUESTIONS_TOOL] : [...rest, SUBMIT_RESULT_TOOL]
}

/**
 * Register the output tools if this process was spawned as a workflow step, and report whether it did.
 *
 * Returning false is the ordinary case: a normal session is not a step, and must not gain these tools.
 *
 * The variable is CONSUMED, not merely read: a step's own descendants inherit its environment, so a
 * `kimchi` the step happens to launch would otherwise register another step's tools against another
 * step's schema and lose `/workflow` with it. The handoff addresses this process alone.
 */
export function registerStepOutputToolsFromEnv(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): boolean {
	const file = env[STEP_OUTPUT_TOOLS_ENV]
	if (!file) return false
	const spec = readStepOutputToolSpec(file)
	// Consumed, so a `kimchi` this step launches does not inherit another step's contract.
	delete env[STEP_OUTPUT_TOOLS_ENV]
	if (!spec) {
		// The handoff named this process as a step, so it IS one even though the contract is unreadable:
		// returning false would let it register `/workflow` and start a nested run inside the run it
		// belongs to. It has no tools, so its step will fail — this is the only place that can say why.
		console.error(
			`[kimchi-workflows] step output-tool handoff at ${file} is missing or unreadable; this step has no submit tools and will fail to produce output.`,
		)
		return true
	}
	registerStepOutputTools(pi, spec)
	return true
}
