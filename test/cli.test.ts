import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { main, parseRunArgv, resolveCliStepInvocation } from "../src/host/cli.ts"
import type { StartAgent } from "../src/host/commands/index.ts"
import { createFsStore } from "../src/host/fs-store.ts"
import { runArtifactsDir, workflowsDir } from "../src/host/project-dir.ts"
import { prepareWorkflowPackageFixture } from "./workflow-package-fixture.ts"

/** No agent steps in these workflows: opening a session at all would be the bug. */
const noAgent: StartAgent = () => {
	throw new Error("no agent expected")
}

/** Captured exit codes and stderr lines, handed to the CLI as its process seams. */
function cliDeps(cwd: string) {
	const exits: number[] = []
	const lines: string[] = []
	return {
		exits,
		lines,
		deps: {
			cwd,
			startAgent: noAgent,
			exit: (code: number) => void exits.push(code),
			stderr: (line: string) => void lines.push(line),
			warn: (line: string) => void lines.push(line),
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

// -- parseRunArgv: argv-shaped front door ------------------------------------------------------------

describe("parseRunArgv", () => {
	it("takes a bare target", () => {
		expect(parseRunArgv(["review-loop"])).toEqual({
			target: "review-loop",
			inputArg: undefined,
			resultOut: undefined,
			error: undefined,
		})
	})

	it("keeps a one-token JSON payload's internal spaces verbatim", () => {
		expect(parseRunArgv(["review-loop", "--input", '{"branch": "release notes"}'])).toEqual({
			target: "review-loop",
			inputArg: '{"branch": "release notes"}',
			resultOut: undefined,
			error: undefined,
		})
	})

	it("takes the token after --result-out wherever the flag sits", () => {
		expect(parseRunArgv(["--result-out", "/out/result.json", "review-loop", "--input", "{}", "--unused"])).toEqual({
			target: "review-loop",
			// --input consumes the rest of the vector, exactly like the slash grammar's raw-remainder rule.
			inputArg: "{} --unused",
			resultOut: "/out/result.json",
			error: undefined,
		})
	})

	it("keeps a --result-out path the shell handed over with its spaces intact", () => {
		expect(parseRunArgv(["review-loop", "--result-out", "my dir/result.json"])).toMatchObject({
			target: "review-loop",
			resultOut: "my dir/result.json",
		})
	})

	it("rejects a valueless --result-out and a duplicated one", () => {
		expect(parseRunArgv(["review-loop", "--result-out"])).toMatchObject({
			error: "--result-out requires a value: <path>",
		})
		expect(parseRunArgv(["review-loop", "--result-out", "/a.json", "--result-out", "/b.json"])).toMatchObject({
			error: "duplicate --result-out",
		})
	})

	it("rejects a dangling --input, an unknown option, and a second positional", () => {
		expect(parseRunArgv(["review-loop", "--input"])).toMatchObject({
			error: "--input requires a value: inline JSON, or @<file>",
		})
		expect(parseRunArgv(["review-loop", "--force"])).toMatchObject({ error: 'unknown option "--force"' })
		expect(parseRunArgv(["one", "two"])).toMatchObject({ error: 'unexpected argument "two"' })
	})
})

// -- resolveCliStepInvocation -------------------------------------------------------------------------

describe("resolveCliStepInvocation", () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "workflow-cli-invocation-"))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("never respawns the CLI's own bin — an interpreter-launched CLI falls back to `pi` on PATH", () => {
		const resolved = resolveCliStepInvocation(["--mode", "json", "-p"], {
			argv1: path.join(dir, "node_modules", ".bin", "kimchi-workflows.mjs"),
			binEntry: path.join(dir, "node_modules", ".bin", "kimchi-workflows.mjs"),
			execPath: "/usr/local/bin/node",
		})
		expect(resolved).toEqual({ command: "pi", args: ["--mode", "json", "-p"] })
	})

	it("a compiled harness binary respawns itself even when the CLI bin launched it", () => {
		const binEntry = path.join(dir, "kimchi-workflows.mjs")
		const resolved = resolveCliStepInvocation(["--mode", "json", "-p"], {
			argv1: binEntry,
			binEntry,
			execPath: "/usr/local/bin/kimchi",
		})
		expect(resolved).toEqual({ command: "/usr/local/bin/kimchi", args: ["--mode", "json", "-p"] })
	})

	it("an unrelated existing script (a dev harness entry) is respawned through the interpreter", async () => {
		const script = path.join(dir, "cli.ts")
		await writeFile(script, "// a dev harness entry\n", "utf8")
		const resolved = resolveCliStepInvocation(["--mode", "json", "-p"], {
			argv1: script,
			binEntry: path.join(dir, "kimchi-workflows.mjs"),
			execPath: "/usr/local/bin/node",
		})
		expect(resolved).toEqual({ command: "/usr/local/bin/node", args: [script, "--mode", "json", "-p"] })
	})

	it("a compiled harness binary dispatches (`kimchi workflow run`) respawn itself with the CLI args", async () => {
		const resolved = resolveCliStepInvocation(["--mode", "json", "-p"], {
			argv1: "/$bunfs/root/kimchi",
			binEntry: path.join(dir, "kimchi-workflows.mjs"),
			execPath: "/usr/local/bin/kimchi",
		})
		expect(resolved).toEqual({ command: "/usr/local/bin/kimchi", args: ["--mode", "json", "-p"] })
	})
})

// -- the CLI front door end to end --------------------------------------------------------------------

