import { randomUUID } from "node:crypto"
import type { AgentRequest, AgentSession, HostPort, RunEvent, RunUpdate } from "../engine/types.ts"
import type { RunStore } from "./types.ts"

/** Overrides for the non-deterministic `HostPort` inputs. Handy for deterministic tests. */
export interface HostPortOptions {
	/** Supply run ids (default: `crypto.randomUUID`). */
	generateRunId?: () => string
	/** Supply the clock (default: `() => new Date()`). */
	now?: () => Date
	/** Supply the delay used for retry backoff / budget timers (default: a real, abortable `setTimeout`). */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
	/** Supply agent execution (default: throws — a store-only host does not support agent steps). */
	startAgent?: (request: AgentRequest) => AgentSession
	/**
	 * A tee on the event stream, called AFTER the event is persisted (progress §2.3). This is where the
	 * progress sink attaches: persist-then-render, so a rendering failure can never lose an event, and
	 * the ordering is enforced here rather than trusted to each caller.
	 *
	 * Deliberately not a replacement for `emit` and deliberately synchronous-looking: no progress code
	 * runs on the engine's thread of control beyond the `emit` call it already makes (progress §10.3),
	 * and a consumer that throws must not fail the step that emitted the event — which is why the sink
	 * catches everything and self-disables rather than relying on a guard here.
	 */
	onEvent?: (event: RunEvent) => void
	/** A non-durable progress tee. Unlike `onEvent`, it performs no store write. */
	onUpdate?: (update: RunUpdate) => void
	/** Execution epoch attached to run-level terminal events emitted by the engine. */
	executionId?: string
	/** Close the event stream synchronously while durable cancellation is being written. */
	acceptEvent?: (event: RunEvent) => boolean
}

/**
 * Build the engine's `HostPort` on top of any `RunStore`. Real usage backs it with the
 * filesystem store (src/host/fs-store.ts) plus a real `startAgent`; tests back it with the
 * in-memory store (src/host/memory-store.ts) and a scripted `startAgent`.
 */
export function createHostPort(store: RunStore, options: HostPortOptions = {}): HostPort {
	return {
		generateRunId: options.generateRunId ?? randomUUID,
		now: options.now ?? (() => new Date()),
		sleep: options.sleep ?? defaultSleep,
		startAgent:
			options.startAgent ??
			(() => {
				throw new Error("this HostPort has no agent support (no startAgent provided); agent steps cannot run")
			}),
		// Persist first, render second (progress §2.3) — never the other way round, and never in parallel.
		emit: async (event) => {
			if (options.acceptEvent && !options.acceptEvent(event)) return
			const durable = withExecutionId(event, options.executionId)
			await store.appendEvent(durable)
			options.onEvent?.(durable)
		},
		update: (update) => options.onUpdate?.(update),
	}
}

function withExecutionId(event: RunEvent, executionId: string | undefined): RunEvent {
	if (!executionId) return event
	if (event.type === "run-completed" || event.type === "run-crashed" || event.type === "run-cancelled") {
		return { ...event, executionId }
	}
	return event
}

/** Real timer that resolves after `ms`, or early if `signal` aborts (clearing the timer so it does not linger). */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve()
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				resolve()
			},
			{ once: true },
		)
	})
}
