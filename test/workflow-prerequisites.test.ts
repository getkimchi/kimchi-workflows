import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	formatWorkflowPackageManagerCommand,
	resolveWorkflowPackageManager,
	type WorkflowPackageManagerError,
	type WorkflowPackageManagerProbeRunner,
	workflowPackageManagerInvocation,
} from "../src/host/workflow-package-manager.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function runnerFor(nodeVersion: string): WorkflowPackageManagerProbeRunner {
	return vi.fn(async ({ command }) => ({
		code: 0,
		stdout: command === "node" ? `${nodeVersion}\n` : "10.33.0\n",
		stderr: "",
	}))
}

describe("external workflow package manager", () => {
	it.each(["v22.19.0", "v22.20.1", "v24.0.0", "v26.3.0"])("accepts external Node %s", async (version) => {
		const runProbe = runnerFor(version)

		await expect(resolveWorkflowPackageManager(undefined, runProbe)).resolves.toBeDefined()
		expect(runProbe).toHaveBeenNthCalledWith(1, {
			command: "node",
			args: ["--version"],
			timeoutMs: 10_000,
			signal: undefined,
		})
		expect(runProbe).toHaveBeenNthCalledWith(2, {
			command: "corepack",
			args: ["pnpm@10.33.0", "--version"],
			timeoutMs: 60_000,
			signal: undefined,
		})
	})

	it("resolves and formats the pinned Corepack launcher", async () => {
		const packageManager = await resolveWorkflowPackageManager(undefined, runnerFor("v22.19.0"))

		expect(packageManager).toEqual({ command: "corepack", args: ["pnpm@10.33.0"] })
		expect(workflowPackageManagerInvocation(packageManager, ["install"])).toEqual({
			command: "corepack",
			args: ["pnpm@10.33.0", "install"],
		})
		expect(formatWorkflowPackageManagerCommand(packageManager, ["install"])).toBe("corepack pnpm@10.33.0 install")
	})

	it("falls back to an exact-version pnpm executable when Corepack is unavailable", async () => {
		const runProbe: WorkflowPackageManagerProbeRunner = vi.fn(async ({ command }) => {
			if (command === "node") return { code: 0, stdout: "v22.19.0\n", stderr: "" }
			if (command === "corepack") throw missingCommand("corepack")
			return { code: 0, stdout: "10.33.0\n", stderr: "" }
		})

		await expect(resolveWorkflowPackageManager(undefined, runProbe)).resolves.toEqual({ command: "pnpm", args: [] })
	})

	it("uses npm exec with the pin when Corepack is absent and system pnpm differs", async () => {
		const runProbe: WorkflowPackageManagerProbeRunner = vi.fn(async ({ command }) => {
			if (command === "node") return { code: 0, stdout: "v22.19.0\n", stderr: "" }
			if (command === "corepack") throw missingCommand("corepack")
			if (command === "pnpm") return { code: 0, stdout: "9.15.0\n", stderr: "" }
			return { code: 0, stdout: "10.33.0\n", stderr: "" }
		})

		await expect(resolveWorkflowPackageManager(undefined, runProbe)).resolves.toEqual({
			command: "npm",
			args: ["exec", "--yes", "--package=pnpm@10.33.0", "--", "pnpm"],
		})
	})

	it("preserves every launcher failure in the actionable error", async () => {
		const runProbe: WorkflowPackageManagerProbeRunner = vi.fn(async ({ command }) => {
			if (command === "node") return { code: 0, stdout: "v22.19.0\n", stderr: "" }
			if (command === "corepack") throw new Error("download timed out")
			if (command === "pnpm") return { code: 0, stdout: "9.15.0\n", stderr: "" }
			return { code: 1, stdout: "", stderr: "registry unavailable" }
		})

		const resolution = resolveWorkflowPackageManager(undefined, runProbe)
		await expect(resolution).rejects.toThrow("corepack pnpm@10.33.0: download timed out")
		await expect(resolution).rejects.toThrow("pnpm: reported 9.15.0")
		await expect(resolution).rejects.toThrow(
			"npm exec --yes --package=pnpm@10.33.0 -- pnpm: exit 1: registry unavailable",
		)
		await expect(resolution).rejects.toThrow("npm install --global pnpm@10.33.0")
	})

	it.each(["v20.10.0", "v22.18.9"])("rejects unsupported external Node %s before probing pnpm", async (version) => {
		const runProbe = runnerFor(version)

		await expect(resolveWorkflowPackageManager(undefined, runProbe)).rejects.toEqual(
			expect.objectContaining<Partial<WorkflowPackageManagerError>>({
				name: "WorkflowPackageManagerError",
				message: expect.stringContaining("external Node.js 22.19+"),
			}),
		)
		expect(runProbe).toHaveBeenCalledTimes(1)
	})

	it("detects a missing external Node even though the running process exposes a compatibility version", async () => {
		const emptyPath = await mkdtemp(path.join(tmpdir(), "kimchi-empty-path-"))
		temporaryDirectories.push(emptyPath)
		vi.stubEnv("PATH", emptyPath)

		await expect(resolveWorkflowPackageManager()).rejects.toThrow(/Node\.js is required.*node --version/)
	})

	it("reports the pinned pnpm installation command when no launcher is available", async () => {
		const runProbe: WorkflowPackageManagerProbeRunner = vi.fn(async ({ command }) => {
			if (command === "node") return { code: 0, stdout: "v22.19.0\n", stderr: "" }
			throw missingCommand(command)
		})

		await expect(resolveWorkflowPackageManager(undefined, runProbe)).rejects.toThrow(
			"npm install --global pnpm@10.33.0",
		)
	})
})

function missingCommand(command: string): NodeJS.ErrnoException {
	const error = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException
	error.code = "ENOENT"
	return error
}
