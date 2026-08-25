import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CommandCtx, StartAgent } from "../src/host/commands/index.ts"
import { handleRun, parseRunArgs } from "../src/host/commands/index.ts"
import { createFsStore } from "../src/host/fs-store.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import type { RunStore } from "../src/host/types.ts"
import { createFakeActiveRuns } from "./helpers.ts"

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

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")

/**
 * A workflow that declares a top-level input schema and hands it straight back out via
 * `ctx.getInitData()`. Reading the RECORDED `run-started` event proves what actually reached the
 * engine — the point of these tests, rather than merely that `handleRun` didn't throw.
 */
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

/** A workflow with no declared input schema, for the "no `--input` at all" case. */
function bareWorkflowSource(): string {
	return [
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`const echo = createStep({ name: "echo", run: ({ ctx }) => ctx.getInitData() ?? null });`,
		`export default createWorkflow({ name: "bare" }).then(echo).commit();`,
	].join("\n")
}

function semanticErrorWorkflowSource(name: string, evaluated: string): string {
	return [
		`import { writeFileSync } from "node:fs";`,
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`writeFileSync(${JSON.stringify(evaluated)}, "evaluated");`,
		`const invalid: number = "not a number";`,
		`const step = createStep({ name: "noop", run: () => invalid });`,
		`export default createWorkflow({ name: ${JSON.stringify(name)} }).then(step).commit();`,
	].join("\n")
}

/**
 * `/workflow run --input` end to end (spec §6.1): a workflow whose first step needs input can now
 * actually be started from the command surface, and a malformed payload is rejected before anything
 * is recorded — no run-id minted, nothing appended to the store.
 */
describe("/workflow run --input", () => {
	let projectRoot: string
	let store: RunStore
	let file: string

	beforeEach(async () => {
		projectRoot = await mkdtemp(path.join(tmpdir(), "pi-workflows-input-"))
		const runDir = path.join(projectRoot, "sessions", "workflow")
		await mkdir(runDir, { recursive: true })
		store = createFsStore(runDir)
		file = path.join(projectRoot, "needs-input.workflow.ts")
		await writeFile(file, echoInputWorkflowSource(), "utf8")
	})

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true })
	})

	it("parses inline JSON and feeds it to the run as initial input", async () => {
		const spy = notifySpy()
		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeActiveRuns(), noAgent, file, '{"name": "Ada"}')

		const runs = await store.list()
		expect(runs).toHaveLength(1)
		expect(runs[0]?.status).toBe("completed")
		const events = await store.loadEvents(runs[0]?.runId ?? "")
		expect(events.find((e) => e.type === "run-started")).toMatchObject({ input: { name: "Ada" } })
		expect(spy.notes.some(([, type]) => type === "error")).toBe(false)
	})

	it("reads @file, resolving a relative path against ctx.cwd, and feeds its contents to the run", async () => {
		await writeFile(path.join(projectRoot, "payload.json"), JSON.stringify({ name: "Grace" }), "utf8")
		const spy = notifySpy()
		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeActiveRuns(), noAgent, file, "@payload.json")

		const runs = await store.list()
		expect(runs).toHaveLength(1)
		expect(runs[0]?.status).toBe("completed")
		const events = await store.loadEvents(runs[0]?.runId ?? "")
		expect(events.find((e) => e.type === "run-started")).toMatchObject({ input: { name: "Grace" } })
	})

	it("rejects bad inline JSON through ctx.ui.notify and starts no run", async () => {
		const spy = notifySpy()
		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeActiveRuns(), noAgent, file, "{not valid json")

		expect(await store.list()).toHaveLength(0)
		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[1]).toBe("error")
		expect(spy.notes[0]?.[0]).toMatch(/not valid JSON/)
	})

	it("rejects a --input file that does not exist and starts no run", async () => {
		const spy = notifySpy()
		await handleRun(
			fakeCtx(projectRoot, spy.notify),
			store,
			createFakeActiveRuns(),
			noAgent,
			file,
			"@does-not-exist.json",
		)

		expect(await store.list()).toHaveLength(0)
		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[1]).toBe("error")
		expect(spy.notes[0]?.[0]).toMatch(/could not read --input file "does-not-exist\.json"/)
	})

	it("rejects a payload that fails the workflow's declared input schema, before the run starts", async () => {
		const spy = notifySpy()
		// `name` must be a string; this satisfies the JSON parser but not the schema.
		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeActiveRuns(), noAgent, file, '{"name": 42}')

		expect(await store.list()).toHaveLength(0)
		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[1]).toBe("error")
		expect(spy.notes[0]?.[0]).toMatch(/workflow "needs-input" input:/)
	})

	it("starts with undefined initial input when --input is omitted — unchanged from before the flag existed", async () => {
		const bareFile = path.join(projectRoot, "bare.workflow.ts")
		await writeFile(bareFile, bareWorkflowSource(), "utf8")

		const spy = notifySpy()
		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeActiveRuns(), noAgent, bareFile)

		const runs = await store.list()
		expect(runs).toHaveLength(1)
		expect(runs[0]?.status).toBe("completed")
		const events = await store.loadEvents(runs[0]?.runId ?? "")
		const started = events.find((e) => e.type === "run-started")
		// A round trip through the JSON-lines store drops an `undefined`-valued key entirely rather than
		// keeping it null, so absence — not a `toMatchObject` on the key — is the honest assertion here.
		expect(started && "input" in started ? (started as { input: unknown }).input : undefined).toBeUndefined()
	})

	it("rejects a semantic TypeScript error before creating a run", async () => {
		const invalidFile = path.join(projectRoot, "semantic-error.workflow.ts")
		const evaluated = path.join(projectRoot, "explicit-semantic-workflow-evaluated.txt")
		await writeFile(invalidFile, semanticErrorWorkflowSource("semantic-error", evaluated), "utf8")
		const spy = notifySpy()

		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeActiveRuns(), noAgent, invalidFile)

		expect(await store.list()).toHaveLength(0)
		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[1]).toBe("error")
		expect(spy.notes[0]?.[0]).toContain(`workflow "${invalidFile}" could not load`)
		expect(spy.notes[0]?.[0]).toContain(`File: ${invalidFile}`)
		expect(spy.notes[0]?.[0]).toContain("TS2322")
		expect(existsSync(evaluated)).toBe(false)
		expect((await readdir(path.dirname(invalidFile))).filter((name) => name.startsWith(".pi-run-typecheck-"))).toEqual(
			[],
		)
	})

	it("does not evaluate a semantically invalid conventional-name workflow", async () => {
		const invalidFile = path.join(workflowsDir(projectRoot), "semantic-error.workflow.ts")
		const evaluated = path.join(projectRoot, "conventional-semantic-workflow-evaluated.txt")
		await mkdir(path.dirname(invalidFile), { recursive: true })
		await writeFile(invalidFile, semanticErrorWorkflowSource("semantic-error", evaluated), "utf8")
		const spy = notifySpy()

		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeActiveRuns(), noAgent, "semantic-error")

		expect(await store.list()).toHaveLength(0)
		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[0]).toContain(`File: ${invalidFile}`)
		expect(spy.notes[0]?.[0]).toContain("TS2322")
		expect(existsSync(evaluated)).toBe(false)
	})

	it("does not evaluate modules while looking up a declared-name alias", async () => {
		const invalidFile = path.join(workflowsDir(projectRoot), "aliased.workflow.ts")
		const evaluated = path.join(projectRoot, "catalog-semantic-workflow-evaluated.txt")
		await mkdir(path.dirname(invalidFile), { recursive: true })
		await writeFile(invalidFile, semanticErrorWorkflowSource("release", evaluated), "utf8")
		const spy = notifySpy()

		await handleRun(fakeCtx(projectRoot, spy.notify), store, createFakeActiveRuns(), noAgent, "release")

		expect(await store.list()).toHaveLength(0)
		expect(spy.notes).toHaveLength(1)
		expect(spy.notes[0]?.[0]).toContain('cannot find "release"')
		expect(spy.notes[0]?.[0]).toContain("Known workflows: aliased")
		expect(spy.notes[0]?.[0]).not.toContain("TS2322")
		expect(existsSync(evaluated)).toBe(false)
	})
})

