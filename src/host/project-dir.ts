/**
 * Where this package's on-disk state lives — derived from the harness that is actually running us,
 * never hardcoded to `.pi`.
 *
 * The whole host layer used to write to a literal `<cwd>/.pi/...`, which is correct for exactly one
 * embedder. Every other one (kimchi, or any product built on the same agent) owns its own dotted
 * project directory, and a workflow run that scattered `.pi/` into such a project would be writing
 * under a name that product does not recognise as its own. So the segment is read from the harness
 * itself: `piConfig.name` in the package.json next to `getPackageDir()` — the same field the harness
 * derives its own `APP_NAME` from — with `"pi"` as the fallback when the file is absent (a compiled
 * single-file binary may ship without one) or carries no name (vanilla `pi` sets only `configDir`).
 *
 * Deliberately NOT `CONFIG_DIR_NAME`, even though it is exported right beside `getPackageDir` and
 * looks like the obvious answer. It is a CONFIG dir name, not a project-directory segment, and its
 * value is only accidentally usable here: pi sets it to `.pi`, one dotted segment, so joining it onto
 * a cwd happens to produce something sane. kimchi sets it to `.config/kimchi/harness` — a HOME-relative
 * path — and `path.join(cwd, ".config/kimchi/harness")` would bury a project's workflows three levels
 * deep inside a directory that means something else entirely. `piConfig.name` is a plain identifier by
 * construction (it becomes the app's own name), which is exactly the shape a single path segment needs.
 *
 * Host-layer only: the engine never imports this — it has no filesystem at all (spec §2.1).
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { getPackageDir } from "@earendil-works/pi-coding-agent"

/** What a harness with no `piConfig.name` of its own is called (vanilla `pi` — see the module header). */
const DEFAULT_APP_NAME = "pi"

/**
 * The subdirectory OUR artifacts occupy inside whatever session directory the harness gave us.
 *
 * Load-bearing, and the reason it is a subdirectory rather than a prefix: the harness enumerates
 * sessions with a NON-RECURSIVE scan of its session directory (`findMostRecentSession`,
 * `listSessionsFromDir`, `SessionManager.list`), so anything one level down is invisible to `--continue`
 * and to both session pickers. Flat placement would put every step session in the pool the pickers draw
 * from: a single `.foreach` over 50 items would deposit 50 files that are valid sessions with a matching
 * cwd, so `--continue` would resume a workflow step instead of the user's own conversation, and the
 * picker would parse all 50 on every open, permanently. The harness sets the precedent itself by parking
 * `image-cache/` in the same directory for the same reason.
 */
const ARTIFACTS_SUBDIR = "workflow"

let cachedAppName: string | undefined

/**
 * Read the running harness's app name out of `<packageDir>/package.json`. Exported (rather than folded
 * into {@link appName}) so the resolution itself is testable against a fixture directory — the real
 * `getPackageDir()` is a property of the process, not an argument.
 *
 * Every failure mode lands on the same fallback on purpose: a missing file, unreadable file, invalid
 * JSON or absent key all mean "we are not being told a name", and a workflow run must not fail over it.
 */
export function readAppName(packageDir: string): string {
	try {
		const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
			piConfig?: { name?: unknown }
		}
		const name = pkg.piConfig?.name
		return typeof name === "string" && name.length > 0 ? name : DEFAULT_APP_NAME
	} catch {
		return DEFAULT_APP_NAME
	}
}

/** The running harness's app name (`pi`, `kimchi`, …), read once — the package.json cannot change under a live process. */
export function appName(): string {
	cachedAppName ??= readAppName(getPackageDir())
	return cachedAppName
}

/** A project's harness directory: `.pi` under pi, `.kimchi` under kimchi (spec §6.8/§8.9's `<project>/.<app>`). */
export function projectDir(projectRoot: string, app: string = appName()): string {
	return path.join(projectRoot, `.${app}`)
}

/** The directory a project's authored workflows live in — and the one the run lock sits in (spec §7.2). */
export function workflowsDir(projectRoot: string, app: string = appName()): string {
	return path.join(projectDir(projectRoot, app), "workflows")
}

/**
 * Where a run's artifacts — its event log (spec §8.9) and every step session file (spec §2.2) — are
 * written, given the harness's own session directory for this invocation.
 *
 * They live WITH the sessions rather than in the project directory because most of them ARE sessions:
 * a step session is written and resumed by the harness itself, and keeping it beside the user's own
 * sessions means one place holds everything a run produced, honouring `--session-dir` and the
 * `*_CODING_AGENT_SESSION_DIR` override for free. The `workflow/` subdir keeps them out of the
 * harness's enumerators (see {@link ARTIFACTS_SUBDIR}).
 *
 * `sessionDir` is `""` under `--no-session` (`SessionManager.inMemory` is constructed with an empty
 * session dir), which is a real mode a workflow can be launched in — and a run that could not record
 * its own log would not be resumable. So a falsy value falls back to the project's own
 * `<projectDir>/workflows/runs/`, and that branch takes NO `workflow/` subdir. The asymmetry is the
 * point rather than an oversight: the subdir exists solely to hide artifacts from enumerators that
 * scan the SESSION directory, and nothing enumerates the project's own — `runs/` already separates
 * them from the authoring sources, so a second level would name the same thing twice.
 */
export function runArtifactsDir(projectRoot: string, sessionDir: string | undefined): string {
	return sessionDir ? path.join(sessionDir, ARTIFACTS_SUBDIR) : path.join(workflowsDir(projectRoot), "runs")
}
