/**
 * Real PI-harness implementation of the engine's agent seam (`HostPort.startAgent`, spec §2.2).
 *
 * A session: resolve + `setModel(model)`, `sendUserMessage(prompt)`, await the `agent_end` event,
 * and return the last assistant message's text. Compiles against the real
 * `@earendil-works/pi-coding-agent` types (`AgentEndEvent = { messages }`).
 *
 * A single `agent_end` listener is registered per bridge (the extension holds one bridge for its
 * lifetime) — `pi.on` exposes no unsubscribe, so `dispose()` clears the bridge's OWN in-flight turn
 * rather than removing the listener. That listener backs every IN-SESSION turn (never `background` or
 * statically `isolated` ones, spec §2.2 — those go through `backgroundSession` below, a real subprocess
 * per turn, with no shared listener to correlate). There is at most one real PI session, so at most one
 * in-session turn may ever be awaiting that listener at a time: `inFlight` tracks exactly that one turn
 * by an identity private to the session that started it, and a second `sendAndAwaitEnd` attempted while
 * one is already in flight is REJECTED outright — never silently swapped in as the thing the listener
 * resolves next. Before P3's `.parallel`/`.foreach(concurrency>1)` landed this could never happen (the
 * engine only ever ran one step at a time); the guard here is what makes that no longer an assumption
 * this file quietly depends on — see `flow/isolation.ts` for the static decision (tagged onto each step
 * at `.commit()`) that is now supposed to keep it from happening at all, and `AgentRequest.isolated`'s
 * doc (engine/types.ts) for the seam.
 *
 * `getConversation()` returns the last `agent_end` messages so a blocked Q&A step can be resumed
 * (spec §8.4). Within one live PI process that alone is enough — PI's own session already has the
 * context. Across a harness restart it is not: the fresh process's PI session starts with none of the
 * pre-restart turns, so `AgentRequest.history` (the stored conversation) must be seeded back in, or the
 * agent would answer a follow-up having forgotten what it asked and why. PI exposes exactly one
 * documented mechanism for that: the `context` extension event, fired before every outgoing LLM call
 * and wired straight into `AgentLoopConfig.transformContext` (`core/sdk.ts`) — "Injecting context from
 * external sources" per `docs/extensions.md`. There is no session-seeding constructor (no
 * `newSession({ messages })`, no way to pre-load `agent.state.messages` from an extension) — this is
 * the closest real capability to it, so the bridge below registers ONE shared `context` handler
 * (mirroring the `agent_end` listener's one-per-bridge-lifetime shape) that prepends whichever session's
 * `history` is currently active. It stays active for the WHOLE session, not just its first turn: PI's
 * own accumulated state does not fold the injected prefix back in (`transformContext` is a pre-call
 * view, not a state mutation), so a mid-attempt steering repair would otherwise see the seed vanish
 * after turn one. The pure prepend itself (`seedHistory`) lives in pi-agent-messages.ts, unit-tested
 * offline; only the PI wiring — registering the listener and tracking which session owns the active
 * seed — lives here.
 *
 * `background` requests (spec §2.2/§9.2): `ExtensionAPI` exposes no subagent-run primitive of its
 * own — there is no `runAgent`/`spawnAgent`/anything that opens an isolated agent conversation and
 * hands back a session. The one REAL mechanism PI gives an extension for isolation is shelling out to
 * a SECOND `pi` CLI process — exactly what PI's own bundled `examples/extensions/subagent/index.ts`
 * does, via `pi --mode json -p --no-session [--model ...] "<prompt>"`, parsing the NDJSON
 * `message_end` events for the final assistant message. That subprocess exits after one reply, so it
 * is inherently one-shot, not resumable — which is exactly why step-runner.ts never steers a
 * `background` step and instead lets invalid output fall back to the repeat policy (spec §9.2); it is
 * also why `getConversation()` below returns `[]` rather than any prior turns — there is nothing to
 * seed a resume with, and `.commit()` already rejects `background` + `asks` so one is never needed.
 *
 * The spawn itself goes through raw `child_process.spawn`, consuming `message_end` events off stdout as
 * they arrive — the same shape PI's own subagent tool uses. This comment used to argue the opposite, and
 * it is worth recording why, because the reasoning was sound and still lost. `pi.exec` — the "run a shell
 * command to completion" helper every extension already has — buffers the child's whole stdout and hands
 * back one string; upstream streams because a subagent TOOL has a live progress UI to feed, and a
 * background workflow step has no such UI, only a final structured output to read. Awaiting the whole
 * process was therefore simpler and, on the output, just as correct.
 *
 * What that argument never priced was the buffer. The parent pays one byte of resident heap for every
 * byte the child ever prints, for as long as the child runs, whether or not anyone will ever look at it —
 * and a subagent that greps a large tree prints hundreds of MB. The related waste was measured first and
 * fixed first (commit 02356e6): PARSING the whole stream to take its last message grew this process
 * **324MB -> 1.91GB in about two minutes while reading 367KB** on the `write-compressor` task, killing
 * its container three runs running. That left the buffer as the remaining term with the same shape —
 * cost tracking how much the child said rather than what this step needs — so it went the same way. It
 * buys a parent whose peak is one message plus one partial line no matter what the child emits.
 *
 * What it costs is the child's lifecycle, which `pi.exec` was quietly handling: killing it on abort, and
 * — less obviously — not waiting on `close` alone, since a subagent that daemonizes a descendant leaves
 * the inherited pipe open forever after the process itself is gone. Both are reimplemented, the same way
 * PI does them, in subagent-process.ts, which now holds this file's whole subprocess half:
 * `createAssistantTurnReader` (pi-agent-messages.ts) is the pure part, covered offline by fixtures
 * (test/pi-agent-messages.test.ts), and `SubagentSpawner` is the seam that makes the impure part
 * testable — the OS process itself is the one thing that genuinely cannot be exercised offline.
 *
 * `resolvePiInvocation` (below) picks WHICH binary that spawn targets — deliberately not a hardcoded
 * literal `"pi"`, since this module stays host-agnostic (no product-specific coupling beyond the
 * `ExtensionAPI` surface): a background step must respawn whatever harness is ACTUALLY running it
 * right now (kimchi, plain `pi`, or any other embedder), not a guess. It mirrors upstream's own
 * `examples/extensions/subagent/index.ts` (`getPiInvocation`) — the file this header already cites as
 * the isolation mechanism's model — confirmed live in the P7 harness pass: the plain global `pi`
 * binary has no knowledge of a host-specific provider (e.g. kimchi's own `kimchi-dev` gateway), so a
 * literal `"pi"` silently spawns the wrong binary whenever the embedding harness is anything other
 * than vanilla `pi` itself.
 */
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { AgentRequest, AgentSession, AgentTurn, ConversationMessage } from "../engine/types.ts"
import { resumeSessionFile, stepSessionName, traceSessionFile } from "./naming.ts"
import {
	type AgentMessages,
	lastAssistantText,
	lastAssistantUsage,
	type ModelRegistry,
	resolveModel,
	seedHistory,
} from "./pi-agent-messages.ts"
import { runSubagent, type SubagentSpawner, subagentSpawner } from "./subagent-process.ts"

