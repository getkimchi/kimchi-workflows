/**
 * Starting runs: `/workflow run <name|file.ts>` (spec §6.1) and `/workflow create` (spec §6.6).
 *
 * Both go through the same {@link startRun} lifecycle — guard, run-id, provenance, attended Q&A — so
 * `create` gets nothing bespoke beyond the initial input its steps need.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runWorkflow } from "../../engine/run-workflow.ts"
import type { WorkflowDefinition } from "../../flow/types.ts"
import { describeSchemaViolations } from "../../flow/validation.ts"
import createWorkflowWorkflow from "../builtin/create.workflow.ts"
import { createHostPort } from "../host-port.ts"
import { mintRunId } from "../naming.ts"
import { noProgressFor, type ProgressFor, progressCallbacks } from "../progress-sink.ts"
import { workflowsDir } from "../project-dir.ts"
import type { RunLock } from "../run-lock.ts"
import type { RunStore } from "../types.ts"
import { validateWorkflowTypeScript } from "../workflow-candidate-validator.ts"
import { resolveWorkflow } from "../workflow-catalog.ts"
import { handleAttendedInput, humanInputOf } from "./attended.ts"
import {
	type CommandCtx,
	describe,
	notifier,
	rejectIfBusy,
	reportResult,
	runGuarded,
	type StartAgent,
} from "./context.ts"

/** A parsed `/workflow run` argument line (spec §6.1): the target, plus `--input`'s raw, unparsed payload. */
export interface ParsedRunArgs {
	readonly target: string | undefined
	/** Everything after `--input`, verbatim: either inline JSON or `@<path>`. `undefined` when the flag was absent. */
	readonly inputArg: string | undefined
	/** Set only when `--input` was typed with nothing after it — a syntax error, not a resolution failure. */
	readonly error: string | undefined
}

/**
 * `--input` must be its own token — bounded by start-of-string/whitespace before it and
 * whitespace/end-of-string after — so a workflow name that merely CONTAINS the substring
 * (`my--input-migrator.workflow.ts`) is never mistaken for the flag.
 */
const INPUT_FLAG_RE = /(^|\s)--input(\s|$)/

/**
 * Parse `/workflow run <name|file.ts> [--input <json>|@<file>]` (spec §6.1).
 *
 * `--input`'s own payload is deliberately NOT tokenized the way the rest of `/workflow`'s arguments
 * are (`extension.ts` splits on `/\s+/` for every other subcommand): a JSON object routinely contains
 * spaces (`{"branch": "release notes"}`), and re-joining post-split tokens would already have
 * collapsed repeated whitespace the payload may have meant literally. So the caller hands this the RAW
 * text after `run` (whitespace-trimmed at the ends only), and everything from `--input` to the end of
 * the line is taken verbatim as the payload.
 */
export function parseRunArgs(raw: string): ParsedRunArgs {
	const trimmed = raw.trim()
	const match = INPUT_FLAG_RE.exec(trimmed)
	if (!match) return { target: trimmed || undefined, inputArg: undefined, error: undefined }

	const flagStart = match.index + (match[1]?.length ?? 0)
	const target = trimmed.slice(0, flagStart).trim() || undefined
	const inputArg = trimmed.slice(flagStart + "--input".length).trim()
	if (!inputArg) return { target, inputArg: undefined, error: "--input requires a value: inline JSON, or @<file>" }
	return { target, inputArg, error: undefined }
}

/** What `--input` resolved to (spec §6.1), or why it could not — bad JSON, an unreadable file, or a
 * schema violation are every one of them reported the same way: a notification, and no run started. */
export type InitialInputResolution =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string }

/**
 * Turn `--input`'s raw argument into a validated initial input (spec §6.1).
 *
 * Validation reuses {@link describeSchemaViolations} — the SAME TypeBox check the engine itself runs
 * on a workflow's declared input schema (`engine/run-workflow.ts`) — rather than hand-rolling a second
 * one that could drift from it. Doing it here, before `startRun` mints a run-id or touches the project
 * lock, is what makes a malformed payload cost nothing: no run-id is burned, no lock is acquired, and
 * no `run-meta`/`run-crashed` pair lands in the store. Letting the engine's own (still-present, §orig.)
 * check catch it would technically be correct too, but only after paying for all three.
 */
export async function resolveInitialInput(
	cwd: string,
	inputArg: string,
	workflow: Pick<WorkflowDefinition, "name" | "inputSchema">,
): Promise<InitialInputResolution> {
	const isFile = inputArg.startsWith("@")
	const filePath = isFile ? inputArg.slice(1) : undefined

	let source: string
	if (isFile && filePath !== undefined) {
		const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
		try {
			source = await readFile(resolved, "utf8")
		} catch (err) {
			return { ok: false, error: `could not read --input file "${filePath}": ${describe(err)}` }
		}
	} else {
		source = inputArg
	}

	let value: unknown
	try {
		value = JSON.parse(source)
	} catch (err) {
		const where = filePath !== undefined ? ` in "${filePath}"` : ""
		return { ok: false, error: `--input is not valid JSON${where}: ${describe(err)}` }
	}

	if (workflow.inputSchema) {
		// Same phrasing the engine's own pre-flight check would produce (`engine/run-workflow.ts`), so a
		// payload that somehow slipped past this earlier gate still reads consistently downstream.
		const violation = describeSchemaViolations(workflow.inputSchema, value)
		if (violation) return { ok: false, error: `workflow "${workflow.name}" input: ${violation}` }
	}

	return { ok: true, value }
}