describe("cli main", () => {
	let projectRoot: string
	let prepared = false

	beforeEach(async () => {
		projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-cli-"))
		prepared = false
		vi.stubEnv("PI_CODING_AGENT_DIR", await mkdtemp(path.join(tmpdir(), "workflow-cli-agent-")))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await rm(projectRoot, { recursive: true, force: true })
	})

	async function install(name: string, source: string): Promise<string> {
		// Prepared lazily: the usage/error-only tests above never need the workflow package, and the
		// prep is one more thing the full suite does not need every one of these tests paying for.
		if (!prepared) {
			await prepareWorkflowPackageFixture({ directory: workflowsDir(projectRoot) })
			prepared = true
		}
		const file = path.join(workflowsDir(projectRoot), name)
		await writeFile(file, source, "utf8")
		return file
	}

	/** The CLI writes its runs to the session-less project placement; read them back through the same derivation. */
	function projectStore() {
		return createFsStore(runArtifactsDir(projectRoot, undefined))
	}

	it("prints usage and exits 0 for --help, carrying nothing to the exit-code contract", async () => {
		const { deps, exits, lines } = cliDeps(projectRoot)
		const code = await main(["--help"], deps)
		expect(code).toBe(0)
		expect(exits).toEqual([0])
		expect(lines.some((line) => line.startsWith("usage: kimchi workflow run"))).toBe(true)
	})

	it("a missing or unknown command exits 4 with usage — never 2, which belongs to blocked runs", async () => {
		for (const args of [[] as string[], ["exec", "review-loop"], ["resumme"]]) {
			const { deps, exits, lines } = cliDeps(projectRoot)
			const code = await main(args, deps)
			expect(code).toBe(4)
			expect(exits).toEqual([4])
			expect(lines.some((line) => line.includes("usage: kimchi workflow run"))).toBe(true)
		}
	})

	it("malformed run arguments exit 4 as a never-started job", async () => {
		const { deps, exits, lines } = cliDeps(projectRoot)
		const code = await main(["run", "review-loop", "--result-out"], deps)
		expect(code).toBe(4)
		expect(exits).toEqual([4])
		expect(lines[0]).toContain("--result-out requires a value")
	})

	it("a run with no target exits 4 with usage", async () => {
		const { deps, exits, lines } = cliDeps(projectRoot)
		const code = await main(["run"], deps)
		expect(code).toBe(4)
		expect(exits).toEqual([4])
		expect(lines.some((line) => line.startsWith("usage:"))).toBe(true)
	})

	it("runs a workflow to completion with exit 0, progress and result report on stderr", {
		timeout: 20_000,
	}, async () => {
		await install("needs-input.workflow.ts", echoInputWorkflowSource())
		const { deps, exits, lines } = cliDeps(projectRoot)

		const code = await main(["run", "needs-input", "--input", '{"name": "Ada"}'], deps)

		expect(code).toBe(0)
		expect(exits).toEqual([0])
		const runs = await projectStore().list()
		expect(runs).toHaveLength(1)
		expect(runs[0]?.status).toBe("completed")
		expect(lines.some((line) => line.includes("started"))).toBe(true)
		expect(lines.some((line) => line.includes("completed"))).toBe(true)
	})

	it("--result-out writes the terminal artifact, relative to the invocation cwd", { timeout: 20_000 }, async () => {
		await install("needs-input.workflow.ts", echoInputWorkflowSource())
		const { deps } = cliDeps(projectRoot)

		const code = await main(
			["run", "needs-input", "--input", '{"name": "Ada"}', "--result-out", "out/nested/result.json"],
			deps,
		)

		expect(code).toBe(0)
		const artifact = JSON.parse(await readFile(path.join(projectRoot, "out", "nested", "result.json"), "utf8"))
		const [run] = await projectStore().list()
		expect(artifact.runId).toBe(run?.runId)
		expect(artifact.workflowName).toBe("needs-input")
		expect(artifact.status).toBe("completed")
		expect(artifact.output).toEqual({ name: "Ada" })
		expect(artifact.steps).toEqual({ echo: { name: "Ada" } })
	})

	it("an unknown workflow exits 4 and starts nothing", { timeout: 20_000 }, async () => {
		const { deps, exits, lines } = cliDeps(projectRoot)
		const code = await main(["run", "no-such-workflow"], deps)
		expect(code).toBe(4)
		expect(exits).toEqual([4])
		expect(lines.some((line) => line.includes("no-such-workflow"))).toBe(true)
		expect(await projectStore().list()).toHaveLength(0)
	})

	it("SIGINT mid-run takes the durable cancel path and exits 3", { timeout: 20_000 }, async () => {
		const marker = path.join(projectRoot, "after-ran.txt")
		await install("slow.workflow.ts", slowWorkflowSource(marker))
		const { deps, exits, lines } = cliDeps(projectRoot)
		const signals = new EventEmitter()

		const pending = main(["run", "slow"], { ...deps, signals })
		// Wait until the run is actually executing (its log exists), then interrupt it the way a
		// scheduler would.
		for (let waited = 0; waited < 10_000; waited += 25) {
			if ((await projectStore().list()).length > 0) break
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		signals.emit("SIGINT")
		const code = await pending

		expect(code).toBe(3)
		expect(exits).toEqual([3])
		const [run] = await projectStore().list()
		expect(run?.status).toBe("cancelled")
		expect(lines.some((line) => line.includes("SIGINT received; cancelling run"))).toBe(true)
		expect(existsSync(marker)).toBe(false) // the step after the interrupted one never ran
	})

	it("a bare workflow completes through the CLI without --input", { timeout: 20_000 }, async () => {
		await install("bare.workflow.ts", bareWorkflowSource())
		const { deps, exits } = cliDeps(projectRoot)
		const code = await main(["run", "bare"], deps)
		expect(code).toBe(0)
		expect(exits).toEqual([0])
	})
})