export type AgentStarter = (request: AgentRequest) => AgentSession

/** What to spawn (the spawner's first two arguments) for a background subagent, given the CLI args after the binary name. */
export type PiInvocationResolver = (args: readonly string[]) => { command: string; args: readonly string[] }

/**
 * Respawn the CURRENTLY RUNNING harness process itself, so a background subagent always lands in the
 * same host it was launched from (same provider registry, same auth) — never a different product.
 * Three cases, in order, matching upstream's `getPiInvocation`:
 *   1. Dev/interpreter invocation (`node`/`bun script.ts ...`): `process.argv[1]` is a real file on
 *      disk → respawn `[process.execPath, thatScript, ...args]`.
 *   2. A compiled single-file executable (e.g. kimchi's built binary, or `pi`'s): `process.execPath`'s
 *      basename is not a generic runtime name → respawn `process.execPath` directly.
 *   3. Last resort — matches the previous hardcoded behaviour: literal `"pi"` on `PATH`.
 */
export function resolvePiInvocation(args: readonly string[]): { command: string; args: readonly string[] } {
	const currentScript = process.argv[1]
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/")
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] }
	}

	const execName = path.basename(process.execPath).toLowerCase()
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
	if (!isGenericRuntime) {
		return { command: process.execPath, args }
	}

	return { command: "pi", args }
}

