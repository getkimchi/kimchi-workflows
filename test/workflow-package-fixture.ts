import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

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
		await mkdir(framework, { recursive: true })
		await Promise.all([
			writeFile(
				path.join(framework, "package.json"),
				`${JSON.stringify({
					name: "@kimchi-dev/kimchi-workflows",
					type: "module",
					exports: {
						".": { types: "./dist/flow/index.d.ts", default: "./src/flow/index.ts" },
						"./flow": { types: "./dist/flow/index.d.ts", default: "./src/flow/index.ts" },
						"./engine": { types: "./dist/engine/index.d.ts", default: "./src/engine/index.ts" },
						"./host": { types: "./dist/host/index.d.ts", default: "./src/host/index.ts" },
						"./testing": { types: "./dist/testing/index.d.ts", default: "./src/testing/index.ts" },
					},
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
			`${JSON.stringify({
				name: "test-project-workflows",
				private: true,
				type: "module",
				scripts: { "verify:workflow": "kimchi-workflows verify" },
			})}\n`,
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
