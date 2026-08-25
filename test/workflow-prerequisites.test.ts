import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	checkWorkflowPrerequisites,
	type WorkflowPrerequisiteCommandRunner,
	type WorkflowPrerequisiteError,
} from "../src/host/workflow-prerequisites.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function runnerFor(nodeVersion: string): WorkflowPrerequisiteCommandRunner {
	return vi.fn(async ({ command }) => ({
		code: 0,
		stdout: command === "node" ? `${nodeVersion}\n` : "10.33.0\n",
		stderr: "",
	}))
}

describe("external workflow prerequisites", () => {
	it.each(["v22.19.0", "v22.20.1", "v24.0.0", "v26.3.0"])("accepts external Node %s", async (version) => {
		const runCommand = runnerFor(version)

		await expect(checkWorkflowPrerequisites(undefined, runCommand)).resolves.toBeUndefined()
		expect(runCommand).toHaveBeenNthCalledWith(1, {
			command: "node",
			args: ["--version"],
			signal: undefined,
		})
		expect(runCommand).toHaveBeenNthCalledWith(2, {
			command: "pnpm",
			args: ["--version"],
			signal: undefined,
		})
	})

	it.each(["v20.10.0", "v22.18.9"])("rejects unsupported external Node %s before probing pnpm", async (version) => {
		const runCommand = runnerFor(version)

		await expect(checkWorkflowPrerequisites(undefined, runCommand)).rejects.toEqual(
			expect.objectContaining<Partial<WorkflowPrerequisiteError>>({
				name: "WorkflowPrerequisiteError",
				message: expect.stringContaining("external Node.js 22.19+"),
			}),
		)
		expect(runCommand).toHaveBeenCalledTimes(1)
	})

	it("detects a missing external Node even though the running Bun or Node process exposes a compatibility version", async () => {
		const emptyPath = await mkdtemp(path.join(tmpdir(), "kimchi-empty-path-"))
		temporaryDirectories.push(emptyPath)
		vi.stubEnv("PATH", emptyPath)

		await expect(checkWorkflowPrerequisites()).rejects.toThrow(/Node\.js is required.*node --version/)
	})

	it("reports the pinned pnpm installation command when pnpm is missing", async () => {
		const runCommand: WorkflowPrerequisiteCommandRunner = vi.fn(async ({ command }) => {
			if (command === "node") return { code: 0, stdout: "v22.19.0\n", stderr: "" }
			const error = new Error("spawn pnpm ENOENT") as NodeJS.ErrnoException
			error.code = "ENOENT"
			throw error
		})

		await expect(checkWorkflowPrerequisites(undefined, runCommand)).rejects.toThrow("npm install --global pnpm@10.33.0")
	})
})