/**
 * Permission-bypass flags the CURRENT process was launched with, which every subagent it spawns must be
 * launched with too.
 *
 * `resolvePiInvocation` above respawns the harness that is running right now precisely so a subagent
 * inherits its provider, auth and model registry rather than guessing at them. Permission posture is the
 * one part of that inheritance the argv does not carry for free: the parent's mode is decided from ITS
 * argv, and a fresh process reads its own. So a run launched with permissions bypassed was spawning
 * subagents that re-armed the classifier — measured on a benchmark run, **59 tool calls refused inside
 * subagent sessions while the parent had none**, including `mkdir -p` and `test -f`, with one task lost
 * outright because its worker could not install a package the task itself required and burned its budget
 * trying to talk its way around the refusal. The parent had no such trouble.
 *
 * Inheriting is safe in the only direction that matters: a flag has to be present in the PARENT's own
 * argv to be forwarded, so this can never make a child more permissive than the process that started it,
 * and a normally-launched session keeps its subagents' checks armed. It is deliberately a small, explicit
 * allowlist rather than a general argv passthrough — forwarding the parent's whole command line would
 * hand a subagent its `--session`, its prompt, and anything else the embedder happened to pass.
 */
const PERMISSION_BYPASS_FLAGS = ["--dangerously-skip-permissions", "--yolo"] as const

export function inheritedPermissionArgs(argv: readonly string[] = process.argv): string[] {
	return PERMISSION_BYPASS_FLAGS.filter((flag) => argv.includes(flag))
}

/**
 * Where this step's session file goes, and what it is called (naming.ts owns the names).
 *
 * `dir` is the run-artifacts directory the bridge was BOUND to — the harness's own session directory
 * plus our `workflow/` subdir (project-dir.ts). A step session is a genuine harness session file, so it
 * belongs with the user's sessions rather than in a private corner of the project; the subdir is what
 * keeps it out of `--continue` and the session pickers.
 *
 * Two shapes, structurally disjoint by their `-key-`/`-run-` infix:
 *  - a `resumeKey` step names the SAME file every execution, which is what makes the next execution
 *    continue this one (spec §2.2). `.commit()` has cleared the key of path syntax (spec §3) and
 *    established that no two steps holding a shared key can overlap, so the file has one writer at a time.
 *  - everything else gets a file of its OWN, named once and never read back: it still starts cold — a
 *    fresh, small context per step is what makes a chain of isolated steps cheap, and a verifier's whole
 *    value is not remembering — but it now leaves a record. `--no-session` threw exactly that away for
 *    the majority of a run, so per-step token accounting was unavailable and a step that behaved oddly
 *    left nothing to read.
 */
function sessionPath(dir: string, request: AgentRequest): string {
	mkdirSync(dir, { recursive: true })
	const file = request.resumeKey
		? resumeSessionFile(request.workflowName, request.resumeKey)
		: traceSessionFile(request.workflowName, request.runId, request.path, request.attempt)
	return path.join(dir, file)
}

/**
 * Create the PI agent bridge. Call once per extension instance (registers one `agent_end` listener),
 * then obtain a per-invocation `AgentStarter` bound to the command's model registry AND to the
 * directory that invocation's sessions belong in. The directory arrives at BIND time, not here: this
 * runs at extension LOAD, when no `ctx` — and therefore no session directory — exists yet, while every
 * `ExtensionCommandContext`/`ExtensionContext` the harness hands a handler carries one.
 *
 * `invocationResolver` defaults to {@link resolvePiInvocation}; tests inject a fixed stub instead of
 * depending on the live process's own argv/execPath. `spawnSubagent` defaults to
 * {@link subagentSpawner} — a real child process — and is the seam tests drive a scripted
 * stdout/stderr through.
 */
