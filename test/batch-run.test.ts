import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunResult } from "../src/engine/types.ts"
import type { CommandCtx, StartAgent } from "../src/host/commands/index.ts"
import {
	exitCodeForStatus,
	handleBatchRun,
	handleRun,
	parseRunArgs,
	resultArtifact,
	writeResultArtifact,
} from "../src/host/commands/index.ts"
import { createFsStore } from "../src/host/fs-store.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import type { RunStore } from "../src/host/types.ts"
import { createFakeActiveRuns } from "./helpers.ts"
import { prepareWorkflowPackageFixture } from "./workflow-package-fixture.ts"

type NoteType = "info" | "warning" | "error" | undefined

function notifySpy() {
	const notes: [string, NoteType][] = []
	return { notes, notify: (message: string, type?: Exclude<NoteType, undefined>) => void notes.push([message, type]) }
}

function fakeCtx(cwd: string, notify: ReturnType<typeof notifySpy>["notify"]): CommandCtx {
	return {
		cwd,
		ui: { notify } as CommandCtx["ui"],
		mode: "print",
		hasUI: false,
		modelRegistry: {} as CommandCtx["modelRegistry"],
	}
}

/** No agent steps in these workflows: opening a session at all would be the bug. */
const noAgent: StartAgent = () => {
	throw new Error("no agent expected")
}

/** Captured exit codes and stderr lines, handed to `handleBatchRun` as its process seams. */
function batchDeps() {
	const exits: number[] = []
	const warnings: string[] = []
	const lines: string[] = []
	return {
		exits,
		warnings,
		lines,
		deps: {
			exit: (code: number) => void exits.push(code),
			warn: (line: string) => void warnings.push(line),
			stderr: (line: string) => void lines.push(line),
		},
	}
}

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")

/** Echoes its initial input back out — the completed-run fixture, mirroring run-input.test.ts. */
function echoInputWorkflowSource(): string {
	return [
		`import { Type } from "typebox";`,
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`const echo = createStep({ name: "echo", run: ({ ctx }) => ctx.getInitData() ?? null });`,
		`export default createWorkflow({ name: "needs-input", input: Type.Object({ name: Type.String() }) })`,
		`  .then(echo)`,
		`  .commit();`,
	].join("\n")
}

function bareWorkflowSource(): string {
	return [
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`const echo = createStep({ name: "echo", run: ({ ctx }) => ctx.getInitData() ?? null });`,
		`export default createWorkflow({ name: "bare" }).then(echo).commit();`,
	].join("\n")
}

/** A workflow whose first step blocks on a questionnaire — the batch surface's exit-2 fixture. */
function blockingWorkflowSource(): string {
	return [
		`import { Type } from "typebox";`,
		`import { createQuestionnaireStep, createWorkflow } from "${flowImport}";`,
		`const ask = createQuestionnaireStep({ name: "ask", output: Type.Object({ name: Type.String() }) });`,
		`export default createWorkflow({ name: "blocks" }).then(ask).commit();`,
	].join("\n")
}

function crashingWorkflowSource(): string {
	return [
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`const boom = createStep({ name: "boom", run: () => { throw new Error("boom") } });`,
		`export default createWorkflow({ name: "crashes" }).then(boom).commit();`,
	].join("\n")
}

/** A first step that runs long enough for a signal to land mid-run; the second never fires after a cancel. */
function slowWorkflowSource(marker: string): string {
	return [
		`import { writeFileSync } from "node:fs";`,
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`const slow = createStep({ name: "slow", run: () => new Promise((resolve) => setTimeout(() => resolve("slow-done"), 300)) });`,
		`const after = createStep({ name: "after", run: () => { writeFileSync(${JSON.stringify(marker)}, "reached"); return "after-done" } });`,
		`export default createWorkflow({ name: "slow" }).then(slow).then(after).commit();`,
	].join("\n")
}

// -- exitCodeForStatus: the contract schedulers branch on -------------------------------------------

describe("exitCodeForStatus", () => {
	it("maps every run status onto its documented exit code", () => {
		expect(exitCodeForStatus("completed")).toBe(0)
		expect(exitCodeForStatus("blocked")).toBe(2)
		expect(exitCodeForStatus("cancelled")).toBe(3)
		expect(exitCodeForStatus("crashed")).toBe(4)
	})

	it("covers the whole status union (a fifth status would no longer compile)", () => {
		const statuses: RunResult["status"][] = ["completed", "blocked", "cancelled", "crashed"]
		for (const status of statuses) expect(exitCodeForStatus(status)).toBeGreaterThanOrEqual(0)
	})
})

// -- parseRunArgs' --result-out arm: one grammar for the slash command and the CLI --------------------

