import { createTestRun } from "@kimchi-dev/kimchi-workflows/testing"
import { expect, it } from "vitest"
import workflow from "./external-dependency.workflow.ts"

it("resolves and executes the workflow package's declared third-party dependency", async () => {
	const run = await createTestRun(workflow)

	expect(run.status).toBe("completed")
	expect(run.output).toEqual({
		dependency: "slugify",
		input: "Kimchi resolves workflow-local dependencies",
		slug: "kimchi-resolves-workflow-local-dependencies",
	})
})
