import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	createKimchiE2eFixture,
	type KimchiE2eFixture,
	readRunEvents,
	runIdFromFile,
	snapshotRuns,
	waitFor,
	waitForNewRun,
	waitForRunEvent,
} from "./support/kimchi-fixture.ts"
import type { ExtensionUiRequest, KimchiRpcClient } from "./support/rpc-client.ts"

interface CompletedRun {
	readonly file: string
	readonly event: Awaited<ReturnType<typeof waitForRunEvent>>
}

interface WorkflowPackageManifest {
	readonly devDependencies?: Record<string, string>
}

let fixture: KimchiE2eFixture
let greetRun: CompletedRun

describe("kimchi-workflows in the compiled Kimchi Bun harness", () => {
	beforeAll(async () => {
		fixture = await createKimchiE2eFixture()
		fixture.addWorkflow("greet.workflow.ts")
		greetRun = await runWorkflow("greet", "greet")
	})

	afterAll(async () => {
		if (!fixture) return
		const modelCalls = fixture.modelRequests.filter((request) => request.includes("/chat/completions"))
		try {
			if (modelCalls.length > 0) throw new Error(`scripted workflow E2E made model calls: ${modelCalls.join(", ")}`)
		} finally {
			await fixture.stop()
		}
	})

	it("1. authors, validates, prepares, and runs a simple workflow", () => {
		expect(greetRun.event.output).toEqual({ message: "hello" })
		expect(readRunEvents(greetRun.file).map((event) => event.type)).toContain("step-completed")

		const manifestPath = path.join(fixture.workflowPackageDir, "package.json")
		const lockfilePath = path.join(fixture.workflowPackageDir, "pnpm-lock.yaml")
		const verifierPath = path.join(
			fixture.workflowPackageDir,
			"node_modules",
			".bin",
			process.platform === "win32" ? "kimchi-workflows.cmd" : "kimchi-workflows",
		)
		expect(existsSync(manifestPath)).toBe(true)
		expect(existsSync(lockfilePath)).toBe(true)
		expect(existsSync(verifierPath)).toBe(true)
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkflowPackageManifest
		expect(manifest.devDependencies?.["@kimchi-dev/kimchi-workflows"]).toMatch(/^file:/)
	})

	it("2. restores a blocked questionnaire after the harness process is rebuilt", async () => {
		fixture.addWorkflow("ask.workflow.ts")
		const before = snapshotRuns(fixture.runDir, "ask")
		const first = await fixture.startRpc()
		let firstDialog: ExtensionUiRequest | undefined
		try {
			first.dialogResponder = (request) => {
				firstDialog = request
				return { cancelled: true }
			}
			await first.prompt("/workflow run ask")
			await waitFor(() => firstDialog, "the initial questionnaire dialog")
			await waitFor(
				() => first.notificationsSince(0).some((request) => request.message?.includes("is still blocked")),
				"the blocked-run dismissal notification",
			)
		} finally {
			await first.stop()
		}

		const file = await waitForNewRun(fixture.runDir, "ask", before)
		const blockedEvents = readRunEvents(file)
		expect(blockedEvents.some((event) => event.type === "questionnaire-asked")).toBe(true)
		expect(blockedEvents.some((event) => event.type === "run-completed")).toBe(false)

		const second = await fixture.startRpc()
		let restoredDialog: ExtensionUiRequest | undefined
		try {
			second.dialogResponder = (request) => {
				restoredDialog = request
				return request.method === "select" ? { value: "yes" } : { cancelled: true }
			}
			await second.prompt(`/workflow resume ${runIdFromFile(file)}`)
		} finally {
			await second.stop()
		}

		const completed = await waitForRunEvent(file, "run-completed")
		expect(completed.output).toEqual({ decision: "yes" })
		expect(firstDialog).toMatchObject({ method: "select", options: ["yes", "no"] })
		expect(restoredDialog).toMatchObject({ method: "select", options: ["yes", "no"] })
		expect(restoredDialog?.title).toBe(firstDialog?.title)
		expect(readRunEvents(file).filter((event) => event.type === "run-execution-started")).toHaveLength(2)
	})

	it("3. validates and runs a workflow from an external file path", async () => {
		fixture.addProjectFixture("external/external.workflow.ts", "scripts/external.workflow.ts")
		const run = await runWorkflow("scripts/external.workflow.ts", "external")
		expect(run.event.output).toEqual({ source: "external" })
		const meta = readRunEvents(run.file).find((event) => event.type === "run-meta")
		expect(meta?.workflowSource).toMatchObject({
			kind: "file",
			path: expect.stringContaining("scripts/external.workflow.ts"),
		})
	})

	it("4. cancels an in-flight workflow, releases its lease, and resumes it", async () => {
		fixture.addWorkflow("slow.workflow.ts")
		const marker = path.join(fixture.workDir, ".slow-first-attempt")
		rmSync(marker, { force: true })
		const before = snapshotRuns(fixture.runDir, "slow")
		const rpc = await fixture.startRpc()
		try {
			const runningPrompt = rpc.beginPrompt("/workflow run slow")
			await waitFor(() => existsSync(marker), "the slow workflow to enter its in-flight step")
			const file = await waitForNewRun(fixture.runDir, "slow", before)
			await waitForRunEvent(file, "step-started")
			const runId = runIdFromFile(file)

			await rpc.prompt(`/workflow cancel ${runId}`)
			expect((await runningPrompt).success).toBe(true)
			await waitForRunEvent(file, "run-cancelled")
			const leasePath = path.join(fixture.runDir, `${runId}.execution.json`)
			await waitFor(() => !existsSync(leasePath), "the cancelled run execution lease to be released")
			expect(readRunEvents(file).some((event) => event.type === "run-completed")).toBe(false)

			await rpc.prompt(`/workflow resume ${runId}`)
			const completed = await waitForRunEvent(file, "run-completed")
			expect(completed.output).toEqual({ resumed: true })
			expect(readRunEvents(file).filter((event) => event.type === "run-execution-started")).toHaveLength(2)
		} finally {
			await rpc.stop()
		}
	})

	it("5. resolves an external workflow's relative helper import from its authored directory", async () => {
		fixture.addProjectFixture("external/helper.ts", "scripts/helper.ts")
		fixture.addProjectFixture("external/with-helper.workflow.ts", "scripts/with-helper.workflow.ts")
		const run = await runWorkflow("scripts/with-helper.workflow.ts", "with-helper")
		expect(run.event.output).toEqual({ helper: "relative-ok" })
	})

	it("6. carries foreach and map data into a downstream summary", async () => {
		fixture.addWorkflow("pipeline.workflow.ts")
		const run = await runWorkflow("pipeline", "pipeline")
		expect(run.event.output).toEqual({ summary: "A,B,C|3" })
		const events = readRunEvents(run.file)
		expect(events.filter((event) => event.type === "foreach-item-completed")).toHaveLength(3)
		expect(events.find((event) => event.type === "step-completed" && event.path === "summarize")?.output).toEqual({
			summary: "A,B,C|3",
		})
	})

	it("7. reports a broken workflow without hiding or breaking a valid neighbor", async () => {
		fixture.addWorkflow("good.workflow.ts")
		fixture.addWorkflow("bad.workflow.ts")
		const before = snapshotRuns(fixture.runDir, "good")
		const rpc = await fixture.startRpc()
		try {
			const startIndex = rpc.messageCount
			await rpc.prompt("/workflow list")
			const notifications = rpc.notificationsSince(startIndex)
			const listing = notifications.find(
				(request) => request.message?.includes("good") && request.message.includes("good.workflow.ts"),
			)
			const broken = notifications.find(
				(request) => request.message?.includes("failed to load") && request.message.includes("bad.workflow.ts"),
			)
			expect(listing?.message).toContain("Still runnable beside a broken file")
			expect(broken).toMatchObject({ notifyType: "warning" })
			expect(broken?.message).toContain("intentional broken workflow fixture")

			await rpc.prompt("/workflow run good")
		} finally {
			await rpc.stop()
		}
		const file = await waitForNewRun(fixture.runDir, "good", before)
		expect((await waitForRunEvent(file, "run-completed")).output).toEqual({ good: true })
	})
})

async function runWorkflow(target: string, workflowName: string): Promise<CompletedRun> {
	const before = snapshotRuns(fixture.runDir, workflowName)
	await withRpc((rpc) => rpc.prompt(`/workflow run ${target}`))
	const file = await waitForNewRun(fixture.runDir, workflowName, before)
	return { file, event: await waitForRunEvent(file, "run-completed") }
}

async function withRpc<T>(run: (rpc: KimchiRpcClient) => Promise<T>): Promise<T> {
	const rpc = await fixture.startRpc()
	try {
		return await run(rpc)
	} finally {
		await rpc.stop()
	}
}
