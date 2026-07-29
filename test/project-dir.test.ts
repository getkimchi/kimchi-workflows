import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appName, projectDir, readAppName, runArtifactsDir, workflowsDir } from "../src/host/project-dir.ts"

/**
 * Where this package writes, derived from the HARNESS rather than hardcoded (spec §6.8/§8.9's
 * `<project>/.<app>`). `.pi` is right for exactly one embedder; kimchi — or anything else
 * built on the same agent — owns a directory of its own, and a workflow run scattering `.pi/` into such
 * a project would be writing under a name that product does not recognise.
 */
describe("app name resolution", () => {
	let packageDir: string

	beforeEach(async () => {
		packageDir = await mkdtemp(path.join(tmpdir(), "pi-workflows-pkg-"))
	})

	afterEach(async () => {
		await rm(packageDir, { recursive: true, force: true })
	})

	it("reads piConfig.name — the same field the harness derives its own APP_NAME from", async () => {
		await writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "@acme/kimchi", piConfig: { name: "kimchi", configDir: ".config/kimchi/harness" } }),
			"utf8",
		)
		expect(readAppName(packageDir)).toBe("kimchi")
	})

	// Every way of not being told a name lands on the same fallback: a run must not fail over it.
	it("falls back to pi when the name is absent, the file is missing, or it is not JSON", async () => {
		await writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "pi", piConfig: { configDir: ".pi" } }),
			"utf8",
		)
		expect(readAppName(packageDir)).toBe("pi") // vanilla pi declares only configDir

		const empty = await mkdtemp(path.join(tmpdir(), "pi-workflows-nopkg-"))
		expect(readAppName(empty)).toBe("pi") // a compiled single-file binary may ship no package.json
		await rm(empty, { recursive: true, force: true })

		await writeFile(path.join(packageDir, "package.json"), "{ not json", "utf8")
		expect(readAppName(packageDir)).toBe("pi")
	})

	it("resolves to `.pi` under the harness this suite actually runs against", () => {
		// The dev dependency is vanilla pi, which sets no piConfig.name — so the whole default path
		// (getPackageDir → package.json → fallback) is exercised end to end here.
		expect(appName()).toBe("pi")
		expect(projectDir("/proj")).toBe(path.join("/proj", ".pi"))
		expect(workflowsDir("/proj")).toBe(path.join("/proj", ".pi", "workflows"))
	})

	it("uses the harness's own segment when it has one, not CONFIG_DIR_NAME", () => {
		// CONFIG_DIR_NAME is only accidentally usable here: kimchi sets it to `.config/kimchi/harness`, a
		// HOME-relative path that joined onto a cwd would bury a project's workflows three levels deep.
		expect(projectDir("/proj", "kimchi")).toBe(path.join("/proj", ".kimchi"))
		expect(workflowsDir("/proj", "kimchi")).toBe(path.join("/proj", ".kimchi", "workflows"))
	})
})

/**
 * A run's artifacts live in the harness's session directory, one level down. The subdirectory is
 * load-bearing: the harness enumerates sessions with a NON-RECURSIVE scan, so a `workflow/` child is
 * invisible to `--continue` and to both session pickers — a `.foreach` over 50 items cannot hijack
 * "continue my last conversation" or make the picker parse 50 extra files forever.
 */
describe("run artifacts directory", () => {
	it("nests under the session directory the harness gave us", () => {
		const sessionDir = path.join("/home/u", ".pi", "agent", "sessions", "-proj")
		expect(runArtifactsDir("/proj", sessionDir)).toBe(path.join(sessionDir, "workflow"))
	})

	// `--no-session` builds the session manager with an empty session dir. A run that could not record
	// its own log would not be resumable, so it falls back into the project instead — and drops the
	// subdir with it: nothing enumerates the project directory, so `runs/` already does that whole job.
	it("falls back into the project, without the subdir, when there is no session directory (--no-session)", () => {
		const fallback = path.join("/proj", ".pi", "workflows", "runs")
		expect(runArtifactsDir("/proj", "")).toBe(fallback)
		expect(runArtifactsDir("/proj", undefined)).toBe(fallback)
	})
})
