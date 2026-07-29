import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { CommandCtx } from "../src/host/commands/context.ts"
import { handleStatus } from "../src/host/commands/status.ts"
import { createHostPort } from "../src/host/host-port.ts"
import { loadWorkflowFile } from "../src/host/load-workflow.ts"
import { createMemoryStore } from "../src/host/memory-store.ts"
import type { ProgressCtx, ProgressMode } from "../src/host/progress-sink.ts"

/**
 * `/workflow status [run-id]` (progress §11.4) — rebuilt from the log, through the same projection the
 * live panel used.
 *
 * The run under test is driven by the REAL engine and reloaded from a REAL file, because the whole
 * point of this command is that a run recorded a week ago renders identically to the one that was on
 * screen at the time. A fixture log plus an in-memory definition would prove only that the projection
 * runs twice, not that the two halves it joins — a log on disk and a workflow file on disk — still
 * agree once neither is in front of the person who wrote them.
 */

const WORKFLOW_SOURCE = `
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows";

export default createWorkflow({ name: "audit" })
  .then(createStep({ name: "collect", run: () => ({ ok: true }) }))
  .branch([
    [() => true, createWorkflow({ name: "review" }).then(createStep({ name: "check", run: () => ({ ok: true }) })).commit()],
    [() => false, createWorkflow({ name: "migrate" }).then(createStep({ name: "apply", run: () => ({ ok: true }) })).commit()],
  ], { name: "gate" })
  .commit();
`

function fakeCtx(mode: ProgressMode, sessionDir = "/tmp/session") {
	const notes: [string, string | undefined][] = []
	const ctx = {
		mode,
		cwd: "/tmp",
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => void notes.push([message, type]),
			setWidget: () => {},
			setWorkingMessage: () => {},
		},
		sessionManager: { getSessionDir: () => sessionDir },
	} as unknown as CommandCtx & ProgressCtx
	return { ctx, notes, deps: { activeRunId: () => undefined, width: 76 } }
}

/** Run the real workflow off a real file, and return the store its log landed in. */
async function recordedRun() {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-workflows-status-"))
	const file = path.join(dir, "audit.workflow.ts")
	await writeFile(file, WORKFLOW_SOURCE, "utf8")

	// Through `loadWorkflowFile`, exactly as the command does: a workflow file in a project that has
	// installed nothing resolves its bare imports only through the loader's virtual-module map.
	const workflow = await loadWorkflowFile(file)
	const store = createMemoryStore()
	const host = createHostPort(store, { generateRunId: () => "workflow-audit-1a2b3c4d" })
	await store.appendEvent({
		type: "run-meta",
		runId: "workflow-audit-1a2b3c4d",
		workflowFilePath: file,
		at: new Date().toISOString(),
	})
	const result = await runWorkflow(workflow, undefined, host)
	return { store, result, file }
}

describe("handleStatus (progress §11.4)", () => {
	it("notifies the fully expanded tree of a recorded run", async () => {
		const { store, result, file } = await recordedRun()
		expect(result.status).toBe("completed")

		const h = fakeCtx("tui")
		await handleStatus(h.ctx, store, h.deps, "1a2b3c4d") // the 8-hex tail, resolved by the shared resolveRunRef

		expect(h.notes).toHaveLength(1)
		const message = h.notes[0]?.[0] ?? ""
		expect(message).toContain(file) // provenance, from `run-meta` (spec §8.9)
		expect(message).toContain("1a2b3c4d")
		expect(message).toContain("✓ collect")
		expect(message).toContain("1 of 2 arms")
		// collect + review/check + the SKIPPED migrate/apply: a completed run reaches a full bar even though
		// an arm never ran (the defect a live run found).
		expect(message).toContain("3 of 3")
	})

	/**
	 * Every mode, one behaviour. This used to be a card in `tui` and a one-line fallback everywhere else;
	 * the card needed `registerEntryRenderer`, which pi 0.80.2 does not have, and calling it took the
	 * whole extension down at load. Plain text answers the question on every harness (progress-card.ts).
	 */
	it("answers identically in every mode, with or without a session", async () => {
		const { store } = await recordedRun()
		for (const [mode, sessionDir] of [
			["tui", ""], // `--no-session`
			["rpc", "/tmp/session"],
			["json", "/tmp/session"],
		] as const) {
			const h = fakeCtx(mode, sessionDir)
			await handleStatus(h.ctx, store, h.deps, "1a2b3c4d")
			expect(h.notes).toHaveLength(1)
			expect(h.notes[0]?.[0]).toContain("✓ collect")
			expect(h.notes[0]?.[0]).toContain("3 of 3")
		}
	})

	it("reports an unknown run rather than showing an empty tree", async () => {
		const { store } = await recordedRun()
		const h = fakeCtx("tui")
		await handleStatus(h.ctx, store, h.deps, "nosuchrun")
		expect(h.notes[0]?.[0]).toContain('no run "nosuchrun" to show')
	})

	it("with no argument and nothing executing, says so instead of guessing at a run", async () => {
		const { store } = await recordedRun()
		const h = fakeCtx("tui")
		await handleStatus(h.ctx, store, h.deps, undefined)
		expect(h.notes[0]?.[0]).toContain("no run is executing")
	})

	it("with no argument, shows whatever the project lock says is executing (spec §7)", async () => {
		const { store } = await recordedRun()
		const h = fakeCtx("tui")
		await handleStatus(h.ctx, store, { ...h.deps, activeRunId: () => "workflow-audit-1a2b3c4d" }, undefined)
		expect(h.notes).toHaveLength(1)
		expect(h.notes[0]?.[0]).toContain("✓ collect")
	})

	it("refuses a log with no run-meta rather than rendering a tree it cannot verify", async () => {
		const store = createMemoryStore()
		await store.appendEvent({
			type: "run-started",
			runId: "workflow-orphan-9f9f9f9f",
			workflowName: "orphan",
			input: undefined,
			at: new Date().toISOString(),
		})
		const h = fakeCtx("tui")
		await handleStatus(h.ctx, store, h.deps, "9f9f9f9f")
		expect(h.notes[0]?.[0]).toContain("does not record which workflow file")
	})
})
