import { describe, expect, it } from "vitest"
import {
	workflowCrashHeading,
	workflowCrashMessage,
	workflowCrashRecovery,
	workflowFailureLine,
} from "../src/host/failure-messages.ts"

describe("actionable workflow failure messages", () => {
	const crash = {
		workflowName: "release",
		runId: "workflow-release-deadbeef",
		path: "publish/package",
		cause: "registry denied the release",
	}

	it("defines the complete command-level crash contract in one place", () => {
		expect(workflowCrashMessage(crash)).toBe(
			[
				'workflow "release" crashed at "publish/package" (run workflow-release-deadbeef)',
				"  registry denied the release",
				"  Resume: /workflow resume workflow-release-deadbeef",
				"  Details: /workflow status workflow-release-deadbeef",
			].join("\n"),
		)
	})

	it("keeps location optional while retaining workflow and run identity", () => {
		expect(workflowCrashHeading({ ...crash, path: undefined })).toBe(
			'workflow "release" crashed (run workflow-release-deadbeef)',
		)
	})

	it("shares recovery commands and status failure wording with specialized surfaces", () => {
		expect(workflowCrashRecovery(crash.runId)).toEqual([
			"Resume: /workflow resume workflow-release-deadbeef",
			"Details: /workflow status workflow-release-deadbeef",
		])
		expect(workflowFailureLine(crash)).toBe('Failure at "publish/package": registry denied the release')
	})
})
