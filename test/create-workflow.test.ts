import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("../src/host/workflow-package.ts", async () => {
	const { prepareWorkflowPackageFixture } = await import("./workflow-package-fixture.ts")
	return { prepareWorkflowPackage: prepareWorkflowPackageFixture }
})

import createWorkflowWorkflow from "../src/host/builtin/create.workflow.ts"
import type { WorkflowPlan } from "../src/host/builtin/workflow-authoring.ts"
import { loadWorkflowFile } from "../src/host/load-workflow.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import { ask, createTestRun, reply, withSideEffect } from "../src/testing/index.ts"

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")

const validSource = [
	'import { Type } from "typebox";',
	`import { createStep, createWorkflow } from ${JSON.stringify(flowImport)};`,
	'const greet = createStep({ name: "greet", output: Type.Object({ message: Type.String() }), run: () => ({ message: "hi" }) });',
	'export default createWorkflow({ name: "greeter", description: "Says hello" }).then(greet).commit();',
].join("\n")

const plan: WorkflowPlan = {
	goal: "Greet the world",
	summary: "Produce one fixed greeting.",
	acceptanceCriteria: ["A greeting is produced"],
	decisions: ["Use a fixed greeting", "Audience: The world", "No personalization in the first version"],
	name: "greeter",
	invocation: { requiresArguments: false },
	steps: [
		{
			title: "Greet",
			purpose: "Produce the greeting",
			receives: [],
			produces: ["greeting"],
			delivers: ["Greeting returned by the workflow"],
		},
	],
}

const revisedPlan: WorkflowPlan = {
	...plan,
	summary: "Produce one enthusiastic fixed greeting.",
	acceptanceCriteria: [...plan.acceptanceCriteria, "The greeting is enthusiastic"],
	decisions: [...plan.decisions, "Use an enthusiastic tone"],
}

const clarification = ask({
	questions: [{ key: "audience", header: "Audience", question: "What should it greet?", kind: "text" }],
})

const projectRoot = () => mkdtemp(path.join(tmpdir(), "kimchi-create-"))

function happyPathTest(entryPath: string): string {
	return [
		'import { describe, expect, it } from "vitest";',
		'import { createTestRun } from "@kimchi-dev/kimchi-workflows/testing";',
		`import workflow from ${JSON.stringify(`./${path.basename(entryPath)}`)};`,
		'describe("generated workflow", () => {',
		'  it("runs its happy path", async () => {',
		"    const run = await createTestRun(workflow);",
		'    expect(run.status).toBe("completed");',
		'    expect(run.output).toEqual({ message: "hi" });',
		"  });",
		"});",
	].join("\n")
}

function generated(entryPath: string, testPath: string, source = validSource, verification?: string) {
	return withSideEffect(reply(verification ? { testPath, verification } : { testPath }), async () => {
		await Promise.all([writeFile(entryPath, source, "utf8"), writeFile(testPath, happyPathTest(entryPath), "utf8")])
	})
}

