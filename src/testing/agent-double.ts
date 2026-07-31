/**
 * Step-keyed agent double for workflow tests.
 *
 * An agent step is the only non-deterministic part of a workflow, so testing one means pinning what
 * the model says. This double implements the `HostPort.startAgent` seam and dispatches on
 * `request.stepName` (spec §2.2): each step has its own queue of scripted turns, consumed in order
 * **across sessions** — so a retry (fresh session) or an answer-resume (session seeded with history)
 * simply takes the next entry. Authors script "what this step says, in order"; session boundaries are
 * the engine's business, not the test's.
 *
 * Contrast with test/scripted-agent.ts, which scripts turns positionally *per session*. That one is
 * for engine tests that assert session mechanics (sessions opened, history seeding, disposal); this
 * one is for workflow authors, who should not have to know where a session begins.
 */

import { SUBMIT_QUESTIONS_TOOL, SUBMIT_RESULT_TOOL } from "../engine/output-tools.ts"
import type { AgentRequest, AgentSession, ConversationMessage } from "../engine/types.ts"
import type { Questionnaire } from "../flow/questionnaire.ts"
import type { AgentStep, WorkflowNode } from "../flow/types.ts"
import { forEachNode } from "../flow/types.ts"

/**
 * One scripted agent turn. Built by {@link ask}, {@link reply}, {@link raw}, {@link throws} and
 * {@link usage} — never written by hand, so the wire encoding stays an implementation detail.
 */
export type AgentTurnScript =
	/** A `submit_*` tool call — the only channel a step under a contract reports through. */
	| { kind: "submit"; tool: string; args: Record<string, unknown>; trailingText?: string; totalTokens?: number }
	/** Text and no submission — drives the in-session output-steering repair (spec §9.2). */
	| { kind: "raw"; text: string; totalTokens?: number }
	/** A transport failure — drives the step's outer retry policy (spec §9.1). */
	| { kind: "throws"; error: Error }

/** Script the agent asking: a `submit_questions` call, on which the run blocks (spec §10.1). */
export function ask(questionnaire: Questionnaire, trailingText?: string): AgentTurnScript {
	return { kind: "submit", tool: SUBMIT_QUESTIONS_TOOL, args: { ...questionnaire }, trailingText }
}

/**
 * Script the step's success payload: a `submit_result` call carrying `value`.
 *
 * `trailingText` is prose the model wrote AFTER submitting — what an injected harness nudge leaves
 * behind. It must never be mistaken for the output, which is the point of submitting through a tool.
 */
export function reply(value: unknown, trailingText?: string): AgentTurnScript {
	return { kind: "submit", tool: SUBMIT_RESULT_TOOL, args: { result: value }, trailingText }
}

/** Script a turn that says something and submits nothing, to exercise output steering (spec §9.2). */
export function raw(text: string): AgentTurnScript {
	return { kind: "raw", text }
}

/** Script an arbitrary tool call by name, for contract tests (an unrelated tool must never be read as output). */
export function submitRaw(tool: string, args: Record<string, unknown>, trailingText?: string): AgentTurnScript {
	return { kind: "submit", tool, args, trailingText }
}

/** Script a thrown transport error, to exercise the retry policy (spec §9.1). */
export function throws(error: Error | string): AgentTurnScript {
	return { kind: "throws", error: typeof error === "string" ? new Error(error) : error }
}

/** Attach token usage to any scripted turn, to exercise the per-step token budget (spec §9.3). */
export function usage(turn: AgentTurnScript, totalTokens: number): AgentTurnScript {
	if (turn.kind === "throws") throw new Error("usage(): a thrown turn reports no token usage")
	return { ...turn, totalTokens }
}

/** What a step's double recorded, for assertions. */
export interface AgentRecord {
	/** Every message the engine sent this step (prompt, steering corrections, delivered answers), in order. */
	readonly messages: readonly string[]
	/** The resolved model for each session opened for this step, in order. */
	readonly models: readonly (string | undefined)[]
	/** Sessions opened for this step: one per fresh attempt, retry, or answer-resume. */
	readonly sessions: number
	/** Scripted turns not consumed by the end of the run. */
	readonly remaining: number
}

