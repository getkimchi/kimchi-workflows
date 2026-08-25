import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { prepareWorkflowPackage } from "../../src/host/workflow-package.ts"

const root = await mkdtemp(path.join(tmpdir(), "kimchi-workflows-compiled-probe-"))
try {
	const prepared = await prepareWorkflowPackage({
		directory: path.join(root, ".kimchi/workflows"),
		install: async (directory) => {
			await mkdir(path.join(directory, "node_modules/.bin"), { recursive: true })
			await writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
			await writeFile(
				path.join(
					directory,
					"node_modules/.bin",
					process.platform === "win32" ? "kimchi-workflows.cmd" : "kimchi-workflows",
				),
				"",
				"utf8",
			)
			return { code: 0, stdout: "", stderr: "" }
		},
	})
	const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8")) as {
		packageManager: string
		devDependencies: Record<string, string>
	}
	process.stdout.write(
		JSON.stringify({
			framework: manifest.devDependencies["@kimchi-dev/kimchi-workflows"],
			packageManager: manifest.packageManager,
		}),
	)
} finally {
	await rm(root, { recursive: true, force: true })
}
