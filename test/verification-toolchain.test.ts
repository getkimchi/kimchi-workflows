import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readInstalledPackage, resolveRuntimeModule } from "../src/verification/toolchain.ts"
import { prepareWorkflowPackageFixture } from "./workflow-package-fixture.ts"

describe("verification toolchain runtime resolution", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
	})

	async function preparedPackage(options: { sourceOnlyFramework?: boolean } = {}): Promise<string> {
		const root = await mkdtemp(path.join(tmpdir(), "verification-toolchain-"))
		roots.push(root)
		const directory = path.join(root, "workflows")
		await prepareWorkflowPackageFixture({ directory, sourceOnlyFramework: options.sourceOnlyFramework })
		return directory
	}

	it("resolves the framework's installed runtime modules for every public specifier", async () => {
		const packageRoot = await preparedPackage()
		const framework = await readInstalledPackage(packageRoot, "@kimchi-dev/kimchi-workflows")

		const resolved = [
			"@kimchi-dev/kimchi-workflows",
			"@kimchi-dev/kimchi-workflows/flow",
			"@kimchi-dev/kimchi-workflows/engine",
		].map((specifier) => resolveRuntimeModule(framework, specifier))

		// The fixture installs the repository itself, so every specifier resolves onto real source or dist files.
		for (const target of resolved) {
			expect(target).toMatch(/kimchi-workflows.*(src|dist).*(flow|engine).*index\.(ts|js)$/)
		}
	})

	it("falls back to the framework's TypeScript source when a clean local install has no dist", async () => {
		const packageRoot = await preparedPackage({ sourceOnlyFramework: true })
		const framework = await readInstalledPackage(packageRoot, "@kimchi-dev/kimchi-workflows")

		expect(resolveRuntimeModule(framework, "@kimchi-dev/kimchi-workflows")).toBe(
			path.join(framework.directory, "src", "flow", "index.ts"),
		)
		expect(resolveRuntimeModule(framework, "@kimchi-dev/kimchi-workflows/engine")).toBe(
			path.join(framework.directory, "src", "engine", "index.ts"),
		)
	})

	it("resolves third-party runtime modules through the project package", async () => {
		const packageRoot = await preparedPackage()
		const typebox = await readInstalledPackage(packageRoot, "typebox")
		const pi = await readInstalledPackage(packageRoot, "@earendil-works/pi-coding-agent")

		expect(resolveRuntimeModule(typebox, "typebox")).toMatch(/typebox.*\.(mjs|js)$/)
		expect(resolveRuntimeModule(pi, "@earendil-works/pi-coding-agent")).toMatch(/pi-coding-agent.*\.(mjs|js)$/)
	})

	it("rejects a specifier the package does not export without a source layout", async () => {
		const packageRoot = await preparedPackage()
		const typebox = await readInstalledPackage(packageRoot, "typebox")

		expect(() => resolveRuntimeModule(typebox, "@kimchi-dev/kimchi-workflows")).toThrow()
	})
})
