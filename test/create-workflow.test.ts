import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import createWorkflowWorkflow from "../src/host/builtin/create.workflow.ts"
import { loadWorkflowFile } from "../src/host/load-workflow.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import { ask, createTestRun, reply, withSideEffect } from "../src/testing/index.ts"

/**
 * The `/workflow create` meta-workflow, driven end-to-end offline: its `design` agent and `approve`
 * interaction is scripted, so the whole interview → approve/revise → generate → validate → write
 * path runs with no model.
 */

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")

/** A valid generated module. Absolute import: the file is written to a temp dir with no node_modules. */
const validSource = [
	`import { createStep, createWorkflow } from "${flowImport}";`,
	`const greet = createStep({ name: "greet", run: () => ({ message: "hi" }) });`,
	`export default createWorkflow({ name: "greeter", description: "says hi" }).then(greet).commit();`,
].join("\n")

const typeInvalidSource = [
	'import { Type } from "typebox";',
	`import { createStep, createWorkflow } from "${flowImport}";`,
	`const greet = createStep({ name: "greet", output: Type.Object({ message: Type.String() }), run: () => ({ message: 42 }) });`,
	`export default createWorkflow({ name: "greeter", description: "says hi" }).then(greet).commit();`,
].join("\n")

const spec = {
	name: "greeter",
	description: "says hi",
	summary: "One function step that returns a greeting.",
	schemas: [],
	nodes: [
		{
			name: "greet",
			kind: "function" as const,
			purpose: "return a greeting",
			inputSource: "none" as const,
		},
	],
}

const revisedSpec = { ...spec, summary: "One function step that returns a personalized greeting." }

const clarify = ask({
	questions: [{ key: "detail", header: "Detail", question: "What should it greet?", kind: "text" }],
})

const projectRoot = () => mkdtemp(path.join(tmpdir(), "pi-create-"))

/** Simulate the real agent's filesystem edit, then submit only the entry-file path. */
function generated(entryPath: string, source: string, verification = "framework validation only") {
	return withSideEffect(reply({ entryPath, verification }), () => writeFile(entryPath, source, "utf8"))
}

