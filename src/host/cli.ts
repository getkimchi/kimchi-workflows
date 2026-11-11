/**
 * The headless CLI host: `kimchi workflow run` (dispatched by the Kimchi harness) and the package's
 * own `kimchi-workflows run` bin share this entry. One workflow runs to a terminal state in the
 * foreground, with NO chat session, and the outcome becomes the process exit status
 * (commands/batch.ts: 0 completed, 2 blocked, 3 cancelled, 4 crashed or never-started — command-line
 * syntax failures are "never-started", deliberately NOT 2, so `$?` keeps exactly four meanings).
 *
 * Where everything goes:
 *
 *  - **Run artifacts** land with the project's other workflow runs, `<project>/.<app>/workflows/runs`
 *    (project-dir.ts's session-less fallback); there is no chat session directory to park them in.
 *    The event log is the same durable, resumable record the in-session `/workflow run` writes —
 *    `/workflow resume <run-id>` can pick a blocked or cancelled batch run up in a chat session.
 *  - **Progress** is the plain append-only stderr renderer (progress-plain.ts); stdout stays
 *    machine-clean. `--result-out <path>` writes the terminal JSON artifact (result-artifact.ts).
 *  - **Catalog resolution** is the shared one (workflow-catalog.ts): the project's own workflows,
 *    then the user's global workflows directory, then an explicit `.ts` path.
 *
 * How agent steps get a model — there is no PI session and no model registry in this process.
 * Every step turn runs as a harness SUBPROCESS (pi-agent.ts's `createSubprocessAgentStarter`, the
 * same one-shot `… --mode json -p` mechanism `background` steps use inside a chat session), so the
 * model configuration story is exactly the harness's own:
 *
 *  - Under `kimchi workflow run` the child is the Kimchi binary itself: the user's Kimchi providers
 *    and credentials (auth.json, `KIMCHI_API_KEY`, or the standard provider env vars such as
 *    `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`) just apply, including any org policy. No extra setup.
 *  - Under the standalone `kimchi-workflows run` bin the child is `pi` from PATH, so `pi`'s own
 *    provider configuration applies instead.
 *  - A workflow-pinned model is handed to the child as `--model provider/id` and validated there.
 *
 * Signals: SIGINT/SIGTERM take the engine's durable graceful-cancel path (phase 1 checkpoint first,
 * cooperative abort second) and the run's `cancelled` terminal event is what exit 3 reports.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createActiveRuns } from "./active-runs.ts"
import { type BatchRunDeps, handleBatchRun } from "./commands/batch.ts"
import type { CommandCtx, StartAgent } from "./commands/index.ts"
import { createFsStore } from "./fs-store.ts"
import { createSubprocessAgentStarter, resolvePiInvocation } from "./pi-agent.ts"
import { runArtifactsDir } from "./project-dir.ts"
import { createProcessExecutionOwner } from "./run-lease.ts"

const USAGE = `usage: kimchi workflow run <file-name|file.ts> [--input <json>|@<file>] [--result-out <path>]

Run one workflow to a terminal state without a chat session.
Exit codes: 0 completed, 2 blocked, 3 cancelled (SIGINT/SIGTERM), 4 crashed or never started.
Agent steps run as harness subprocesses and use the harness's own provider configuration.`

/**
 * This package's own bin entry — used only to keep {@link resolveCliStepInvocation} from mistaking
 * the CLI for a harness when it is launched directly (`node …/kimchi-workflows.mjs run …`). Resolved
 * relative to THIS module so it works from both `src/host/` (dev, git installs) and `dist/host/`
 * (the published tarball), which have the same depth below the package root.
 */
const OWN_BIN = fileURLToPath(new URL("../../bin/kimchi-workflows.mjs", import.meta.url))

/** A parsed `run <name> [--input …] [--result-out <path>]` argument vector. */
export interface ParsedCliRunArgs {
	readonly target: string | undefined
	/** Everything after `--input`, joined with single spaces: inline JSON or `@<file>`. */
	readonly inputArg: string | undefined
	readonly resultOut: string | undefined
	readonly error: string | undefined
}

/**
 * Parse the CLI's argv. Mirrors `parseRunArgs`' shape and error text, but argv is already tokenized:
 * `--result-out` takes the next token, `--input` consumes the rest of the vector (its payload is a
 * verbatim JSON object that routinely contains spaces), and anything else starting with `--` is a
 * syntax error rather than something a workflow could be named.
 */
export function parseRunArgv(argv: readonly string[]): ParsedCliRunArgs {
	// `--result-out` comes out FIRST, wherever it sits: `--input` consumes the rest of the vector,
	// so a post-`--input` `--result-out` would otherwise be swallowed into the JSON payload (the
	// slash grammar's parseRunArgs extracts it from the raw line ahead of `--input` for the same
	// reason).
	let resultOut: string | undefined
	const remainder: string[] = []
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] !== "--result-out") {
			remainder.push(argv[index] as string)
			continue
		}
		const value = argv[index + 1]
		if (value === undefined) {
			return {
				target: undefined,
				inputArg: undefined,
				resultOut: undefined,
				error: "--result-out requires a value: <path>",
			}
		}
		if (resultOut !== undefined) {
			return { target: undefined, inputArg: undefined, resultOut: undefined, error: "duplicate --result-out" }
		}
		resultOut = value
		index++
	}

	let target: string | undefined
	let inputArg: string | undefined
	for (let index = 0; index < remainder.length; index++) {
		const token = remainder[index] as string
		if (token === "--input") {
			const payload = remainder
				.slice(index + 1)
				.join(" ")
				.trim()
			if (!payload) {
				return { target, inputArg: undefined, resultOut, error: "--input requires a value: inline JSON, or @<file>" }
			}
			inputArg = payload
			break // --input eats the line — nothing is parsed after it (parseRunArgs' own rule)
		}
		if (token.startsWith("--")) {
			return { target, inputArg, resultOut, error: `unknown option "${token}"` }
		}
		if (target !== undefined) {
			return { target, inputArg, resultOut, error: `unexpected argument "${token}"` }
		}
		target = token
	}
	return { target, inputArg, resultOut, error: undefined }
}