describe("parseRunArgs --result-out", () => {
	it("takes a bare target", () => {
		expect(parseRunArgs("review-loop")).toEqual({
			target: "review-loop",
			inputArg: undefined,
			resultOut: undefined,
			error: undefined,
		})
	})

	it("parses --result-out before --input, keeping the JSON payload verbatim", () => {
		expect(parseRunArgs('review-loop --result-out /out/result.json --input {"branch": "release notes"}')).toEqual({
			target: "review-loop",
			inputArg: '{"branch": "release notes"}',
			resultOut: "/out/result.json",
			error: undefined,
		})
	})

	it("parses a quoted --result-out path containing spaces", () => {
		expect(parseRunArgs('review-loop --result-out "my dir/result.json"')).toEqual({
			target: "review-loop",
			inputArg: undefined,
			resultOut: "my dir/result.json",
			error: undefined,
		})
	})

	it("extracts --result-out wherever it sits, leaving --input's payload verbatim", () => {
		const parsed = parseRunArgs("review-loop --input {} --result-out /out/x.json")
		expect(parsed).toEqual({
			target: "review-loop",
			inputArg: "{}",
			resultOut: "/out/x.json",
			error: undefined,
		})
	})

	it("does not mistake a workflow name containing the flag substring for the flag", () => {
		expect(parseRunArgs("my--input-migrator")).toMatchObject({ target: "my--input-migrator", error: undefined })
		expect(parseRunArgs("ship--result-out-fast")).toMatchObject({ target: "ship--result-out-fast", error: undefined })
	})

	it("rejects a valueless --result-out and a duplicated one", () => {
		expect(parseRunArgs("review-loop --result-out")).toMatchObject({
			error: "--result-out requires a value: <path>",
		})
		expect(parseRunArgs("review-loop --result-out /a.json --result-out /b.json")).toMatchObject({
			error: "duplicate --result-out",
		})
	})
})

// -- writeResultArtifact -----------------------------------------------------------------------------

describe("writeResultArtifact", () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "workflow-batch-artifact-"))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("creates parent directories and writes the artifact as indented JSON", async () => {
		const file = path.join(dir, "nested", "deeper", "result.json")
		const artifact = resultArtifact({ runId: "r1", status: "completed", output: { ok: true } }, "demo", [
			{ type: "step-completed", runId: "r1", path: "echo", output: { ok: true }, at: "t" },
		])
		const failure = await writeResultArtifact(file, artifact)
		expect(failure).toBeUndefined()
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			runId: "r1",
			workflowName: "demo",
			status: "completed",
			output: { ok: true },
			steps: { echo: { ok: true } },
		})
	})

	it("returns the failure text instead of throwing when the path cannot be written", async () => {
		const blocker = path.join(dir, "blocker")
		await writeFile(blocker, "a regular file", "utf8")
		const failure = await writeResultArtifact(
			path.join(blocker, "result.json"),
			resultArtifact({ runId: "r1", status: "crashed", error: "boom" }, "demo", []),
		)
		expect(failure).toMatch(/could not write the result file/)
	})

	it("keeps only the result's own run in the steps map", () => {
		const artifact = resultArtifact({ runId: "r1", status: "completed", output: 2 }, "demo", [
			{ type: "step-completed", runId: "r1", path: "a", output: 1, at: "t" },
			{ type: "step-completed", runId: "other", path: "b", output: 9, at: "t" },
		])
		expect(artifact.steps).toEqual({ a: 1 })
	})

	it("carries error and path only when the result has them", () => {
		const crashed = resultArtifact({ runId: "r1", status: "crashed", error: "boom", path: "boom" }, "demo", [])
		expect(crashed.error).toBe("boom")
		expect(crashed.path).toBe("boom")
		const completed = resultArtifact({ runId: "r1", status: "completed" }, "demo", [])
		expect(completed).not.toHaveProperty("error")
		expect(completed).not.toHaveProperty("path")
	})
})

// -- handleBatchRun end to end -----------------------------------------------------------------------