describe("/workflow create behavior-first path", () => {
	it("starts with the goal, preserves the answer as a decision, and produces a no-argument workflow with a test", async () => {
		const root = await projectRoot()
		const entryPath = path.join(workflowsDir(root), "greeter.workflow.ts")
		const testPath = path.join(workflowsDir(root), "greeter.workflow.test.ts")
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: {
				design: [clarification, reply(plan)],
				implement: [generated(entryPath, testPath)],
			},
		})

		expect(run.status).toBe("blocked")
		expect(run.path).toBe("goal")
		expect(run.questionKeys()).toEqual(["goal"])

		const clarifying = await run.answer({ goal: "Greet the world" })
		expect(clarifying.path).toBe("review#1/design")
		expect(clarifying.questionKeys()).toEqual(["audience"])

		const proposed = await clarifying.answer({ audience: "The world" })
		expect(proposed.path).toBe("review#1/approve")
		const markdown = (proposed.interaction as { markdown: string }).markdown
		expect(markdown).toContain("## Acceptance criteria")
		expect(markdown).toContain("Audience: The world")
		expect(markdown).toContain("`/workflow run greeter`")
		expect(markdown).not.toMatch(/schema|timeout|retry|token budget|concurrency/i)

		const done = await proposed.respond({ decision: "approve" })
		expect(done.status, done.error).toBe("completed")
		expect(done.output).toMatchObject({ path: entryPath, testPath, command: "/workflow run greeter" })
		expect((done.output as { verification: string }).verification).toContain("focused test passed (1 test)")
		expect(await readFile(testPath, "utf8")).toContain("createTestRun")
		expect((await loadWorkflowFile(entryPath)).inputSchema).toBeUndefined()

		const prompt = done.agent("implement").messages[0] ?? ""
		expect(prompt).toContain("Audience: The world")
		expect(prompt).toContain("WORKFLOW AUTHORING REFERENCE")
		expect(prompt).toContain("createWorkflow")
		expect(prompt).toContain("https://github.com/getkimchi/kimchi-workflows/blob/master/docs/authoring.md")
		expect(prompt).toContain("Agent steps can use registered harness tools in either execution mode")
		expect(prompt).toContain("background: true requests an isolated subprocess")
		expect(prompt).toContain("the framework will run that same")
		expect(prompt).toContain("add ordinary third-party runtime dependencies to the existing workflow package")
		expect(prompt).toContain("already a private pnpm package with its own package.json, pnpm-lock.yaml")
		expect(prompt).toContain("pnpm run verify:workflow -- --entry greeter.workflow.ts --test <colocated-test-file>")
		expect(prompt).toContain("omit it otherwise")
	})

	it("prompts for only material independent questions and an open delivery question", async () => {
		const root = await projectRoot()
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: { design: [clarification] },
		})

		const blocked = await run.answer({ goal: "Review changes" })
		const prompt = blocked.agent("design").messages[0] ?? ""
		expect(prompt).toContain("every question in one batch must be independent")
		expect(prompt).toMatch(/defer the\s+dependent question to a later batch/)
		expect(prompt).toContain("Do not ask obvious questions")
		expect(prompt).toContain("How should the workflow expose or deliver its results")
		expect(prompt).toContain("Do not assume that delivery happens at the final step")
	})

	it("preserves settled decisions across revision", async () => {
		const root = await projectRoot()
		const entryPath = path.join(workflowsDir(root), "greeter.workflow.ts")
		const testPath = path.join(workflowsDir(root), "greeter.workflow.test.ts")
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: {
				design: [reply(plan), reply(revisedPlan)],
				implement: [generated(entryPath, testPath)],
			},
		})

		const proposed = await run.answer({ goal: "Greet the world" })
		const revised = await proposed.respond({ decision: "revise", feedback: "Make it enthusiastic" })
		expect(revised.path).toBe("review#2/approve")
		expect((revised.interaction as { markdown: string }).markdown).toContain("The greeting is enthusiastic")
		const revisionPrompt = revised.agent("design").messages[1] ?? ""
		expect(revisionPrompt).toContain("PREVIOUS REVIEWED PROPOSAL")
		expect(revisionPrompt).toContain("Audience: The world")
		expect(revisionPrompt).toContain("never re-ask a settled question")

		const done = await revised.respond({ decision: "approve" })
		expect(done.status, done.error).toBe("completed")
		expect(done.agent("implement").messages[0]).toContain("Produce one enthusiastic fixed greeting")
	})

	it("normalizes the chosen name and avoids file and declared-name collisions", async () => {
		const root = await projectRoot()
		const directory = workflowsDir(root)
		await mkdir(directory, { recursive: true })
		await writeFile(
			path.join(directory, "other.workflow.ts"),
			validSource.replace('name: "greeter"', 'name: "greet-the-world"'),
			"utf8",
		)
		await writeFile(path.join(directory, "greet-the-world-2.workflow.ts"), "// reserved broken file\n", "utf8")

		const namedPlan: WorkflowPlan = { ...plan, name: "Greet the World!" }
		const entryPath = path.join(directory, "greet-the-world-3.workflow.ts")
		const testPath = path.join(directory, "greet-the-world-3.workflow.test.ts")
		const namedSource = validSource.replace('name: "greeter"', 'name: "greet-the-world-3"')
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: directory },
			agents: {
				design: [reply(namedPlan)],
				implement: [generated(entryPath, testPath, namedSource)],
			},
		})

		const proposed = await run.answer({ goal: "Greet the world" })
		expect((proposed.interaction as { markdown: string }).markdown).toContain("greet-the-world-3.workflow.ts")
		const done = await proposed.respond({ decision: "approve" })
		expect(done.status, done.error).toBe("completed")
		expect(done.output).toMatchObject({ path: entryPath, command: "/workflow run greet-the-world-3" })
	})

	it("feeds a missing happy-path test into a focused repair", async () => {
		const root = await projectRoot()
		const entryPath = path.join(workflowsDir(root), "greeter.workflow.ts")
		const testPath = path.join(workflowsDir(root), "greeter.workflow.test.ts")
		const withoutTest = withSideEffect(reply({ testPath, verification: "test not run" }), () =>
			writeFile(entryPath, validSource, "utf8"),
		)
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: { design: [reply(plan)], implement: [withoutTest, generated(entryPath, testPath)] },
		})

		const proposed = await run.answer({ goal: "Greet the world" })
		const done = await proposed.respond({ decision: "approve" })
		expect(done.status, done.error).toBe("completed")
		expect(done.eventsOf("loop-iteration").filter((event) => event.path.startsWith("until-ready#"))).toHaveLength(2)
		expect(done.agent("implement").messages[1]).toContain("ENOENT")
		expect(done.agent("implement").messages[1]).toContain("make the smallest clear repair")
	})

	it("rejects top-level input when argument-free execution was approved", async () => {
		const root = await projectRoot()
		const entryPath = path.join(workflowsDir(root), "greeter.workflow.ts")
		const testPath = path.join(workflowsDir(root), "greeter.workflow.test.ts")
		const argumentSource = [
			'import { Type } from "typebox";',
			`import { createStep, createWorkflow } from ${JSON.stringify(flowImport)};`,
			'const greet = createStep({ name: "greet", run: () => ({ message: "hi" }) });',
			'export default createWorkflow({ name: "greeter", input: Type.String() }).then(greet).commit();',
		].join("\n")
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: {
				design: [reply(plan)],
				implement: [generated(entryPath, testPath, argumentSource), generated(entryPath, testPath)],
			},
		})

		const proposed = await run.answer({ goal: "Greet the world" })
		const done = await proposed.respond({ decision: "approve" })
		expect(done.status, done.error).toBe("completed")
		expect(done.agent("implement").messages[1]).toContain("declares top-level input")
	})

	it("keeps repairing after three failed submissions", async () => {
		const root = await projectRoot()
		const entryPath = path.join(workflowsDir(root), "greeter.workflow.ts")
		const testPath = path.join(workflowsDir(root), "greeter.workflow.test.ts")
		const wrongSource = validSource.replace('name: "greeter"', 'name: "wrong-name"')
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: {
				design: [reply(plan)],
				implement: [
					generated(entryPath, testPath, wrongSource),
					generated(entryPath, testPath, wrongSource),
					generated(entryPath, testPath, wrongSource),
					generated(entryPath, testPath),
				],
			},
		})

		const proposed = await run.answer({ goal: "Greet the world" })
		const done = await proposed.respond({ decision: "approve" })

		expect(done.status, done.error).toBe("completed")
		expect(done.eventsOf("loop-iteration").filter((event) => event.path.startsWith("until-ready#"))).toHaveLength(4)
		expect(done.agent("implement").messages[3]).toContain('authored workflow is named "wrong-name"')
	})
})

describe("/workflow create never overwrites existing work", () => {
	it("fails safely if the reviewed destination appears before reservation", async () => {
		const root = await projectRoot()
		const entryPath = path.join(workflowsDir(root), "greeter.workflow.ts")
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: { design: [reply(plan)] },
		})
		const proposed = await run.answer({ goal: "Greet the world" })
		await mkdir(path.dirname(entryPath), { recursive: true })
		await writeFile(entryPath, "// precious\n", "utf8")

		const raced = await proposed.respond({ decision: "approve" })
		expect(raced.status).toBe("crashed")
		expect(raced.error).toContain("appeared before it could be reserved")
		expect(await readFile(entryPath, "utf8")).toBe("// precious\n")
		expect(raced.agent("implement").sessions).toBe(0)
	})
})
