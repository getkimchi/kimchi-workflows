/**
 * Workflow catalog: discover the workflows a project defines, and resolve a command argument to one.
 *
 * Authored workflows live in `<projectRoot>/.<app>/workflows/` as `*.workflow.ts` (project-dir.ts
 * derives `<app>`), following the harness convention for project resources (`extensions/`, `skills/`,
 * `prompts/` under the same directory). This is a SOURCE directory: run logs and step sessions live in
 * the harness's session directory (project-dir.ts's `runArtifactsDir`).
 *
 * Installed identity comes from the filename, so completion and run lookup need only read the
 * directory. Listing still imports candidates for descriptions and broken-file diagnostics. Run
 * resolution validates and evaluates only the exact selected file.
 */
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { WorkflowDefinition } from "../flow/types.ts"
import { loadWorkflowFile, WORKFLOW_SUFFIX } from "./load-workflow.ts"
import { workflowsDir } from "./project-dir.ts"
import { loadValidatedWorkflow } from "./workflow-preflight.ts"
import { bindWorkflowFileIdentity, workflowFileIdentity } from "./workflow-source.ts"

export { WORKFLOW_SUFFIX } from "./load-workflow.ts"

/** A discovered workflow: its installed identity plus metadata loaded for catalog views. */
export interface WorkflowEntry {
	/** The source filename without `.workflow.ts`; canonical for completion, lookup, and new runs. */
	readonly identity: string
	/** The definition's authored name. Retained as definition metadata; it is not a command selector. */
	readonly name: string
	readonly description?: string
	readonly filePath: string
}

/** A file in the workflows directory that failed to load — surfaced rather than silently skipped. */
export interface BrokenWorkflow {
	readonly filePath: string
	readonly error: string
}

export interface WorkflowCatalog {
	readonly entries: readonly WorkflowEntry[]
	readonly broken: readonly BrokenWorkflow[]
}

type WorkflowLoader = (filePath: string) => Promise<WorkflowDefinition>

/** Cheap, load-free enumeration used by completion and missing-workflow diagnostics. */
export async function listWorkflowIdentities(projectRoot: string): Promise<readonly string[]> {
	return (await workflowFiles(projectRoot)).map(workflowFileIdentity)
}

/**
 * Load every workflow in the project's workflows directory, sorted by name. A file that throws is
 * reported in `broken` instead of failing the whole catalog — one unparseable workflow must not make
 * `/workflow list` useless. A missing directory is simply an empty catalog.
 */
export async function discoverWorkflows(projectRoot: string): Promise<WorkflowCatalog> {
	return scanWorkflows(projectRoot, loadWorkflowFile)
}

async function scanWorkflows(projectRoot: string, load: WorkflowLoader): Promise<WorkflowCatalog> {
	const entries: WorkflowEntry[] = []
	const broken: BrokenWorkflow[] = []

	for (const filePath of await workflowFiles(projectRoot)) {
		try {
			const workflow = await load(filePath)
			entries.push({
				identity: workflowFileIdentity(filePath),
				name: workflow.name,
				description: workflow.description,
				filePath,
			})
		} catch (err) {
			broken.push({ filePath, error: err instanceof Error ? err.message : String(err) })
		}
	}

	entries.sort((a, b) => a.identity.localeCompare(b.identity))
	return { entries, broken }
}

async function workflowFiles(projectRoot: string): Promise<string[]> {
	const dir = workflowsDir(projectRoot)
	const files = await readdir(dir).catch(() => [] as string[])
	return files
		.filter((name) => name.endsWith(WORKFLOW_SUFFIX))
		.sort()
		.map((file) => path.join(dir, file))
}

/** A resolved workflow, or a human-readable reason it could not be resolved. */
export type WorkflowResolution =
	| { ok: true; workflow: WorkflowDefinition; filePath: string }
	| { ok: false; error: string }

/**
 * Resolve `/workflow run <arg>` by explicit TypeScript path or installed filename identity. Declared
 * definition names are intentionally absent from this namespace: the exact selected file is validated,
 * loaded once, and its root runtime name is bound to the filename-derived identity.
 */
export async function resolveWorkflow(projectRoot: string, arg: string): Promise<WorkflowResolution> {
	const load = validatedLoader(projectRoot)
	if (arg.endsWith(".ts")) {
		const filePath = path.resolve(projectRoot, arg)
		if (!existsSync(filePath)) return { ok: false, error: `workflow: file does not exist\n  ${filePath}` }
		return loadAsResolution(filePath, arg, load)
	}

	const filePath = path.join(workflowsDir(projectRoot), `${arg}${WORKFLOW_SUFFIX}`)
	if (existsSync(filePath)) return loadAsResolution(filePath, arg, load)

	const known = await listWorkflowIdentities(projectRoot)
	const hint = known.length > 0 ? `\n  Known workflows: ${known.join(", ")}` : ""
	return { ok: false, error: `workflow: cannot find "${arg}"\n  Looked for: ${filePath}${hint}` }
}

/** Load `filePath` as a workflow, wrapping a failure with `arg` (the user-facing argument) for context. */
async function loadAsResolution(filePath: string, arg: string, load: WorkflowLoader): Promise<WorkflowResolution> {
	try {
		return { ok: true, workflow: bindWorkflowFileIdentity(await load(filePath), filePath), filePath }
	} catch (err) {
		return {
			ok: false,
			error: `workflow "${arg}" could not load\n  File: ${filePath}\n  ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

function validatedLoader(projectRoot: string): WorkflowLoader {
	return async (filePath) => {
		const loaded = await loadValidatedWorkflow({ filePath, projectRoot })
		if (loaded.ok) return loaded.workflow
		throw new Error(loaded.cause ?? "The workflow file no longer exists.")
	}
}