describe("handleBatchRun", () => {
	let projectRoot: string
	let store: RunStore

	beforeEach(async () => {
		projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-batch-"))
		await mkdir(path.join(projectRoot, "sessions", "workflow"), { recursive: true })
		await prepareWorkflowPackageFixture({ directory: workflowsDir(projectRoot) })
		store = createFsStore(path.join(projectRoot, "sessions", "workflow"))
		vi.stubEnv("PI_CODING_AGENT_DIR", await mkdtemp(path.join(tmpdir(), "workflow-batch-agent-")))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await rm(projectRoot, { recursive: true, force: true })
	})

	async function install(name: string, source: string): Promise<string> {
		const file = path.join(workflowsDir(projectRoot), name)
		await writeFile(file, source, "utf8")
		return file
	}

	it("runs a workflow to completion and exits 0, reporting via notify and plain stderr lines", async () => {
		await install("needs-input.workflow.ts", echoInputWorkflowSource())
		const spy = notifySpy()
		const { deps, exits, lines } = batchDeps()

		const code = await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "needs-input",
				inputArg: '{"name": "Ada"}',
				resultOut: undefined,
			},
			deps,
		)

		expect(code).toBe(0)
		expect(exits).toEqual([0])
		const runs = await store.list()
		expect(runs).toHaveLength(1)
		expect(runs[0]?.status).toBe("completed")
		expect(lines.some((line) => line.includes("started"))).toBe(true)
		expect(lines.some((line) => line.includes("completed"))).toBe(true)
		expect(spy.notes.some(([message]) => message.includes("completed"))).toBe(true)
	})

	it("omitted --input means {} for a schema-declaring workflow, rejected by the shared gate as exit 4", async () => {
		await install("needs-input.workflow.ts", echoInputWorkflowSource())
		const spy = notifySpy()
		const { deps, exits } = batchDeps()

		const code = await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "needs-input",
				inputArg: undefined,
				resultOut: undefined,
			},
			deps,
		)

		expect(code).toBe(4)
		expect(exits).toEqual([4])
		expect(spy.notes[0]?.[1]).toBe("error")
		expect(spy.notes[0]?.[0]).toMatch(/input/)
		expect(await store.list()).toHaveLength(0) // no run-id burned on a rejected payload
	})

	it("a bare workflow with no --input completes with exit 0", async () => {
		await install("bare.workflow.ts", bareWorkflowSource())
		const spy = notifySpy()
		const { deps, exits } = batchDeps()

		const code = await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "bare",
				inputArg: undefined,
				resultOut: undefined,
			},
			deps,
		)

		expect(code).toBe(0)
		expect(exits).toEqual([0])
	})

	it("an unknown workflow exits 4 and starts nothing", async () => {
		const spy = notifySpy()
		const { deps, exits } = batchDeps()

		const code = await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "no-such-workflow",
				inputArg: undefined,
				resultOut: undefined,
			},
			deps,
		)

		expect(code).toBe(4)
		expect(exits).toEqual([4])
		expect(spy.notes[0]?.[1]).toBe("error")
		expect(await store.list()).toHaveLength(0)
	})

	it("a blocked run is reported as blocked and exits 2 — no attended questionnaire in the batch host", async () => {
		await install("blocks.workflow.ts", blockingWorkflowSource())
		const spy = notifySpy()
		const { deps, exits, lines } = batchDeps()

		const code = await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "blocks",
				inputArg: undefined,
				resultOut: undefined,
			},
			deps,
		)

		expect(code).toBe(2)
		expect(exits).toEqual([2])
		expect((await store.list())[0]?.status).toBe("blocked")
		expect(lines.some((line) => line.includes("wait"))).toBe(true)
	})

	it("a crashing step exits 4 and the run is recorded crashed", async () => {
		await install("crashes.workflow.ts", crashingWorkflowSource())
		const spy = notifySpy()
		const { deps, exits } = batchDeps()

		const code = await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "crashes",
				inputArg: undefined,
				resultOut: undefined,
			},
			deps,
		)

		expect(code).toBe(4)
		expect(exits).toEqual([4])
		expect((await store.list())[0]?.status).toBe("crashed")
	})

	it("--result-out writes the run's terminal artifact, creating parent directories", async () => {
		await install("needs-input.workflow.ts", echoInputWorkflowSource())
		const spy = notifySpy()
		const { deps, exits } = batchDeps()
		const resultOut = path.join(projectRoot, "out", "nested", "result.json")

		const code = await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "needs-input",
				inputArg: '{"name": "Ada"}',
				resultOut,
			},
			deps,
		)

		expect(code).toBe(0)
		expect(exits).toEqual([0])
		const artifact = JSON.parse(await readFile(resultOut, "utf8"))
		const [run] = await store.list()
		expect(artifact.runId).toBe(run?.runId)
		expect(artifact.workflowName).toBe("needs-input")
		expect(artifact.status).toBe("completed")
		expect(artifact.output).toEqual({ name: "Ada" })
		expect(artifact.steps).toEqual({ echo: { name: "Ada" } })
	})

	it("a --result-out write failure warns on stderr but keeps the semantic exit code", async () => {
		await install("bare.workflow.ts", bareWorkflowSource())
		const blocker = path.join(projectRoot, "blocker")
		await writeFile(blocker, "a regular file", "utf8")
		const spy = notifySpy()
		const { deps, exits, warnings } = batchDeps()

		const code = await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "bare",
				inputArg: undefined,
				resultOut: path.join(blocker, "result.json"),
			},
			deps,
		)

		expect(code).toBe(0)
		expect(exits).toEqual([0])
		expect(warnings.some((line) => line.includes("could not write the result file"))).toBe(true)
	})

	it("a relative --result-out resolves against the invocation cwd", async () => {
		await install("bare.workflow.ts", bareWorkflowSource())
		const spy = notifySpy()
		const { deps } = batchDeps()

		await handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "bare",
				inputArg: undefined,
				resultOut: path.join("rel", "result.json"),
			},
			deps,
		)

		const artifact = JSON.parse(await readFile(path.join(projectRoot, "rel", "result.json"), "utf8"))
		expect(artifact.status).toBe("completed")
	})

	it("SIGINT takes the durable cancel path and exits 3 once the checkpoint has landed", async () => {
		const marker = path.join(projectRoot, "after-ran.txt")
		await install("slow.workflow.ts", slowWorkflowSource(marker))
		const spy = notifySpy()
		const { deps, exits, warnings } = batchDeps()
		const signals = new EventEmitter()

		const pending = handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "slow",
				inputArg: undefined,
				resultOut: undefined,
			},
			{ ...deps, signals },
		)
		// Wait until the run is actually executing (its `run-started` has landed), then interrupt it
		// the way a scheduler would. Signalling EARLIER is the not-yet-started path, exercised below.
		for (let waited = 0; waited < 10_000; waited += 25) {
			if ((await store.list()).length > 0) break
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		signals.emit("SIGINT")
		const code = await pending

		expect(code).toBe(3)
		expect(exits).toEqual([3])
		const [run] = await store.list()
		expect(run?.status).toBe("cancelled")
		const events = await store.loadEvents(run?.runId ?? "")
		expect(events.some((event) => event.type === "run-cancelled")).toBe(true)
		expect(warnings.some((line) => line.includes("SIGINT received; cancelling run"))).toBe(true)
		expect(existsSync(marker)).toBe(false) // the step after the interrupted one never ran
	})

	it("SIGTERM before the run starts exits 3 with nothing recorded", async () => {
		await install("bare.workflow.ts", bareWorkflowSource())
		const spy = notifySpy()
		const { deps, exits, warnings } = batchDeps()
		const signals = new EventEmitter()

		const pending = handleBatchRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			{
				target: "bare",
				inputArg: undefined,
				resultOut: undefined,
			},
			{ ...deps, signals },
		)
		signals.emit("SIGTERM") // resolution is async; nothing can be executing yet
		const code = await pending

		expect(code).toBe(3)
		expect(exits).toEqual([3])
		expect(warnings.some((line) => line.includes("SIGTERM before the run started"))).toBe(true)
		expect(await store.list()).toHaveLength(0)
	})
})

