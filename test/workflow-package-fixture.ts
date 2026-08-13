import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

const repositoryRoot = path.resolve(import.meta.dirname, "..")

/** Fast, offline package preparation for create-workflow unit tests. */
export async function prepareWorkflowPackageFixture(options: { readonly directory: string }) {
	const directory = path.resolve(options.directory)
	const modules = path.join(directory, "node_modules")
	await Promise.all([
		mkdir(path.join(modules, ".bin"), { recursive: true }),
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
