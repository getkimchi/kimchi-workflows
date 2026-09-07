/** Minimal persisted PI branch shared by submission-reader and bridge tests. */
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import {
	type StepSubmissionIdentity,
	SUBMIT_QUESTIONS_TOOL,
	SUBMIT_RESULT_TOOL,
	WORKFLOW_STEP_SUBMISSION_TYPE,
} from "../src/engine/output-tools.ts"

export interface FakeSessionManager extends Pick<ExtensionContext["sessionManager"], "getLeafId" | "getBranch"> {
	appendMessage(message: object): string
	appendSubmission(kind: "result" | "questions", identity: StepSubmissionIdentity, payload: unknown): string
}

export function fakeSessionManager(): FakeSessionManager {
	const entries: SessionEntry[] = []
	let next = 0
	const appendMessage = (message: object): string => {
		const id = `e${++next}`
		entries.push({
			type: "message",
			id,
			parentId: entries.at(-1)?.id ?? null,
			timestamp: "2026-09-07T00:00:00.000Z",
			message: { timestamp: 0, ...message },
		} as SessionEntry)
		return id
	}
	return {
		getLeafId: () => entries.at(-1)?.id ?? null,
		getBranch: () => [...entries],
		appendMessage,
		appendSubmission: (kind, identity, payload) =>
			appendMessage({
				role: "toolResult",
				toolCallId: `submit-${next}`,
				toolName: kind === "result" ? SUBMIT_RESULT_TOOL : SUBMIT_QUESTIONS_TOOL,
				content: [{ type: "text", text: "Submitted." }],
				isError: false,
				details: { type: WORKFLOW_STEP_SUBMISSION_TYPE, kind, ...identity, payload },
			}),
	}
}
