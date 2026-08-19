import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { promisify } from "node:util"
import type { RunExecutionLease, RunExecutionOwner } from "./types.ts"

/** Stable identity for every workflow execution started by this extension process. */
export function createProcessExecutionOwner(now: () => Date = () => new Date()): RunExecutionOwner {
	const startedAtMs = now().getTime() - process.uptime() * 1_000
	return {
		ownerId: randomUUID(),
		host: hostname(),
		pid: process.pid,
		processStartedAt: new Date(startedAtMs).toISOString(),
	}
}

export function createRunExecutionLease(
	runId: string,
	owner: RunExecutionOwner,
	now: () => Date = () => new Date(),
	generateExecutionId: () => string = randomUUID,
): RunExecutionLease {
	return {
		version: 1,
		runId,
		executionId: generateExecutionId(),
		owner,
		acquiredAt: now().toISOString(),
	}
}

/** Local liveness only. A different host is intentionally never guessed about. */
const execFileAsync = promisify(execFile)

export async function isLocalProcessAlive(owner: RunExecutionOwner): Promise<boolean> {
	try {
		process.kill(owner.pid, 0)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false
	}

	// PID existence alone is not identity: after reuse it could keep an abandoned run locked forever.
	// `ps` gives the start instant on both macOS and Linux. If the platform cannot provide it, preserve
	// safety by treating the process as live rather than reclaiming a lease we cannot disprove.
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(owner.pid), "-o", "lstart="])
		const observed = Date.parse(stdout.trim())
		const recorded = Date.parse(owner.processStartedAt)
		if (Number.isNaN(observed) || Number.isNaN(recorded)) return true
		return Math.abs(observed - recorded) < 5_000
	} catch {
		return true
	}
}

export function sameLease(left: RunExecutionLease, right: RunExecutionLease): boolean {
	return (
		left.runId === right.runId && left.executionId === right.executionId && left.owner.ownerId === right.owner.ownerId
	)
}
