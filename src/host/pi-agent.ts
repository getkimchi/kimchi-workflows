/**
 * Real PI-harness implementation of the engine's agent seam (`HostPort.startAgent`, spec §2.2).
 *
 * A session: resolve + `setModel(model)`, inject a hidden custom message that triggers a turn, await
 * the `agent_end` event, and return the last assistant message's text. Compiles against the real
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
import type { ContextEvent, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { AgentRequest, AgentSession, AgentTurn, ConversationMessage } from "../engine/types.ts"
import { resumeSessionFile, stepSessionName, traceSessionFile } from "./naming.ts"
import {
	type AgentMessages,
	lastAssistantError,
	lastAssistantText,
	lastAssistantUsage,
	lastSubmittedOutput,
	type ModelRegistry,
	resolveModel,
	seedHistory,
} from "./pi-agent-messages.ts"
import {
	activeToolsForStep,
	registerStepOutputTools,
	removeStepOutputToolSpec,
	STEP_OUTPUT_TOOLS_ENV,
	writeStepOutputToolSpec,
} from "./step-output-tools.ts"
import { runSubagent, type SubagentSpawner, subagentSpawner } from "./subagent-process.ts"

export type AgentStarter = (request: AgentRequest) => AgentSession

/** Public PI lifecycle controls needed to supervise an in-session turn. */
export type PiAgentControl = Pick<ExtensionCommandContext, "abort" | "hasPendingMessages" | "isIdle" | "waitForIdle">

/** Framework-owned model input: participates in context, but is never rendered as user-authored chat. */
const WORKFLOW_AGENT_MESSAGE = "kimchi-workflow-agent"

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
 * The `-e`/`--extension` flags the CURRENT process was launched with, which a step child needs too if it
 * is to register this extension's output tools (step-output-tools.ts).
 *
 * A flag has to be in the parent's own argv to be forwarded. A harness that loaded this extension some
 * other way (an installed package the child discovers on its own) needs nothing here; one that loaded it
 * by path and forwards nothing gets no tools in the child, and every step under an output contract then
 * FAILS — there is no text channel behind it, so this is a hard dependency, not a graceful degradation.
 * This is deliberately an allowlist rather than a general argv passthrough: the parent's session, prompt,
 * and unrelated flags belong to the parent alone.
 */
export function inheritedExtensionArgs(argv: readonly string[] = process.argv): string[] {
	const forwarded: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if ((arg === "-e" || arg === "--extension") && i + 1 < argv.length) {
			forwarded.push("-e", argv[i + 1] as string)
			i++
		} else if (arg?.startsWith("--extension=")) {
			forwarded.push("-e", arg.slice("--extension=".length))
		}
	}
	return forwarded
}

/**
 * The handoff file's stem for ONE execution (spec §8.5).
 *
 * Deliberately not derived from the session file: a `resumable` step reuses one session name across every
 * execution, so inside a `.foreach` its concurrent items would share a single handoff and
 * `writeFileSync`'s truncate would hand a sibling an empty read. `traceSessionFile` already encodes
 * run + path + attempt, which is exactly the identity a handoff needs.
 */