// -- `/workflow run --result-out`: the in-session arm of the same artifact ------------------------------

describe("handleRun with --result-out", () => {
	let projectRoot: string
	let store: RunStore

	beforeEach(async () => {
		projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-run-result-out-"))
		await mkdir(path.join(projectRoot, "sessions", "workflow"), { recursive: true })
		await prepareWorkflowPackageFixture({ directory: workflowsDir(projectRoot) })
		store = createFsStore(path.join(projectRoot, "sessions", "workflow"))
		vi.stubEnv("PI_CODING_AGENT_DIR", await mkdtemp(path.join(tmpdir(), "workflow-run-result-out-agent-")))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await rm(projectRoot, { recursive: true, force: true })
	})

	async function install(name: string, source: string): Promise<string> {
		const file = path.join(workflowsDir(projectRoot), name)
		await writeFile(file, source, "utf8")
		return file
	}

	it("writes the terminal artifact for a settled run, resolved against ctx.cwd", async () => {
		await install("needs-input.workflow.ts", echoInputWorkflowSource())
		const spy = notifySpy()

		await handleRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			"needs-input",
			'{"name": "Ada"}',
			undefined, // no progress surface needed for the artifact path
			path.join("rel", "result.json"),
		)

		const artifact = JSON.parse(await readFile(path.join(projectRoot, "rel", "result.json"), "utf8"))
		const [run] = await store.list()
		expect(run?.status).toBe("completed")
		expect(artifact.runId).toBe(run?.runId)
		expect(artifact.workflowName).toBe("needs-input")
		expect(artifact.status).toBe("completed")
		expect(artifact.output).toEqual({ name: "Ada" })
		expect(artifact.steps).toEqual({ echo: { name: "Ada" } })
	})

	it("an artifact write failure warns but changes nothing about the run's outcome", async () => {
		await install("bare.workflow.ts", bareWorkflowSource())
		const blocker = path.join(projectRoot, "blocker")
		await writeFile(blocker, "a regular file", "utf8")
		const spy = notifySpy()

		await handleRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			"bare",
			undefined,
			undefined,
			path.join(blocker, "result.json"),
		)

		const [run] = await store.list()
		expect(run?.status).toBe("completed")
		expect(
			spy.notes.some(([message, type]) => type === "warning" && message.includes("could not write the result file")),
		).toBe(true)
	})
})
