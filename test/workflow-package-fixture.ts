import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { distribution } from "../src/host/distribution.ts"

const repositoryRoot = path.resolve(import.meta.dirname, "..")

/** Fast, offline package preparation for create-workflow unit tests. */
export async function prepareWorkflowPackageFixture(options: {
	readonly directory: string
	/** Exercise clean local installs where prepack has not generated dist declarations. */
	readonly sourceOnlyFramework?: boolean
}) {
	const directory = path.resolve(options.directory)
	const modules = path.join(directory, "node_modules")
	const framework = options.sourceOnlyFramework ? path.join(directory, ".source-only-framework") : repositoryRoot
	await mkdir(directory, { recursive: true })
	if (options.sourceOnlyFramework) {
		const repositoryManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
			exports: unknown
		}
		await mkdir(framework, { recursive: true })
		await Promise.all([
			writeFile(
				path.join(framework, "package.json"),
				`${JSON.stringify({
					name: "@kimchi-dev/kimchi-workflows",
					type: "module",
					exports: repositoryManifest.exports,
				})}\n`,
				"utf8",
			),
			symlink(path.join(repositoryRoot, "src"), path.join(framework, "src")),
		])
	}
	await Promise.all([
		mkdir(path.join(modules, ".bin"), { recursive: true }),
		mkdir(path.join(modules, "@kimchi-dev"), { recursive: true }),
		mkdir(path.join(modules, "@earendil-works"), { recursive: true }),
		writeFile(
			path.join(directory, "package.json"),
			`${JSON.stringify(
				{
					name: "test-project-workflows",
					private: true,
					type: "module",
					packageManager: distribution.packageManager,
					scripts: { "verify:workflow": "kimchi-workflows verify", verify: "vitest run" },
					devDependencies: {
						[distribution.name]:
							distribution.version === "0.0.0"
								? `file:${repositoryRoot.replaceAll(path.sep, "/")}`
								: distribution.version,
						"@earendil-works/pi-coding-agent": distribution.toolchain.piCodingAgent,
						"@earendil-works/pi-tui": distribution.toolchain.piTui,
						"@types/node": distribution.toolchain.typesNode,
						typebox: distribution.toolchain.typebox,
						typescript: distribution.toolchain.typescript,
						vitest: distribution.toolchain.vitest,
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		),
		writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8"),
	])
	await Promise.all([
		symlink(path.join(repositoryRoot, "bin/kimchi-workflows.mjs"), path.join(modules, ".bin/kimchi-workflows")),
		symlink(framework, path.join(modules, "@kimchi-dev", "kimchi-workflows")),
		symlink(
			path.join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
			path.join(modules, "@earendil-works", "pi-coding-agent"),
		),
		symlink(
			path.join(repositoryRoot, "node_modules", "@earendil-works", "pi-tui"),
			path.join(modules, "@earendil-works", "pi-tui"),
		),
		...["@types", "typebox", "typescript", "vitest"].map((name) =>
			symlink(path.join(repositoryRoot, "node_modules", name), path.join(modules, name)),
		),
	])
	return {
		directory,
		manifestPath: path.join(directory, "package.json"),
		lockfilePath: path.join(directory, "pnpm-lock.yaml"),
		verifyCommand: "pnpm run verify:workflow -- --entry <workflow.ts> --test <workflow.test.ts>",
		installed: true,
	}
}