export interface AgentDouble {
	startAgent(request: AgentRequest): AgentSession
	/** What the double recorded for `stepName` (zeroed if the step never ran). */
	record(stepName: string): AgentRecord
}

/** Per-step scripts, keyed by step name. */
export type AgentScripts = Readonly<Record<string, readonly AgentTurnScript[]>>

/**
 * Build the double. `nodes` is the workflow's node tree: it resolves each scripted name to its
 * `AgentStep`, which (a) rejects scripts naming a step that is not an agent step, (b) rejects an
 * `ask(...)` scripted against a step that cannot block, and (c) tells `reply(...)` which wire shape to
 * emit. Failing at construction beats failing later as an opaque schema violation.
 */
export function createAgentDouble(nodes: readonly WorkflowNode[], scripts: AgentScripts): AgentDouble {
	const agentSteps = collectAgentSteps(nodes)
	const queues = new Map<string, AgentTurnScript[]>()
	const records = new Map<string, { messages: string[]; models: (string | undefined)[]; sessions: number }>()

	for (const [stepName, turns] of Object.entries(scripts)) {
		const step = agentSteps.get(stepName)
		if (!step) {
			throw new Error(
				`agent script for "${stepName}": the workflow has no agent step with that name (agent steps: ${[...agentSteps.keys()].join(", ") || "none"})`,
			)
		}
		const asked = turns.findIndex((turn) => turn.kind === "submit" && turn.tool === SUBMIT_QUESTIONS_TOOL)
		if (asked !== -1 && !step.asks) {
			throw new Error(
				`agent script for "${stepName}": ask() at index ${asked} requires a step declared asks: true — a plain agent step can never block`,
			)
		}
		queues.set(stepName, [...turns])
		records.set(stepName, { messages: [], models: [], sessions: 0 })
	}

	const startAgent = (request: AgentRequest): AgentSession => {
		const { stepName } = request
		const queue = queues.get(stepName)
		const record = records.get(stepName)
		if (!(queue && record)) {
			throw new Error(
				`agent step "${stepName}" ran but no replies were scripted for it (scripted steps: ${[...queues.keys()].join(", ") || "none"})`,
			)
		}
		const step = agentSteps.get(stepName)
		if (!step) throw new Error(`unreachable: step "${stepName}" was validated at construction`)

		record.sessions += 1
		record.models.push(request.model)
		const conversation: ConversationMessage[] = [...(request.history ?? [])]

		return {
			async sendAndAwaitEnd(message: string) {
				record.messages.push(message)
				conversation.push({ role: "user", content: message })

				const turn = queue.shift()
				if (turn === undefined) {
					throw new Error(`agent step "${stepName}" was called more times than it has scripted replies`)
				}
				if (turn.kind === "throws") throw turn.error

				const usage = turn.totalTokens === undefined ? undefined : { totalTokens: turn.totalTokens }

				// A submitted payload rides the transcript, not the text: the trailing prose is what a real
				// harness nudge leaves behind, and must not be mistaken for the step's answer.
				if (turn.kind === "submit") {
					const text = turn.trailingText ?? ""
					if (text) conversation.push({ role: "assistant", content: text })
					return { text, usage, submitted: { tool: turn.tool, arguments: turn.args } }
				}

				conversation.push({ role: "assistant", content: turn.text })
				return { text: turn.text, usage }
			},
			getConversation() {
				return conversation
			},
			dispose() {},
		}
	}

	return {
		startAgent,
		record(stepName: string): AgentRecord {
			const record = records.get(stepName)
			return {
				messages: record?.messages ?? [],
				models: record?.models ?? [],
				sessions: record?.sessions ?? 0,
				remaining: queues.get(stepName)?.length ?? 0,
			}
		},
	}
}

/** Every agent step in the tree, by name — including those nested in branches, loops, and sub-workflows. */
function collectAgentSteps(nodes: readonly WorkflowNode[]): Map<string, AgentStep> {
	const steps = new Map<string, AgentStep>()
	forEachNode(nodes, (node) => {
		if (node.kind === "step" && node.step.kind === "agent") steps.set(node.step.name, node.step)
	})
	return steps
}