/**
 * `/workflow run <name|file.ts> [--input <json>|@<file>]` — start a workflow named either by
 * declared name or by path, optionally seeded with initial input (spec §6.1).
 *
 * With no `inputArg`, behaviour is exactly what it was before `--input` existed: `undefined` initial
 * input, unchanged for every workflow that declares no top-level schema.
 */
export async function handleRun(
	ctx: CommandCtx,
	store: RunStore,
	guard: RunLock,
	startAgent: StartAgent,
	target: string,
	inputArg?: string,
	progressFor: ProgressFor = noProgressFor,
): Promise<void> {
	if (rejectIfBusy(ctx, guard, "starting")) return

	const resolution = await resolveWorkflow(ctx.cwd, target)
	if (!resolution.ok) {
		ctx.ui.notify(resolution.error, "error")
		return
	}

	try {
		await validateWorkflowTypeScript({ entryPath: resolution.filePath, projectRoot: ctx.cwd })
	} catch (error) {
		ctx.ui.notify(
			[
				`workflow "${resolution.workflow.name}" could not load`,
				`  File: ${resolution.filePath}`,
				`  ${describe(error)}`,
			].join("\n"),
			"error",
		)
		return
	}

	let initialInput: unknown
	if (inputArg !== undefined) {
		const resolved = await resolveInitialInput(ctx.cwd, inputArg, resolution.workflow)
		if (!resolved.ok) {
			ctx.ui.notify(`workflow: ${resolved.error}`, "error")
			return
		}
		initialInput = resolved.value
	}

	await startRun(ctx, store, guard, startAgent, resolution.workflow, resolution.filePath, initialInput, progressFor)
}

/**
 * `/workflow create` — run the built-in meta-workflow (src/host/builtin/create.workflow.ts) through
 * exactly the same machinery as any other run. It differs only in receiving the project root as its
 * initial input, which its steps use to resolve where the generated file should land.
 */
export async function handleCreate(
	ctx: CommandCtx,
	store: RunStore,
	guard: RunLock,
	startAgent: StartAgent,
	progressFor: ProgressFor = noProgressFor,
): Promise<void> {
	if (rejectIfBusy(ctx, guard, "starting")) return

	// The built-in ships with the extension, so it is imported directly rather than loaded from disk.
	// `workflowFilePath` still points at its module so a resume can reload it like any other run.
	const filePath = fileURLToPath(new URL("../builtin/create.workflow.ts", import.meta.url))
	// `workflowsDir` rides the initial input: the built-in cannot derive it itself (createInputSchema).
	const input = { projectRoot: ctx.cwd, workflowsDir: workflowsDir(ctx.cwd) }
	await startRun(ctx, store, guard, startAgent, createWorkflowWorkflow, filePath, input, progressFor)
}

/** Shared run lifecycle for `/workflow run` and `/workflow create` (spec §7, §8.9, §10.2). */
async function startRun(
	ctx: CommandCtx,
	store: RunStore,
	guard: RunLock,
	startAgent: StartAgent,
	workflow: WorkflowDefinition,
	workflowFilePath: string,
	initialInput: unknown,
	progressFor: ProgressFor,
): Promise<void> {
	// Mint the run-id up front so provenance is persisted *at run start* (spec §8.9); the engine stays
	// file-unaware and simply uses the injected id.
	//
	// A slug (`workflow-<name>-<8 hex>`, naming.ts) rather than a UUID, because this id is now the whole
	// user-facing identity: it names the log, it is embedded in every step session file, and it is what
	// `resume`/`cancel`/`delete` take back. "Which of these is my deploy run" has to be answerable from a
	// directory listing. The store's own log is what a candidate is checked against — a name shared by
	// many runs plus 32 random bits does collide eventually, and a collision would silently append one
	// run's events onto another's.
	const runId = await mintRunId(workflow.name, async (candidate) => (await store.loadEvents(candidate)).length > 0)

	// One sink for the whole invocation, disposed only when the command returns — NOT when the engine
	// call does. A blocked run keeps its widget while its questionnaire renders inline (progress §7.5):
	// the panel is what tells a user which step of what is asking, and the attended loop below is
	// several engine calls, not one.
	const progress = progressFor(workflow, runId, workflowFilePath)
	try {
		const result = await runGuarded(guard, runId, ctx.cwd, store, notifier(ctx), async (signal) => {
			// The adapter's own event (spec §8.9), not the engine's: `run-started` is emitted by the engine,
			// which is deliberately unaware of files, so where this run came FROM is recorded separately —
			// before the first engine event, so a crash mid-run still leaves a resumable log.
			await store.appendEvent({ type: "run-meta", runId, workflowFilePath, at: new Date().toISOString() })
			const host = createHostPort(store, {
				generateRunId: () => runId,
				startAgent,
				...progressCallbacks(progress),
			})
			return runWorkflow(workflow, initialInput, host, { signal })
		})
		if (!result) return // guard was busy (race) — already notified

		// Attended flow: if the run blocked, render the questionnaire inline and loop until it settles.
		if (result.status === "blocked") {
			await handleAttendedInput(
				ctx,
				store,
				guard,
				workflow.name,
				workflowFilePath,
				startAgent,
				runId,
				humanInputOf(result),
				progress,
			)
		} else {
			reportResult(ctx, workflow.name, result, progress.reportedOutcome())
		}
	} finally {
		progress.dispose()
	}
}
