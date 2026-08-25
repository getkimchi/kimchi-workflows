import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createActiveRuns } from "../src/host/active-runs.ts"
import type { CommandCtx, StartAgent } from "../src/host/commands/index.ts"
import { handleRun } from "../src/host/commands/index.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import { prepareWorkflowPackageFixture } from "./workflow-package-fixture.ts"

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const noAgent: StartAgent = () => {
	throw new Error("no agent expected")
}

function concurrentWorkflowSource(marker: string): string {
	return [
		'import { appendFile, readFile } from "node:fs/promises";',
		`import { createStep, createWorkflow } from ${JSON.stringify(flowImport)};`,
		`const marker = ${JSON.stringify(marker)};`,
		"const pause = () => new Promise((resolve) => setTimeout(resolve, 5));",
		"const overlap = createStep({",
		'  name: "overlap",',
		"  run: async () => {",
		'    await appendFile(marker, "started\\n");',
		"    for (let attempt = 0; attempt < 200; attempt++) {",
		'      const started = (await readFile(marker, "utf8")).trim().split("\\n").filter(Boolean).length;',
		"      if (started >= 2) return { started };",
		"      await pause();",
		"    }",
		'    throw new Error("a second run never overlapped");',
		"  },",
		"});",
		'export default createWorkflow({ name: "same-workflow" }).then(overlap).commit();',
	].join("\n")
}

describe("host-level run concurrency", () => {
	it("executes two instances of the same workflow concurrently without creating a lock file", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "workflow-unlocked-"))
		roots.push(root)
		await prepareWorkflowPackageFixture({ directory: workflowsDir(root) })
		const marker = path.join(root, "started.txt")
		const workflowFile = path.join(root, "same.workflow.ts")
		await writeFile(workflowFile, concurrentWorkflowSource(marker), "utf8")

		const notify = vi.fn()
		const ctx = {
			cwd: root,
			mode: "tui",
			hasUI: true,
			modelRegistry: {},
			ui: { notify },
		} as unknown as CommandCtx
		const store = createMemoryStore()
		const activeRuns = createActiveRuns()

		await Promise.all([
			handleRun(ctx, store, activeRuns, noAgent, workflowFile),
			handleRun(ctx, store, activeRuns, noAgent, workflowFile),
		])

		const runs = await store.list()
		expect(runs).toHaveLength(2)
		expect(runs.map((run) => run.status)).toEqual(["completed", "completed"])
		expect(new Set(runs.map((run) => run.runId)).size).toBe(2)
		expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(2)
		expect(activeRuns.active).toEqual([])
		expect(existsSync(path.join(workflowsDir(root), ".run.lock"))).toBe(false)
		expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/already (active|executing)/), "warning")
	})
})
