import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { workflowsDir } from "../src/host/project-dir.ts"
import { discoverWorkflows, resolveWorkflow } from "../src/host/workflow-catalog.ts"

/**
 * Discovery reads real files through the real loader, so these tests build throwaway projects on
 * disk rather than faking the filesystem.
 */

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts")

/**
 * A minimal, valid workflow module. Imports resolve by absolute path: these files are written into a
 * temp directory with no `node_modules`, so a bare specifier like `typebox` would not resolve there.
 */
function workflowSource(name: string, description?: string): string {
	const options =
		description === undefined ? `{ name: "${name}" }` : `{ name: "${name}", description: "${description}" }`
	return [
		`import { createStep, createWorkflow } from "${flowImport}";`,
		`const step = createStep({ name: "${name}-step", run: () => ({ ok: true }) });`,
		`export default createWorkflow(${options}).then(step).commit();`,
	].join("\n")
}

/** Build a project whose workflows directory (`.<app>/workflows/`) holds the given files. */
async function project(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-"))
	const dir = workflowsDir(root)
	await mkdir(dir, { recursive: true })
	for (const [name, content] of Object.entries(files)) {
		await writeFile(path.join(dir, name), content, "utf8")
	}
	return root
}

describe("discoverWorkflows", () => {
	it("is empty when the project has no workflows directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-empty-"))
		expect(await discoverWorkflows(root)).toEqual({ entries: [], broken: [] })
	})

	it("lists each workflow by declared name and description, sorted by name", async () => {
		const root = await project({
			"zeta.workflow.ts": workflowSource("zeta", "the last one"),
			"alpha.workflow.ts": workflowSource("alpha", "the first one"),
		})

		const { entries, broken } = await discoverWorkflows(root)

		expect(broken).toEqual([])
		expect(entries.map((entry) => entry.name)).toEqual(["alpha", "zeta"]) // by name, not by filename
		expect(entries[0]?.description).toBe("the first one")
		expect(entries[0]?.filePath).toBe(path.join(workflowsDir(root), "alpha.workflow.ts"))
	})

	// The directory is a SOURCE directory now — run logs and step sessions live with the harness's
	// sessions (project-dir.ts) — but discovery still filters, so the lock and an author's own helpers
	// and notes are never imported.
	it("ignores the run lock and anything without the .workflow.ts suffix", async () => {
		const root = await project({
			"real.workflow.ts": workflowSource("real"),
			".run.lock": '{"runId":"workflow-real-1a2b3c4d"}',
			"helper.ts": "export const notAWorkflow = 1;",
			"notes.md": "# scratch",
		})

		const { entries, broken } = await discoverWorkflows(root)

		expect(entries.map((entry) => entry.name)).toEqual(["real"])
		expect(broken).toEqual([])
	})

	it("reports a broken workflow instead of failing the whole catalog", async () => {
		const root = await project({
			"good.workflow.ts": workflowSource("good"),
			"bad.workflow.ts": "export default { not: 'a workflow' };",
		})

		const { entries, broken } = await discoverWorkflows(root)

		expect(entries.map((entry) => entry.name)).toEqual(["good"]) // the good one still lists
		expect(broken).toHaveLength(1)
		expect(broken[0]?.filePath).toContain("bad.workflow.ts")
		expect(broken[0]?.error).toMatch(/does not export a workflow/)
	})
})