describe("/workflow create meta-workflow", () => {
	it("interviews, revises on request, approves, and writes the approved workflow into the project's workflows dir (spec §6.6)", async () => {
		const root = await projectRoot()
		const written = path.join(workflowsDir(root), "greeter.workflow.ts")

		// 1. The opening form (deterministic, no LLM).
		const brief = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: {
				design: [clarify, reply(spec), reply(revisedSpec)], // iteration 1: clarify then propose; iteration 2: revise
				generate: [generated(written, validSource, "ran tsc --noEmit: clean")],
			},
		})

		expect(brief.status).toBe("blocked")
		expect(brief.path).toBe("brief")
		expect(brief.questionKeys()).toEqual(["goal", "fileName"])

		// 2. `design` — a Q&A agent step now nested INSIDE the `review` loop's first iteration (spec
		//    §8.5: blocking is legal anywhere) — clarifies before proposing.
		const clarifying = await brief.answer({ goal: "greet the user", fileName: "greeter.workflow.ts" })
		expect(clarifying.status).toBe("blocked")
		expect(clarifying.path).toBe("review#1/design")
		expect(clarifying.questionKeys()).toEqual(["detail"])

		// Answering continues the SAME agent loop (spec §8.4/§8.5): a fresh "ask" session, then a SECOND
		// session seeded with that session's history (not a third-party fresh session re-asking from
		// scratch) — the framework's established resume-continuation shape (see questionnaire-step.test.ts).
		const proposed = await clarifying.answer({ detail: "the world" })
		expect(proposed.status).toBe("blocked")
		expect(proposed.path).toBe("review#1/approve")
		expect((proposed.interaction as { markdown: string }).markdown).toContain("# Proposed workflow: `greeter`")
		expect(proposed.agent("design").sessions).toBe(2) // fresh ask + history-seeded continuation
		expect(proposed.agent("design").messages).toHaveLength(2) // original prompt + the clarify answer

		// 3. Revise: `approve` blocks the SAME loop with a newly rendered plan at iteration 2 —
		//    the proof this is a real `.dountil` loop, not a single step crammed with the whole interview.
		const revising = await proposed.respond({ decision: "revise", feedback: "make it personal" })
		expect(revising.status).toBe("blocked")
		expect(revising.path).toBe("review#2/approve") // iteration 2 — the loop actually re-entered, not restarted
		expect(revising.eventsOf("loop-iteration").filter((event) => event.path.startsWith("review#"))).toHaveLength(2)
		// `design`'s revision pass is a FRESH session (a new loop iteration, not a re-blocked step) —
		// exactly the distinction spec §8.4 draws between question suspension and a fresh attempt.
		expect(revising.agent("design").sessions).toBe(3)

		// 4. Approval reserves the final path; generate edits it, then check → complete follows.
		const done = await revising.respond({ decision: "approve" })
		expect(done.status, `${done.error}; check=${JSON.stringify(done.stepOutput("until-valid/check"))}`).toBe(
			"completed",
		)

		expect(done.output).toEqual({ path: written })
		expect(await readFile(written, "utf8")).toBe(validSource)

		// The file it wrote is a real, loadable workflow.
		const loaded = await loadWorkflowFile(written)
		expect(loaded.name).toBe("greeter")
		expect(loaded.description).toBe("says hi")
	})

	it("retries generation when the produced source does not load, and reports the error to the agent", async () => {
		const root = await projectRoot()
		const written = path.join(workflowsDir(root), "greeter.workflow.ts")

		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: {
				design: [reply(spec)],
				generate: [
					generated(written, "export default { not: 'a workflow' };", "no tooling available"),
					generated(written, validSource, "ran tsc --noEmit: clean"),
				],
			},
		})

		const proposed = await run.answer({ goal: "greet the user", fileName: "greeter.workflow.ts" })
		expect(proposed.status).toBe("blocked")
		const done = await proposed.respond({ decision: "approve" })

		expect(done.status, `${done.error}; check=${JSON.stringify(done.stepOutput("until-valid/check"))}`).toBe(
			"completed",
		)
		expect(done.eventsOf("loop-iteration").filter((event) => event.path.startsWith("until-valid#"))).toHaveLength(2) // first generation rejected, second accepted
		// The retry prompt carried the loader's complaint, so the agent could see what was wrong.
		expect(done.agent("generate").messages[1]).toMatch(/files currently on disk FAILED/)
		expect(done.agent("generate").messages[1]).toMatch(/does not export a workflow/)
		expect(done.agent("generate").messages[1]).not.toContain("export default { not: 'a workflow' }")
		expect(await readFile(written, "utf8")).toBe(validSource)
	})

	it("rejects a type-invalid candidate and sends the compiler diagnostic into the repair turn", async () => {
		const root = await projectRoot()
		const written = path.join(workflowsDir(root), "greeter.workflow.ts")
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: {
				design: [reply(spec)],
				generate: [generated(written, typeInvalidSource), generated(written, validSource)],
			},
		})

		const proposed = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" })
		const done = await proposed.respond({ decision: "approve" })

		expect(done.status).toBe("completed")
		expect(done.agent("generate").messages[1]).toContain("TypeScript validation failed")
		expect(done.agent("generate").messages[1]).toMatch(/number.*not assignable.*string/i)
		expect(done.agent("generate").messages[1]).not.toContain(typeInvalidSource)
		expect(await readFile(written, "utf8")).toBe(validSource)
	})

	it("does not complete when the files never validate, leaving the in-place candidate available for inspection", async () => {
		const root = await projectRoot()
		const written = path.join(root, ".pi", "workflows", "greeter.workflow.ts")
		const bad = () => generated(written, "export default { not: 'a workflow' };", "no tooling available")

		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root },
			agents: { design: [reply(spec)], generate: [bad(), bad(), bad()] },
		})

		const proposed = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" })
		const crashed = await proposed.respond({ decision: "approve" })

		expect(crashed.status).toBe("crashed")
		expect(crashed.error).toMatch(/exceeded its max of 3 iterations/)
		expect(crashed.eventsOf("step-completed").some((event) => event.path === "complete")).toBe(false)
		expect(await readFile(written, "utf8")).toContain("not: 'a workflow'")
	})

	it("appends the .workflow.ts suffix when the user gives a bare name", async () => {
		const root = await projectRoot()
		const written = path.join(workflowsDir(root), "greeter.workflow.ts")

		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: {
				design: [reply(spec)],
				generate: [generated(written, validSource, "ran tsc --noEmit: clean")],
			},
		})

		const proposed = await run.answer({ goal: "greet", fileName: "greeter" })
		const done = await proposed.respond({ decision: "approve" })

		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ path: written })
	})

	it("treats a name containing a separator as a path relative to the project root", async () => {
		const root = await projectRoot()
		const written = path.join(root, "flows", "greeter.workflow.ts")

		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root },
			agents: {
				design: [reply(spec)],
				generate: [generated(written, validSource, "ran tsc --noEmit: clean")],
			},
		})

		const proposed = await run.answer({ goal: "greet", fileName: "flows/greeter.workflow.ts" })
		const done = await proposed.respond({ decision: "approve" })

		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ path: written })
	})

	it("validates a multi-file workflow through relative imports and submits only its main entry path", async () => {
		const root = await projectRoot()
		const entryPath = path.join(workflowsDir(root), "greeter.workflow.ts")
		const helperPath = path.join(workflowsDir(root), "greet-step.ts")
		const entrySource = [
			`import { createWorkflow } from "${flowImport}";`,
			'import { greet } from "./greet-step.ts";',
			'export default createWorkflow({ name: "greeter", description: "says hi" }).then(greet).commit();',
		].join("\n")
		const helperSource = [
			`import { createStep } from "${flowImport}";`,
			'export const greet = createStep({ name: "greet", run: () => ({ message: "hi" }) });',
		].join("\n")
		const helperWithPlaceholder = [
			`import { createStep } from "${flowImport}";`,
			'export const greet = createStep({ name: "greet", run: () => { throw new Error("TODO_WORKFLOW: greet") } });',
		].join("\n")

		const incomplete = withSideEffect(reply({ entryPath, verification: "framework validation only" }), async () => {
			await Promise.all([
				writeFile(entryPath, entrySource, "utf8"),
				writeFile(helperPath, helperWithPlaceholder, "utf8"),
			])
		})
		const repaired = withSideEffect(reply({ entryPath, verification: "framework validation only" }), async () => {
			await Promise.all([writeFile(entryPath, entrySource, "utf8"), writeFile(helperPath, helperSource, "utf8")])
		})
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: { design: [reply(spec)], generate: [incomplete, repaired] },
		})

		const proposed = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" })
		const done = await proposed.respond({ decision: "approve" })

		expect(done.status).toBe("completed")
		expect(done.output).toEqual({ path: entryPath })
		expect((done.stepOutput("until-valid/generate") as Record<string, unknown>).source).toBeUndefined()
		expect(done.agent("generate").messages[1]).toContain("source still contains TODO_WORKFLOW")
		expect((await loadWorkflowFile(entryPath)).nodes).toHaveLength(1)
	})

	it("rejects a submitted entry path other than the path reserved by this run", async () => {
		const root = await projectRoot()
		const entryPath = path.join(workflowsDir(root), "greeter.workflow.ts")
		const wrongPath = path.join(workflowsDir(root), "different.workflow.ts")
		const wrongSubmission = withSideEffect(
			reply({ entryPath: wrongPath, verification: "framework validation only" }),
			() => writeFile(entryPath, validSource, "utf8"),
		)
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: { design: [reply(spec)], generate: [wrongSubmission, generated(entryPath, validSource)] },
		})

		const proposed = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" })
		const done = await proposed.respond({ decision: "approve" })

		expect(done.status).toBe("completed")
		expect(done.agent("generate").messages[1]).toMatch(/submitted entryPath resolves to/)
		expect(done.agent("generate").messages[1]).toContain(entryPath)
	})
})

