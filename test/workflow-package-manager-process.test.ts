import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runWorkflowPackageManager } from "../src/host/workflow-package-manager.ts"

const exec = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "kimchi-launcher-test-"))
	temporaryDirectories.push(directory)
	return directory
}

async function scriptLauncher(directory: string, name: string, source: string): Promise<string> {
	await mkdir(directory, { recursive: true })
	const script = path.join(directory, `${name}.cjs`)
	await writeFile(script, source, "utf8")
	const command = path.join(directory, name)
	if (process.platform === "win32") {
		await writeFile(`${command}.cmd`, `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`, "utf8")
	} else {
		await writeFile(command, `#!${process.execPath}\n${source}`, { mode: 0o755 })
	}
	return command
}

function runOptions(cwd: string) {
	return { cwd, timeoutMs: 10_000, timeoutError: () => new Error("launcher timed out"), outputLimit: 4096 }
}

describe("workflow package manager processes", () => {
	it.each(["corepack", "pnpm", "npm"])(
		"preserves project toolchain selection while isolating %s's pin",
		async (launcher) => {
			const root = await temporaryDirectory()
			const bin = path.join(root, "node_modules", ".bin")
			const application = path.join(root, "application")
			const log = path.join(root, "probe.json")
			await mkdir(application)
			await writeFile(path.join(application, "package.json"), '{"packageManager":"pnpm@10.32.1"}')
			await writeFile(path.join(application, ".tool-versions"), "nodejs 22.21.1\n")
			await scriptLauncher(
				bin,
				"node",
				`
const fs = require("node:fs");
console.log(fs.existsSync(".tool-versions") ? process.version : "v20.0.0");
`,
			)
			// Model pnpm's project-driven version switching in an actual child process, without registry access.
			await scriptLauncher(
				bin,
				launcher,
				`
const fs = require("node:fs");
const path = require("node:path");
if (!fs.existsSync(".tool-versions")) throw new Error("No project-selected Node version");
const args = process.argv.slice(2);
let directory = process.env.NPM_CONFIG_WORKSPACE_DIR ?? process.env.npm_config_workspace_dir ??
  (args.includes("--dir") ? args[args.indexOf("--dir") + 1] : process.cwd());
while (!fs.existsSync(path.join(directory, "package.json")) && path.dirname(directory) !== directory) {
  directory = path.dirname(directory);
}
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), directory, args }));
console.log(manifest.packageManager?.replace("pnpm@", "") ?? "10.33.0");
`,
			)
			const { stdout } = await exec(
				process.execPath,
				["--experimental-strip-types", path.join(import.meta.dirname, "fixtures/workflow-package-manager-probe.ts")],
				{
					cwd: application,
					env: {
						...process.env,
						PATH: bin,
						NPM_CONFIG_WORKSPACE_DIR: application,
						npm_config_workspace_dir: application,
					},
					timeout: 20_000,
				},
			)
			const args =
				launcher === "npm"
					? ["exec", "--yes", "--package=pnpm@10.33.0", "--", "pnpm"]
					: launcher === "corepack"
						? ["pnpm@10.33.0"]
						: []
			expect(JSON.parse(stdout)).toEqual({ command: launcher, args })
			const probe = JSON.parse(await readFile(log, "utf8")) as { cwd: string; directory: string; args: string[] }
			expect(probe.args).toEqual([...args, "--version", "--dir", probe.directory])
			expect(probe.cwd).toBe(await realpath(application))
			expect(probe.directory).not.toBe(application)
			expect(existsSync(probe.directory)).toBe(false)
		},
	)

	it("passes paths and shell metacharacters unchanged through a command shim", async () => {
		const root = await temporaryDirectory()
		const command = await scriptLauncher(
			path.join(root, "tool chain (test)", "node_modules", ".bin"),
			"pnpm",
			"process.stdout.write(JSON.stringify(process.argv.slice(2)))",
		)
		const args = ["--dir", "C:\\project with spaces\\", "a&b", "x|y", "%PATH%", "a^b", "!value!", 'a"b', ""]
		const result = await runWorkflowPackageManager({ command, args: [] }, args, runOptions(root))
		expect(result.code).toBe(0)
		expect(JSON.parse(result.stdout)).toEqual(args)
	})

	it.each(["abort", "timeout"])(
		"stops a shim's descendants on %s",
		async (reason) => {
			const root = await temporaryDirectory()
			const ready = path.join(root, "ready.json")
			const heartbeat = path.join(root, "heartbeat")
			const worker = `
const fs = require("node:fs");
let tick = 0;
fs.writeFileSync(${JSON.stringify(heartbeat)}, String(tick));
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.ppid, process.pid]));
setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++tick)), 25);
`
			const command = await scriptLauncher(
				path.join(root, "node_modules", ".bin"),
				"pnpm",
				`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "inherit" });`,
			)
			const controller = new AbortController()
			const error = new Error("verification interrupted")
			let failure: unknown
			const result = runWorkflowPackageManager({ command, args: [] }, [], {
				...runOptions(root),
				signal: controller.signal,
				timeoutMs: reason === "timeout" ? 2000 : 10_000,
				timeoutError: () => error,
			})
			void result.catch((cause: unknown) => {
				failure = cause
			})
			try {
				await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 1500 })
				if (reason === "abort") controller.abort(error)
				await vi.waitFor(() => expect(failure).toBe(error), { timeout: 7500 })
				const stopped = await readFile(heartbeat, "utf8")
				await delay(150)
				expect(await readFile(heartbeat, "utf8")).toBe(stopped)
			} finally {
				controller.abort(error)
				// Clean up even if a regression leaves the awaited close event or descendants alive.
				if (existsSync(ready)) {
					for (const pid of JSON.parse(await readFile(ready, "utf8")) as number[]) {
						try {
							process.kill(pid, "SIGKILL")
						} catch {
							/* Already terminated. */
						}
					}
				}
			}
		},
		15_000,
	)

	it.skipIf(process.platform !== "win32")("launches a native executable without requiring a cmd shim", async () => {
		const root = await temporaryDirectory()
		const command = path.join(root, "pnpm")
		await copyFile(process.execPath, `${command}.exe`)
		const result = await runWorkflowPackageManager(
			{ command, args: ["-e", 'process.stdout.write("10.33.0")'] },
			[],
			runOptions(root),
		)
		expect(result).toEqual({ code: 0, stdout: "10.33.0", stderr: "" })
	})
})