describe("resolveWorkflow", () => {
	it("resolves a declared name from the catalog", async () => {
		const root = await project({ "deploy.workflow.ts": workflowSource("deploy") })

		const resolved = await resolveWorkflow(root, "deploy")

		expect(resolved.ok).toBe(true)
		if (resolved.ok) {
			expect(resolved.workflow.name).toBe("deploy")
			expect(resolved.filePath).toContain("deploy.workflow.ts")
		}
	})

	it("retains and returns a validated catalog match without evaluating it a second time", async () => {
		const counter = `__kimchi_catalog_loads_${Date.now()}__`
		const source = [
			`import { createStep, createWorkflow } from "${flowImport}";`,
			`const state = globalThis as unknown as Record<string, number>;`,
			`state[${JSON.stringify(counter)}] = (state[${JSON.stringify(counter)}] ?? 0) + 1;`,
			`if (state[${JSON.stringify(counter)}] > 1) throw new Error("second catalog load failed");`,
			`const step = createStep({ name: "ship", run: () => undefined });`,
			`export default createWorkflow({ name: "release" }).then(step).commit();`,
		].join("\n")
		const root = await project({ "aliased.workflow.ts": source })

		try {
			const resolved = await resolveWorkflow(root, "release")

			expect(resolved.ok).toBe(true)
			if (resolved.ok) expect(resolved.workflow.name).toBe("release")
			expect((globalThis as unknown as Record<string, number>)[counter]).toBe(1)
		} finally {
			delete (globalThis as Record<string, unknown>)[counter]
		}
	})

	it("resolves a path relative to the project root", async () => {
		const root = await project({ "deploy.workflow.ts": workflowSource("deploy") })

		const resolved = await resolveWorkflow(
			root,
			path.relative(root, path.join(workflowsDir(root), "deploy.workflow.ts")),
		)

		expect(resolved.ok).toBe(true)
		if (resolved.ok) expect(resolved.workflow.name).toBe("deploy")
	})

	it("explains an unknown name and lists what is available", async () => {
		const root = await project({ "deploy.workflow.ts": workflowSource("deploy") })

		const resolved = await resolveWorkflow(root, "nope")

		expect(resolved.ok).toBe(false)
		if (!resolved.ok) {
			expect(resolved.error).toMatch(/cannot find "nope"/)
			expect(resolved.error).toMatch(/Known workflows: deploy/)
		}
	})

	it("reports why a named path failed to load", async () => {
		const root = await project({ "bad.workflow.ts": "throw new Error('boom at import');" })

		const resolved = await resolveWorkflow(root, path.relative(root, path.join(workflowsDir(root), "bad.workflow.ts")))

		expect(resolved.ok).toBe(false)
		if (!resolved.ok) expect(resolved.error).toMatch(/could not load/)
	})

	it("reports an existing broken conventional file instead of calling its workflow missing", async () => {
		const root = await project({ "broken.workflow.ts": "export default const nope = ;" })

		const resolved = await resolveWorkflow(root, "broken")

		expect(resolved.ok).toBe(false)
		if (!resolved.ok) {
			expect(resolved.error).toContain('workflow "broken" could not load')
			expect(resolved.error).toContain(path.join(workflowsDir(root), "broken.workflow.ts"))
			expect(resolved.error).toContain("TS1109")
			expect(resolved.error).not.toContain("no workflow named")
		}
	})

	it("distinguishes a missing explicit file from a workflow-name lookup", async () => {
		const root = await project({ "deploy.workflow.ts": workflowSource("deploy") })
		const missing = path.join("custom", "missing.workflow.ts")

		const resolved = await resolveWorkflow(root, missing)

		expect(resolved.ok).toBe(false)
		if (!resolved.ok) {
			expect(resolved.error).toBe(`workflow: file does not exist\n  ${path.resolve(root, missing)}`)
			expect(resolved.error).not.toContain("failed to load")
		}
	})

	it("gives an unknown name its searched path and known workflows", async () => {
		const root = await project({ "deploy.workflow.ts": workflowSource("deploy") })

		const resolved = await resolveWorkflow(root, "deply")

		expect(resolved.ok).toBe(false)
		if (!resolved.ok) {
			expect(resolved.error).toContain('workflow: cannot find "deply"')
			expect(resolved.error).toContain(path.join(workflowsDir(root), "deply.workflow.ts"))
			expect(resolved.error).toContain("Known workflows: deploy")
		}
	})
})

/**
 * Discovery imports project code to read declared names, so resolving one workflow must not execute
 * the others. These files append to a log at import time, making execution observable.
 */
describe("resolveWorkflow does not execute unrelated workflows (adversarial regression)", () => {
	async function projectWithTracing(): Promise<{ root: string; log: string }> {
		const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-trace-"))
		const dir = workflowsDir(root)
		await mkdir(dir, { recursive: true })
		const log = path.join(root, "imports.log")
		for (const name of ["alpha", "beta"]) {
			const source = [
				`import { appendFileSync } from "node:fs";`,
				`appendFileSync(${JSON.stringify(log)}, "${name}\\n");`,
				workflowSource(name),
			].join("\n")
			await writeFile(path.join(dir, `${name}.workflow.ts`), source, "utf8")
		}
		return { root, log }
	}

	const imported = async (log: string): Promise<string[]> =>
		(await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0)

	it("imports only the requested workflow when it follows the <name>.workflow.ts convention", async () => {
		const { root, log } = await projectWithTracing()

		const resolved = await resolveWorkflow(root, "alpha")

		expect(resolved.ok).toBe(true)
		expect(await imported(log)).toEqual(["alpha"]) // beta and gamma never ran
	})

	it("falls back to a full scan only when the convention does not hold", async () => {
		const { root, log } = await projectWithTracing()
		// A workflow whose declared name does not match its filename can only be found by scanning. Reuse
		// beta rather than adding more candidates: two modules are the minimum needed to prove the scan
		// evaluates an unrelated workflow, and each candidate intentionally runs a real TypeScript preflight.
		const misnamed = [
			`import { appendFileSync } from "node:fs";`,
			`appendFileSync(${JSON.stringify(log)}, "beta\\n");`,
			workflowSource("delta"),
		].join("\n")
		await writeFile(path.join(workflowsDir(root), "beta.workflow.ts"), misnamed, "utf8")

		const resolved = await resolveWorkflow(root, "delta")

		expect(resolved.ok).toBe(true)
		expect(await imported(log)).toEqual(["alpha", "beta"])
	})
})
