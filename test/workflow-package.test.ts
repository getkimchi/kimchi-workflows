import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	prepareWorkflowPackage,
	type WorkflowPackageInstaller,
	type WorkflowPackagePreparationError,
} from "../src/host/workflow-package.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryWorkflowDirectory(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "kimchi-workflow-package-"))
	temporaryDirectories.push(root)
	return path.join(root, ".kimchi/workflows")
}

function successfulInstaller(): WorkflowPackageInstaller {
	return vi.fn(async (directory) => {
		await mkdir(path.join(directory, "node_modules/.bin"), { recursive: true })
		await Promise.all([
			writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8"),
			writeFile(
				path.join(
					directory,
					"node_modules/.bin",
					process.platform === "win32" ? "kimchi-workflows.cmd" : "kimchi-workflows",
				),
				"",
				"utf8",
			),
		])
		return { code: 0, stdout: "", stderr: "" }
	})
}

describe("workflow package preparation", () => {
	it("reports the resolved pinned launcher in the verification command", async () => {
		const directory = await temporaryWorkflowDirectory()
		const install = successfulInstaller()
		const packageManager = {
			command: "corepack",
			args: ["pnpm@10.33.0"],
		} as const

		const prepared = await prepareWorkflowPackage({
			directory,
			install,
			resolvePackageManager: async () => packageManager,
		})

		expect(install).toHaveBeenCalledWith(path.resolve(directory), undefined)
		expect(prepared.verifyCommand).toMatch(/^corepack pnpm@10\.33\.0 run verify:workflow/)
	})

	it("creates one private package with a reproducible verifier and lockfile", async () => {
		const directory = await temporaryWorkflowDirectory()
		const install = successfulInstaller()
		const resolvePackageManager = vi.fn(async () => ({ command: "pnpm", args: [] }))

		const prepared = await prepareWorkflowPackage({ directory, install, resolvePackageManager })
		const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8")) as {
			private: boolean
			packageManager: string
			scripts: Record<string, string>
			devDependencies: Record<string, string>
		}

		expect(prepared.installed).toBe(true)
		expect(manifest.private).toBe(true)
		expect(manifest.packageManager).toMatch(/^pnpm@/)
		expect(manifest.scripts).toMatchObject({
			verify: "vitest run",
			"verify:workflow": "kimchi-workflows verify",
		})
		expect(manifest.devDependencies["@kimchi-dev/kimchi-workflows"]).toMatch(/^file:/)
		expect(manifest.devDependencies).toMatchObject({
			typebox: expect.any(String),
			typescript: expect.any(String),
			vitest: expect.any(String),
		})
		expect(install).toHaveBeenCalledTimes(1)

		const unchanged = await prepareWorkflowPackage({ directory, install, resolvePackageManager })
		expect(unchanged.installed).toBe(false)
		expect(install).toHaveBeenCalledTimes(1)
		expect(resolvePackageManager).toHaveBeenCalledTimes(1)
		expect(unchanged.verifyCommand).toBe(
			'pnpm run verify:workflow -- --entry "<workflow.ts>" --test "<workflow.test.ts>"',
		)
	})

	it("preserves user dependencies and scripts while restoring the managed verification contract", async () => {
		const directory = await temporaryWorkflowDirectory()
		await mkdir(directory, { recursive: true })
		await writeFile(
			path.join(directory, "package.json"),
			`${JSON.stringify({
				name: "team-workflows",
				private: false,
				packageManager: "npm@11.0.0",
				scripts: { verify: "custom-check", "verify:workflow": "old-command" },
				dependencies: { "date-fns": "4.1.0" },
				devDependencies: { "custom-test-helper": "1.0.0" },
			})}\n`,
			"utf8",
		)

		await prepareWorkflowPackage({ directory, install: successfulInstaller() })
		const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {
			name: string
			private: boolean
			packageManager: string
			scripts: Record<string, string>
			dependencies: Record<string, string>
			devDependencies: Record<string, string>
		}

		expect(manifest.name).toBe("team-workflows")
		expect(manifest.private).toBe(true)
		expect(manifest.packageManager).toMatch(/^pnpm@/)
		expect(manifest.scripts.verify).toBe("custom-check")
		expect(manifest.scripts["verify:workflow"]).toBe("kimchi-workflows verify")
		expect(manifest.dependencies).toEqual({ "date-fns": "4.1.0" })
		expect(manifest.devDependencies["custom-test-helper"]).toBe("1.0.0")
	})

	it("migrates the previous generated verify alias without replacing a custom verify script", async () => {
		const directory = await temporaryWorkflowDirectory()
		await mkdir(directory, { recursive: true })
		await writeFile(
			path.join(directory, "package.json"),
			`${JSON.stringify({ scripts: { verify: "pnpm run verify:workflow" } })}\n`,
			"utf8",
		)

		await prepareWorkflowPackage({ directory, install: successfulInstaller() })
		const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {
			scripts: Record<string, string>
		}

		expect(manifest.scripts.verify).toBe("vitest run")
	})

	it("points the managed framework dependency at an explicitly supplied development package location", async () => {
		const directory = await temporaryWorkflowDirectory()
		const frameworkDirectory = path.join(path.dirname(directory), "framework")
		await mkdir(frameworkDirectory, { recursive: true })
		await writeFile(
			path.join(frameworkDirectory, "package.json"),
			`${JSON.stringify({ name: "@kimchi-dev/kimchi-workflows" })}\n`,
			"utf8",
		)
		vi.stubEnv("KIMCHI_WORKFLOWS_PACKAGE_DIR", frameworkDirectory)

		const prepared = await prepareWorkflowPackage({ directory, install: successfulInstaller() })
		const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8")) as {
			devDependencies: Record<string, string>
		}

		expect(manifest.devDependencies["@kimchi-dev/kimchi-workflows"]).toBe(
			`file:${frameworkDirectory.replaceAll(path.sep, "/")}`,
		)
	})

	it("rejects a development package location belonging to another package", async () => {
		const directory = await temporaryWorkflowDirectory()
		const frameworkDirectory = path.join(path.dirname(directory), "framework")
		await mkdir(frameworkDirectory, { recursive: true })
		await writeFile(path.join(frameworkDirectory, "package.json"), `${JSON.stringify({ name: "other" })}\n`, "utf8")
		vi.stubEnv("KIMCHI_WORKFLOWS_PACKAGE_DIR", frameworkDirectory)

		await expect(prepareWorkflowPackage({ directory, install: successfulInstaller() })).rejects.toThrow(
			"must point to the @kimchi-dev/kimchi-workflows package directory",
		)
	})

	it("fails before authoring when pnpm cannot prepare the package", async () => {
		const directory = await temporaryWorkflowDirectory()

		await expect(
			prepareWorkflowPackage({
				directory,
				install: async () => ({ code: 1, stdout: "", stderr: "registry unavailable" }),
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<WorkflowPackagePreparationError>>({
				name: "WorkflowPackagePreparationError",
				message: expect.stringMatching(/registry unavailable[\s\S]*Retry: pnpm --dir/),
			}),
		)
	})

	it("reports a concise recovery command when pnpm is not installed", async () => {
		const directory = await temporaryWorkflowDirectory()

		await expect(
			prepareWorkflowPackage({
				directory,
				install: async () => {
					const error = new Error("spawn pnpm ENOENT") as Error & { code: string }
					error.code = "ENOENT"
					throw error
				},
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<WorkflowPackagePreparationError>>({
				name: "WorkflowPackagePreparationError",
				message: expect.stringContaining("npm install --global pnpm@"),
			}),
		)
	})

	it("rejects package-manager resolution before touching the project package", async () => {
		const directory = await temporaryWorkflowDirectory()
		const resolvePackageManager = vi.fn(async () => {
			throw new Error("workflow packages require external Node.js 22.19+")
		})

		await expect(
			prepareWorkflowPackage({ directory, install: successfulInstaller(), resolvePackageManager }),
		).rejects.toEqual(
			expect.objectContaining<Partial<WorkflowPackagePreparationError>>({
				name: "WorkflowPackagePreparationError",
				message: expect.stringContaining("external Node.js 22.19"),
			}),
		)
		expect(existsSync(directory)).toBe(false)
	})
})