export function createPiAgentBridge(
	pi: ExtensionAPI,
	invocationResolver: PiInvocationResolver = resolvePiInvocation,
	spawnSubagent: SubagentSpawner = subagentSpawner,
): (modelRegistry: ModelRegistry, sessionsDir: string) => AgentStarter {
	// The ONE in-session turn currently awaiting the shared `agent_end` listener, if any (see the header
	// comment). `token` is an identity private to the session that started the turn — not the step name,
	// since the SAME step name can legitimately open several sessions across retries/repairs, and dispose()
	// must only ever clear a turn it itself started, never a sibling's.
	let inFlight:
		| { readonly token: object; readonly stepName: string; readonly resolve: (turn: AgentTurn) => void }
		| undefined
	let lastConversation: AgentMessages = []
	// The one answer-resumed session (spec §8.4) currently entitled to have its stored `history` seeded
	// into every outgoing LLM call — see the header comment. Token-guarded exactly like `inFlight`, so a
	// session can only ever clear the seed IT set (never a sibling's), and cleared in `dispose()`.
	let activeHistory: { readonly token: object; readonly history: AgentMessages } | undefined

	pi.on("agent_end", (event) => {
		lastConversation = event.messages
		const turn = inFlight
		if (!turn) return // no in-session turn was awaiting this event (only background/isolated steps ran)
		inFlight = undefined
		turn.resolve({ text: lastAssistantText(event.messages), usage: lastAssistantUsage(event.messages) })
	})

	pi.on("context", (event: ContextEvent) => {
		if (!activeHistory) return // the common case: no resumed session is currently in flight
		const seeded = seedHistory(activeHistory.history, event.messages as AgentMessages)
		return seeded ? { messages: seeded } : undefined
	})

	return (modelRegistry, sessionsDir) => (request) => {
		// Isolation (spec §2.2/§12.2): a `background` step, and now also any step the ENGINE decided is
		// statically isolated (can overlap with a sibling — `.parallel`/`.foreach(concurrency>1)`, see
		// `AgentRequest.isolated`'s doc), both run through the same one-shot subprocess path. Neither ever
		// touches `inFlight` — there is no shared listener to correlate a subprocess's own reply with.
		if (request.background || request.isolated) {
			return backgroundSession(modelRegistry, request, invocationResolver, spawnSubagent, sessionsDir)
		}

		const token = {} // this session's own identity — see `inFlight`'s doc above
		// An answer-resume (spec §8.4) arrives with its blocked step's stored conversation — seed it into
		// this session's outgoing LLM calls via the shared `context` handler above, for the session's whole
		// lifetime (cleared in `dispose()`). A fresh run's `request.history` is always undefined, so the
		// overwhelmingly common case never touches `activeHistory` at all.
		if (request.history) {
			activeHistory = { token, history: request.history as AgentMessages }
		}
		return {
			async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
				// Safety net, not the primary mechanism (spec §2.2): static isolation is what is SUPPOSED to
				// keep two in-session turns from ever overlapping. If it somehow fails — a bug elsewhere, a step
				// the static analysis missed — this must fail LOUDLY and SPECIFICALLY rather than silently
				// overwrite `inFlight` and let the eventual `agent_end` resolve the WRONG caller with the OTHER
				// step's reply (the live cross-talk this bridge exists to rule out). Failing here also means the
				// second `sendUserMessage` is never even issued — PI itself never sees two turns racing.
				if (inFlight) {
					throw new Error(
						`pi-agent bridge: step "${request.stepName}" tried to start an in-session agent turn while step ` +
							`"${inFlight.stepName}"'s turn is still in flight. A PI session hosts one conversation at a time ` +
							"(spec §2.2) — this step should have been statically isolated (background subprocess); refusing " +
							`to let the two turns cross-talk rather than resolving one with the other's reply.`,
					)
				}

				if (request.model) {
					const model = resolveModel(modelRegistry, request.model)
					if (!model) {
						throw new Error(`unknown model "${request.model}" (expected provider/modelId)`)
					}
					const ok = await pi.setModel(model)
					if (!ok) {
						throw new Error(`no API key available for model "${request.model}"`)
					}
				}
				return new Promise<AgentTurn>((resolve) => {
					inFlight = { token, stepName: request.stepName, resolve }
					pi.sendUserMessage(message)
				})
			},
			getConversation(): readonly ConversationMessage[] {
				return lastConversation
			},
			dispose(): void {
				// Only clear OUR OWN pending turn — never one a differently-identified session left in flight
				// (should not arise given the guard above, but dispose() must stay safe regardless, spec §2.2).
				if (inFlight?.token === token) inFlight = undefined
				if (activeHistory?.token === token) activeHistory = undefined
			},
		}
	}
}