function stepOutputToolsStem(request: AgentRequest): string {
	return traceSessionFile(request.workflowName, request.runId, request.path, request.attempt).replace(/\.jsonl$/, "")
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
 * Resume files with a subagent writing to them right now.
 *
 * `.commit()` guarantees no two steps holding a STATIC shared key can overlap, and that used to settle
 * it. A per-execution key (`resumable` as a function, spec §2.2) cannot be checked there — it does not
 * exist until the step runs — so the same guarantee is made here instead, at the one place that knows
 * which file is actually about to be opened.
 *
 * The failure this rules out is silent: two children appending to one session interleave two
 * conversations into a file that still parses, and the damage surfaces later as a model confused by
 * words it never said. An author whose key function forgot the item index gets this error on the second
 * concurrent item instead — naming both paths, because the bug is always in what the key left out.
 */
const liveResumeFiles = new Map<string, string>()

function claimResumeFile(file: string, request: AgentRequest): () => void {
	if (!request.resumeKey) return () => {} // a trace file is unique per execution by construction
	const holder = liveResumeFiles.get(file)
	if (holder !== undefined) {
		throw new Error(
			`pi-agent bridge: step "${request.stepName}" (${request.path}) resolved resume key "${request.resumeKey}" ` +
				`while "${holder}" is still writing that same session file. Two subagents appending to one session ` +
				`interleave into nonsense (spec §2.2) — a per-execution resumable() must return a DISTINCT key for ` +
				`every concurrent execution, so include whatever distinguishes them (the .foreach item index) in it.`,
		)
	}
	liveResumeFiles.set(file, request.path)
	return () => {
		if (liveResumeFiles.get(file) === request.path) liveResumeFiles.delete(file)
	}
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
): (modelRegistry: ModelRegistry, sessionsDir: string, control?: PiAgentControl) => AgentStarter {
	// The ONE in-session turn currently awaiting the shared `agent_end` listener, if any (see the header
	// comment). `sessionToken` is an identity private to the session that started the turn — not the step
	// name, since the SAME step name can legitimately open several sessions across retries/repairs.
	// `turnToken` is finer-grained: a repair prompt can start from the previous `agent_end` handler before
	// PI's just-finished run has become idle, so that OLD turn's idle watcher must never settle the NEW one.
	let inFlight:
		| {
				readonly sessionToken: object
				readonly turnToken: object
				readonly stepName: string
				readonly resolve: (turn: AgentTurn) => void
				readonly cleanup: () => void
		  }
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
		turn.cleanup()
		turn.resolve({
			text: lastAssistantText(event.messages),
			usage: lastAssistantUsage(event.messages),
			submitted: lastSubmittedOutput(event.messages),
			error: lastAssistantError(event.messages),
		})
	})

	pi.on("context", (event: ContextEvent) => {
		if (!activeHistory) return // the common case: no resumed session is currently in flight
		const seeded = seedHistory(activeHistory.history, event.messages as AgentMessages)
		return seeded ? { messages: seeded } : undefined
	})

	return (modelRegistry, sessionsDir, control) => (request) => {
		// Isolation (spec §2.2/§12.2): a `background` step, and now also any step the ENGINE decided is
		// statically isolated (can overlap with a sibling — `.parallel`/`.foreach(concurrency>1)`, see
		// `AgentRequest.isolated`'s doc), both run through the same one-shot subprocess path. Neither ever
		// touches `inFlight` — there is no shared listener to correlate a subprocess's own reply with.
		if (request.background || request.isolated) {
			return backgroundSession(modelRegistry, request, invocationResolver, spawnSubagent, sessionsDir)
		}

		const sessionToken = {} // this session's own identity — see `inFlight`'s doc above
		// Captured per SESSION, not per bridge. extension.ts builds ONE bridge at extension load, so a
		// baseline held there freezes whatever the user's tools were during the FIRST run and silently
		// reverts anything they enable afterwards. Set only once this session actually narrows the set,
		// so a session rejected by the cross-talk guard cannot restore over a sibling's live turn.
		let toolBaseline: readonly string[] | undefined
		// An answer-resume (spec §8.4) arrives with its blocked step's stored conversation — seed it into
		// this session's outgoing LLM calls via the shared `context` handler above, for the session's whole
		// lifetime (cleared in `dispose()`). A fresh run's `request.history` is always undefined, so the
		// overwhelmingly common case never touches `activeHistory` at all.
		if (request.history) {
			activeHistory = { token: sessionToken, history: request.history as AgentMessages }
		}
		return {
			async sendAndAwaitEnd(message: string): Promise<AgentTurn> {
				// Safety net, not the primary mechanism (spec §2.2): static isolation is what is SUPPOSED to
				// keep two in-session turns from ever overlapping. If it somehow fails — a bug elsewhere, a step
				// the static analysis missed — this must fail LOUDLY and SPECIFICALLY rather than silently
				// overwrite `inFlight` and let the eventual `agent_end` resolve the WRONG caller with the OTHER
				// step's reply (the live cross-talk this bridge exists to rule out). Failing here also means the
				// second hidden message is never even issued — PI itself never sees two turns racing.
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

				// The output tools, scoped to THIS step (step-output-tools.ts). A spawned step gets them at
				// load from the env handoff and its process ends with the step; an in-session one shares a
				// process with every other step, so the schema is re-registered per turn AND the ACTIVE set
				// narrowed — registration alone leaks, since pi has no unregister.
				const spec = request.outputSchema ? { outputSchema: request.outputSchema, asks: request.asks } : undefined
				if (spec) {
					registerStepOutputTools(pi, spec)
					// Filtered on capture: pi ACTIVATES a tool when it is registered, and a previous step in this
					// session may already have registered one, so an unfiltered read would treat the framework's
					// own tool as something the user had and hand it back on dispose.
					toolBaseline ??= activeToolsForStep(pi.getActiveTools())
					pi.setActiveTools(activeToolsForStep(toolBaseline, spec))
				}
				// A contract-free step narrows nothing: the previous step's session restored the set on
				// dispose (the engine disposes in a `finally`), so there is nothing of ours left active.
				if (request.signal?.aborted) {
					throw new Error(`pi-agent bridge: step "${request.stepName}" was aborted before its turn started`)
				}

				return new Promise<AgentTurn>((resolve, reject) => {
					const turnToken = {}
					let removeAbortListener = () => {}
					const cleanup = () => removeAbortListener()
					const fail = (error: Error): void => {
						if (inFlight?.turnToken !== turnToken) return
						inFlight = undefined
						cleanup()
						reject(error)
					}

					inFlight = { sessionToken, turnToken, stepName: request.stepName, resolve, cleanup }

					if (request.signal) {
						const abortTurn = () => {
							// Releasing `inFlight` here would let a later workflow turn enter the same PI session
							// while this one may still be streaming. Ask PI to stop, then let `agent_end` or the
							// idle watcher below settle and release the turn safely.
							try {
								control?.abort()
							} catch {
								// `waitForIdle` remains the authoritative fallback if a host abort hook itself fails.
							}
						}
						request.signal.addEventListener("abort", abortTurn, { once: true })
						removeAbortListener = () => request.signal?.removeEventListener("abort", abortTurn)
					}

					// This is framework-to-agent traffic, not something the user typed. A custom message still
					// becomes a user-role message in the model context, while `display: false` keeps prompts,
					// questionnaire resumes, and output-repair schemas out of the parent transcript.
					// `sendMessage` is fire-and-forget: this catch only covers a synchronous binding failure;
					// the idle watcher below detects the asynchronous rejection PI reports via extension errors.
					try {
						pi.sendMessage(
							{ customType: WORKFLOW_AGENT_MESSAGE, content: message, display: false },
							{ triggerTurn: true },
						)
					} catch (error) {
						fail(error instanceof Error ? error : new Error(String(error)))
						return
					}

					if (control) {
						void (async () => {
							try {
								for (;;) {
									if (inFlight?.turnToken !== turnToken) return
									await control.waitForIdle()
									if (inFlight?.turnToken !== turnToken) return

									// A repair/answer sent from the preceding `agent_end` handler is queued while PI is
									// technically still finishing that run. Let PI's post-run continuation start before
									// deciding that this turn became idle without its own `agent_end`.
									await new Promise<void>((settle) => setTimeout(settle, 0))
									if (inFlight?.turnToken !== turnToken) return
									if (!control.isIdle() || control.hasPendingMessages()) continue

									fail(
										new Error(
											`pi-agent bridge: step "${request.stepName}" became idle without emitting agent_end; ` +
												"the PI turn failed before its completion event. PI reports the underlying " +
												"send_message failure separately through its extension-error output",
										),
									)
									return
								}
							} catch (error) {
								fail(
									new Error(
										`pi-agent bridge: could not verify completion of step "${request.stepName}": ${
											error instanceof Error ? error.message : String(error)
										}`,
									),
								)
							}
						})()
					}
				})
			},
			getConversation(): readonly ConversationMessage[] {
				return lastConversation
			},
			dispose(): void {
				// Only clear OUR OWN pending turn — never one a differently-identified session left in flight
				// (should not arise given the guard above, but dispose() must stay safe regardless, spec §2.2).
				if (inFlight?.sessionToken === sessionToken) {
					inFlight.cleanup()
					inFlight = undefined
				}
				if (activeHistory?.token === sessionToken) activeHistory = undefined
				// Hand the session back as we found it — but only if THIS session narrowed it. A session
				// rejected by the cross-talk guard never registered anything, and restoring from it would
				// strip the tools out from under the turn that is genuinely in flight.
				if (toolBaseline !== undefined) pi.setActiveTools(activeToolsForStep(toolBaseline))
			},
		}
	}
}