describe("/workflow create never destroys existing work (adversarial regression)", () => {
	const scripted = (entryPath: string) => ({
		design: [reply(spec)],
		generate: [generated(entryPath, validSource, "ran tsc --noEmit: clean")],
	})

	it("rejects a taken name before the interview, so nothing is spent on it", async () => {
		const root = await projectRoot()
		await mkdir(workflowsDir(root), { recursive: true })
		await writeFile(path.join(workflowsDir(root), "greeter.workflow.ts"), "// taken\n", "utf8")

		// No agent scripts at all: if the interview were reached, the double would throw for the
		// unscripted `design` step. Crashing cleanly proves the name is settled before any model runs.
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
		})
		const clash = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" })

		expect(clash.status).toBe("crashed")
		expect(clash.error).toMatch(/already exists/)
		expect(clash.eventsOf("step-started").map((event) => event.path)).toEqual(["brief", "target"])
	})

	it("rejects an escaping name before the interview too", async () => {
		const root = await projectRoot()

		const run = await createTestRun(createWorkflowWorkflow, { input: { projectRoot: root } })
		const escaped = await run.answer({ goal: "greet", fileName: "../escaped.workflow.ts" })

		expect(escaped.status).toBe("crashed")
		expect(escaped.error).toMatch(/resolves outside the project/)
		expect(escaped.eventsOf("step-started").map((event) => event.path)).toEqual(["brief", "target"])
	})

	it("fails rather than overwriting an existing file, and leaves it untouched", async () => {
		const root = await projectRoot()
		const taken = path.join(workflowsDir(root), "greeter.workflow.ts")
		await mkdir(workflowsDir(root), { recursive: true })
		await writeFile(taken, "// hand-written, precious\n", "utf8")

		// `target` settles (and rejects) the destination right after `brief`, before the review loop
		// ever starts (spec §6.6) — so this crashes without ever reaching `design`.
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: scripted(taken),
		})
		const clash = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" })

		expect(clash.status).toBe("crashed")
		expect(clash.error).toMatch(/already exists/)
		expect(clash.error).toMatch(/re-run with a different name/)
		expect(await readFile(taken, "utf8")).toBe("// hand-written, precious\n") // untouched
		expect(clash.eventsOf("step-completed").some((event) => event.path === "complete")).toBe(false)
	})

	it("uses an exclusive scaffold write if the target appears while the plan is being reviewed", async () => {
		const root = await projectRoot()
		const target = path.join(workflowsDir(root), "greeter.workflow.ts")
		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root, workflowsDir: workflowsDir(root) },
			agents: scripted(target),
		})
		const proposed = await run.answer({ goal: "greet", fileName: "greeter.workflow.ts" })
		await mkdir(path.dirname(target), { recursive: true })
		await writeFile(target, "// created while reviewing\n", "utf8")

		const raced = await proposed.respond({ decision: "approve" })

		expect(raced.status).toBe("crashed")
		expect(raced.error).toMatch(/appeared before it could be reserved/)
		expect(await readFile(target, "utf8")).toBe("// created while reviewing\n")
		expect(raced.agent("generate").sessions).toBe(0)
	})

	it("refuses a file name that escapes the project root", async () => {
		const root = await projectRoot()

		const run = await createTestRun(createWorkflowWorkflow, {
			input: { projectRoot: root },
			agents: scripted(path.join(root, ".pi", "workflows", "escaped.workflow.ts")),
		})
		const escaped = await run.answer({ goal: "greet", fileName: "../escaped.workflow.ts" })

		// `target` settles (and rejects) the destination right after `brief`, before the review loop ever
		// starts (spec §6.6) — so this crashes without ever reaching `design`.
		expect(escaped.status).toBe("crashed")
		expect(escaped.error).toMatch(/resolves outside the project/)
	})
})
