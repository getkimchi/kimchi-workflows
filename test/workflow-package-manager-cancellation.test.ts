import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runWorkflowPackageManager } from "../src/host/workflow-package-manager.ts"

const commands = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock("cross-spawn", () => ({ spawn: commands.spawn }))
vi.mock("node:child_process", () => ({ execFile: commands.execFile }))

beforeEach(() => {
	vi.useFakeTimers()
	vi.spyOn(process, "platform", "get").mockReturnValue("win32")
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.resetAllMocks()
})

function startCommand() {
	const child = Object.assign(new EventEmitter(), {
		pid: 12345,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	})
	commands.spawn.mockReturnValue(child)
	const controller = new AbortController()
	const error = new Error("verification interrupted")
	const result = runWorkflowPackageManager({ command: "pnpm", args: [] }, ["install"], {
		cwd: process.cwd(),
		signal: controller.signal,
		timeoutMs: 100,
		timeoutError: () => error,
		outputLimit: 1024,
	})
	const rejected = vi.fn()
	void result.catch(rejected)
	return { child, controller, error, result, rejected }
}

describe("Windows workflow package manager cancellation", () => {
	it.each(["abort", "timeout"])("stops the process tree on %s before settling", async (reason) => {
		const { child, controller, error, result, rejected } = startCommand()
		if (reason === "abort") controller.abort(error)
		else await vi.advanceTimersByTimeAsync(100)

		expect(commands.execFile).toHaveBeenCalledWith(
			expect.stringMatching(/\\System32\\taskkill\.exe$/),
			["/PID", "12345", "/T", "/F"],
			{ windowsHide: true, timeout: 5000 },
			expect.any(Function),
		)
		expect(child.kill).not.toHaveBeenCalled()
		// A shell closing is not sufficient: taskkill may still be stopping its descendants.
		child.emit("close", 1)
		await Promise.resolve()
		expect(rejected).not.toHaveBeenCalled()
		const completeTreeKill = commands.execFile.mock.calls[0]![3] as (error: Error | null) => void
		completeTreeKill(null)
		await expect(result).rejects.toBe(error)
		expect(child.stdout.destroyed).toBe(true)
		expect(child.stderr.destroyed).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("settles after tree termination even when descendants never close their inherited pipes", async () => {
		const { controller, error, result } = startCommand()
		controller.abort(error)
		const completeTreeKill = commands.execFile.mock.calls[0]![3] as (error: Error | null) => void
		completeTreeKill(null)
		await expect(result).rejects.toBe(error)
	})

	it("reports tree-termination failure without waiting forever for inherited pipes", async () => {
		const { child, controller, error, result } = startCommand()
		controller.abort(error)
		const completeTreeKill = commands.execFile.mock.calls[0]![3] as (error: Error | null) => void
		completeTreeKill(new Error("taskkill timed out"))
		await expect(result).rejects.toThrow(
			"verification interrupted; could not terminate process tree: taskkill timed out",
		)
		expect(child.kill).toHaveBeenCalledWith("SIGKILL")
		expect(child.stdout.destroyed).toBe(true)
		expect(child.stderr.destroyed).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})
})