/**
 * `parseRunArgs` in isolation (spec §6.1): the grammar `/workflow run` dispatches on, pure and
 * independent of any store or filesystem — the SAME split `extension.ts` and `handleRun` both build on.
 */
describe("parseRunArgs", () => {
	it("reads a bare target with no --input", () => {
		expect(parseRunArgs("my-workflow")).toEqual({ target: "my-workflow", inputArg: undefined, error: undefined })
	})

	it("keeps a JSON object's internal spaces intact rather than collapsing them", () => {
		expect(parseRunArgs('my-workflow --input {"a": 1, "b": 2}')).toEqual({
			target: "my-workflow",
			inputArg: '{"a": 1, "b": 2}',
			error: undefined,
		})
	})

	it("recognizes an @file payload", () => {
		expect(parseRunArgs("my-workflow --input @payload.json")).toEqual({
			target: "my-workflow",
			inputArg: "@payload.json",
			error: undefined,
		})
	})

	it("reports a dangling --input with nothing after it, without losing the target", () => {
		const parsed = parseRunArgs("my-workflow --input")
		expect(parsed.target).toBe("my-workflow")
		expect(parsed.inputArg).toBeUndefined()
		expect(parsed.error).toMatch(/--input requires a value/)
	})

	it("does not mistake a workflow name merely containing the flag text for the flag itself", () => {
		expect(parseRunArgs("my--input-migrator.workflow.ts")).toEqual({
			target: "my--input-migrator.workflow.ts",
			inputArg: undefined,
			error: undefined,
		})
	})

	it("treats a bare --input (no target before it) as a usage error the caller must catch", () => {
		expect(parseRunArgs("--input {}")).toEqual({ target: undefined, inputArg: "{}", error: undefined })
	})
})