/**
 * A background subagent's session (spec §2.2): one `pi --mode json -p` subprocess per
 * `sendAndAwaitEnd` call. A second call is ordinary, not exceptional — a steering repair (spec §9.2)
 * spawns another process against the SAME `--session` file, which the CLI resumes, so the correction
 * lands in the conversation that already holds the work being corrected.
 * Isolated from the PARENT by construction: a fresh CLI invocation gets its own context window and tool
 * loop, with no access to the parent session's history — `request.history` is always undefined for a
 * background request (see AgentRequest's doc, engine/types.ts) so there is nothing to seed it with.
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
			// A spawned worker has no UI in which to confirm permission prompts. Run Kimchi workers in yolo
			// mode so a classifier outage cannot refuse their tools — including the framework-owned
			// `submit_result` that every reporting step needs to finish. The environment variable is ignored by
			// plain PI, unlike a Kimchi-only CLI flag that would make PI reject the invocation. This deliberately
			// bypasses every Kimchi permission check for the subprocess worker; an in-process step keeps the
			// parent session's permission posture.
			const session = sessionPath(sessionsDir, request)
			// Claimed before anything is spawned, released once the child is gone — see `liveResumeFiles`.
			const releaseResumeFile = claimResumeFile(session, request)
			const args = [
				"--mode",
				"json",
				"-p",
				"--session",
				session,
				"--name",
				stepSessionName(request.workflowName, request.path, request.runId),
				...(request.outputSchema ? inheritedExtensionArgs() : []),
			]
			if (request.model) {
				// Resolved (and rejected) up front, same as the interactive path: a typo'd model should fail
				// clearly here rather than surface as an opaque nonzero exit from the child process.
				if (!resolveModel(modelRegistry, request.model)) {
					throw new Error(`unknown model "${request.model}" (expected provider/modelId)`)
				}
				args.push("--model", request.model)
			}
			// The prompt goes over stdin (`runSubagent`/`writePrompt`), never in `args`: the respawned
			// harness reads its prompt from stdin and, with a piped (non-TTY) stdin, silently ignores a
			// positional argument — verified against a real `pi` binary (stdin: full reply, positional arg: nothing).

			// The step's output contract, handed to the child so it can register `submit_result` typed by it
			// (step-output-tools.ts). A tool call cannot be displaced by a later message, which is the whole
			// point. If the child never registers the tool the step FAILS — there is no text channel behind
			// it — so the handoff is written per EXECUTION, never per session file (see stepOutputToolsStem).
			const handoff = request.outputSchema
				? writeStepOutputToolSpec(sessionsDir, stepOutputToolsStem(request), {
						outputSchema: request.outputSchema,
						asks: request.asks,
					})
				: undefined
			const env: NodeJS.ProcessEnv = {
				KIMCHI_PERMISSIONS: "yolo",
				...(handoff ? { [STEP_OUTPUT_TOOLS_ENV]: handoff } : {}),
			}

			const invocation = invocationResolver(args)
			// The attempt's signal kills the child (spec §8.8/§9.4). Without that a cancelled run reports
			// itself stopped while this process keeps spending tokens and writing files, a wall-time budget
			// fails the attempt but orphans the process it was supposed to bound, and — with no budget, the
			// default — an unresponsive subagent hangs the run with nothing able to interrupt it.
			let result: Awaited<ReturnType<typeof runSubagent>>
			try {
				result = await runSubagent(spawnSubagent, invocation.command, invocation.args, message, request.signal, env)
			} finally {
				// The child read it at load, so the handoff has no readers left. One file per step per attempt
				// would otherwise accumulate beside the user's own sessions for the life of the project.
				if (handoff) removeStepOutputToolSpec(handoff)
				// Released on every path, including the aborted and non-zero-exit ones below: the child is gone
				// by the time `runSubagent` settles, so the next execution of this key may open the file.
				releaseResumeFile()
			}
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