/** Process identity inputs for {@link resolveCliStepInvocation}, injectable for tests. */
export interface CliProcessIdentity {
	/** `process.argv[1]` of the running CLI process. Defaults to the real one. */
	readonly argv1?: string
	/** `process.execPath` of the running CLI process. Defaults to the real one. */
	readonly execPath?: string
	/** Absolute path of this package's bin entry; defaults to the real one. */
	readonly binEntry?: string
}

/**
 * Pick the binary a step's subagent turn spawns. Delegates to the production
 * {@link resolvePiInvocation} with ONE exception: when argv[1] is this package's own CLI entry, the
 * invocation must NOT respawn it — that re-enters argument parsing rather than starting an agent.
 * The remaining cases are then exactly `resolvePiInvocation`'s case 2 (a compiled harness executable
 * respawns itself) and case 3 (an interpreter-launched standalone CLI falls back to `pi` on PATH).
 */
export function resolveCliStepInvocation(
	args: readonly string[],
	identity: CliProcessIdentity = {},
): { command: string; args: readonly string[] } {
	const argv1 = identity.argv1 ?? process.argv[1]
	const execPath = identity.execPath ?? process.execPath
	const binEntry = identity.binEntry ?? OWN_BIN
	// Suppress case 1 for exactly this package's bin: respawning the CLI would re-enter argument
	// parsing rather than start an agent, which is what `resolvePiInvocation`'s remaining cases
	// handle. "" — not undefined, which would re-default to the REAL process.argv[1].
	const redirect = argv1 && path.resolve(argv1) !== path.resolve(binEntry) ? argv1 : ""
	return resolvePiInvocation(args, redirect, execPath)
}

/**
 * The seams the CLI needs that tests cannot be allowed to touch for real. `cwd` and `startAgent`
 * isolate the filesystem and the model; the rest forward to {@link handleBatchRun}'s own process
 * seams (exit capture, stderr capture, injectable signal source).
 */
export interface CliDeps extends BatchRunDeps {
	readonly cwd?: string
	/** Defaults to the harness-subprocess starter; tests inject a scripted or no-agent starter. */
	readonly startAgent?: StartAgent
}

function stderrLine(line: string): void {
	process.stderr.write(`${line}\n`)
}

function setProcessExitCode(code: number): void {
	process.exitCode = code
}

/**
 * CLI entry: `main(["run", "<name>", ...])`. Returns the exit code; the caller (bin script, or the
 * harness dispatching `kimchi workflow …`) sets it on the process. Everything user-facing —
 * progress, notifications, warnings, usage — is stderr; stdout carries NOTHING a scheduler could
 * mistake for output.
 */
/**
 * Package-command contract (kimchi-dev `src/commands/package-commands.ts`): when the package is
 * installed into the harness agent dir, its `kimchi.commands.workflow` manifest points here and
 * the dispatcher calls `run(args)` with the post-command argv (`["run", "<name>", ...]`).
 * Same exit-code contract as {@link main} — `run` is the boundary name, `main` remains the
 * testable host with injectable deps.
 */
export async function run(args: string[]): Promise<number> {
	return main(args)
}

export async function main(args: readonly string[], deps: CliDeps = {}): Promise<number> {
	const exit = deps.exit ?? setProcessExitCode
	const stderr = deps.stderr ?? stderrLine
	const fail = (message: string): number => {
		stderr(message)
		exit(4)
		return 4
	}

	const [verb, ...rest] = args
	if (verb === "--help" || verb === "-h") {
		stderr(USAGE)
		exit(0)
		return 0
	}
	if (verb !== "run") {
		return fail(
			verb === undefined
				? `workflow: a command is required.\n${USAGE}`
				: `workflow: unknown command "${verb}".\n${USAGE}`,
		)
	}
	const parsed = parseRunArgv(rest)
	if (parsed.error) return fail(`workflow: ${parsed.error}`)
	if (!parsed.target) return fail(USAGE)

	const cwd = deps.cwd ?? process.cwd()
	// No chat session exists, so the run's log and step sessions take project-dir.ts's session-less
	// placement: they land with the project's other runs and stay resumable from a chat session later.
	const runDir = runArtifactsDir(cwd, undefined)
	const store = createFsStore(runDir, { executionOwner: createProcessExecutionOwner() })
	const activeRuns = createActiveRuns()
	const startAgent =
		deps.startAgent ??
		createSubprocessAgentStarter(runDir, { invocationResolver: (args_) => resolveCliStepInvocation(args_) })
	// The command context handlers against: headless by construction — no UI, no model registry of
	// this process's own (agent turns run as harness subprocesses; see the module header), and every
	// notification a plain stderr line, exactly like the progress surface beside it.
	const ctx: CommandCtx = {
		cwd,
		ui: { notify: (message: string) => stderr(message) } as CommandCtx["ui"],
		mode: "print",
		hasUI: false,
		modelRegistry: {} as CommandCtx["modelRegistry"],
	}

	return handleBatchRun(
		ctx,
		store,
		activeRuns,
		startAgent,
		{ target: parsed.target, inputArg: parsed.inputArg, resultOut: parsed.resultOut },
		deps,
	)
}