/**
 * A background subagent's session (spec §2.2): one `pi --mode json -p` subprocess per
 * `sendAndAwaitEnd` call (step-runner.ts calls it exactly once — a background step's repair budget is
 * forced to 0, spec §9.2 — but nothing here assumes that; a second call just spawns a second process).
 * Isolated by construction: a fresh CLI invocation gets its own context window and tool loop, with no
 * access to the parent session's history — `request.history` is always undefined for a background
 * request (see AgentRequest's doc, engine/types.ts) so there is nothing to seed it with anyway.
 */
function backgroundSession(
	modelRegistry: ModelRegistry,
	request: AgentRequest,
	invocationResolver: PiInvocationResolver,
	spawnSubagent: SubagentSpawner,
	sessionsDir: string,
): AgentSession {
	return {
		async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
			// `--session <path>` both writes and RESUMES that file (the CLI's own wording), and stays a PATH
			// rather than the `--session-id` this file now owns a stable id for: `--session-id` sends the CLI
			// through `findLocalSessionByExactId` → `SessionManager.list`, which parses EVERY session in the
			// project before it can start — on every single subagent spawn, of which a fan-out step makes many.
			// The path form short-circuits on any argument containing `/` or ending `.jsonl`. Owning the path
			// also means owning the whole filename (the id form prefixes a `<timestamp>_`), which is what makes
			// `workflow-` a true prefix of everything a run writes. See {@link sessionPath} for the two shapes.
			// `--name` costs nothing and makes the file legible if anyone ever opens it in a picker; the HOST
			// session's name is deliberately left alone — that one belongs to the user, not to us.
			// Permission posture is inherited, not defaulted (see `inheritedPermissionArgs`): a subagent of a
			// run that bypasses permissions must bypass them too, or it re-arms the classifier and spends its
			// budget arguing with a prompt no one is there to answer.
			const args = [
				"--mode",
				"json",
				"-p",
				"--session",
				sessionPath(sessionsDir, request),
				"--name",
				stepSessionName(request.workflowName, request.path, request.runId),
				...inheritedPermissionArgs(),
			]
			if (request.model) {
				// Resolved (and rejected) up front, same as the interactive path: a typo'd model should fail
				// clearly here rather than surface as an opaque nonzero exit from the child process.
				if (!resolveModel(modelRegistry, request.model)) {
					throw new Error(`unknown model "${request.model}" (expected provider/modelId)`)
				}
				args.push("--model", request.model)
			}
			args.push(message)

			const invocation = invocationResolver(args)
			// The attempt's signal kills the child (spec §8.8/§9.4). Without that a cancelled run reports
			// itself stopped while this process keeps spending tokens and writing files, a wall-time budget
			// fails the attempt but orphans the process it was supposed to bound, and — with no budget, the
			// default — an unresponsive subagent hangs the run with nothing able to interrupt it.
			const result = await runSubagent(spawnSubagent, invocation.command, invocation.args, request.signal)
			if (request.signal?.aborted) {
				throw new Error(`background subagent step "${request.stepName}" was aborted`)
			}
			if (result.code !== 0) {
				throw new Error(
					`background subagent step "${request.stepName}" exited with code ${result.code}: ${result.stderrTail.trim() || "(no stderr)"}`,
				)
			}

			// Already reduced to the final assistant turn while the child was still running — nothing here
			// ever held its stdout (see the header comment and `createAssistantTurnReader`).
			return result.turn
		},
		getConversation(): readonly ConversationMessage[] {
			return [] // one-shot: never resumed with seeded history (spec §2.2/§10.1 — background can't ask)
		},
		dispose(): void {},
	}
}
