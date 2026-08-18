/**
 * Workflow catalog: discover the workflows a project defines, and resolve a command argument to one.
 *
 * Authored workflows live in `<projectRoot>/.<app>/workflows/` as `*.workflow.ts` (project-dir.ts
 * derives `<app>`), following the harness convention for project resources (`extensions/`, `skills/`,
 * `prompts/` under the same directory). This is a SOURCE directory: run logs and step sessions live in
 * the harness's session directory (project-dir.ts's `runArtifactsDir`).
 *
 * Listing imports every candidate to read its declared name, which executes trusted project code.
 * Run resolution uses a validated loader instead: semantic TypeScript must pass before any candidate
 * is evaluated, including candidates inspected during declared-name fallback.
 */
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { WorkflowDefinition } from "../flow/types.ts"
import { loadWorkflowFile, WORKFLOW_SUFFIX } from "./load-workflow.ts"
import { workflowsDir } from "./project-dir.ts"
import { loadValidatedWorkflow } from "./workflow-preflight.ts"

export { WORKFLOW_SUFFIX } from "./load-workflow.ts"

/** A discovered workflow: what `/workflow list` shows and what a name resolves to. */
export interface WorkflowEntry {
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
type LoadedWorkflowEntry = WorkflowEntry & { readonly workflow: WorkflowDefinition }

interface LoadedWorkflowCatalog {
	readonly entries: readonly LoadedWorkflowEntry[]
	readonly broken: readonly BrokenWorkflow[]
}

/**
 * Load every workflow in the project's workflows directory, sorted by name. A file that throws is
 * reported in `broken` instead of failing the whole catalog — one unparseable workflow must not make
 * `/workflow list` useless. A missing directory is simply an empty catalog.
 */
export async function discoverWorkflows(projectRoot: string): Promise<WorkflowCatalog> {
	const catalog = await scanWorkflows(projectRoot, loadWorkflowFile)
	return {
		entries: catalog.entries.map(({ workflow: _, ...entry }) => entry),
		broken: catalog.broken,
	}
}

async function scanWorkflows(projectRoot: string, load: WorkflowLoader): Promise<LoadedWorkflowCatalog> {
	const dir = workflowsDir(projectRoot)
	const files = await readdir(dir).catch(() => [] as string[])

	const entries: LoadedWorkflowEntry[] = []
	const broken: BrokenWorkflow[] = []

	for (const file of files.filter((name) => name.endsWith(WORKFLOW_SUFFIX)).sort()) {
		const filePath = path.join(dir, file)
		try {
			const workflow = await load(filePath)
			entries.push({ name: workflow.name, description: workflow.description, filePath, workflow })
		} catch (err) {
			broken.push({ filePath, error: err instanceof Error ? err.message : String(err) })
		}
	}

	entries.sort((a, b) => a.name.localeCompare(b.name))
	return { entries, broken }
}

/** A resolved workflow, or a human-readable reason it could not be resolved. */
export type WorkflowResolution =
	| { ok: true; workflow: WorkflowDefinition; filePath: string }
	| { ok: false; error: string }

/**
 * Resolve `/workflow run <arg>` to a workflow: a filesystem path first, then a declared name from the
 * catalog. Path wins so an explicit file always beats a coincidental name match; the name path only
 * runs when the argument does not name a loadable file. Three strategies, tried in order — an explicit
 * `.ts` path, the `<name>.workflow.ts` convention, then a full catalog scan — each its own helper below.
 */
export async function resolveWorkflow(projectRoot: string, arg: string): Promise<WorkflowResolution> {
	const load = validatedLoader(projectRoot)
	if (arg.endsWith(".ts")) {
		const filePath = path.resolve(projectRoot, arg)
		if (!existsSync(filePath)) return { ok: false, error: `workflow: file does not exist\n  ${filePath}` }
		return loadAsResolution(filePath, arg, load)
	}

	// Fast path: by convention a workflow lives in `<name>.workflow.ts`. Trying that first means the
	// common case imports exactly one module, instead of executing every workflow in the project just
	// to read their declared names.
	const byConvention = await resolveByConvention(projectRoot, arg, load)
	if (byConvention) return byConvention

	return resolveByCatalogName(projectRoot, arg, load)
}

/** Load `filePath` as a workflow, wrapping a failure with `arg` (the user-facing argument) for context. */
async function loadAsResolution(filePath: string, arg: string, load: WorkflowLoader): Promise<WorkflowResolution> {
	try {
		return { ok: true, workflow: await load(filePath), filePath }
	} catch (err) {
		return {
			ok: false,
			error: `workflow "${arg}" could not load\n  File: ${filePath}\n  ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

/** The `<name>.workflow.ts` convention path, if it exists AND its declared name actually matches `arg`. */
async function resolveByConvention(
	projectRoot: string,
	arg: string,
	load: WorkflowLoader,
): Promise<WorkflowResolution | undefined> {
	const byConvention = path.join(workflowsDir(projectRoot), `${arg}${WORKFLOW_SUFFIX}`)
	if (!existsSync(byConvention)) return undefined
	const loaded = await loadAsResolution(byConvention, arg, load)
	if (!loaded.ok) return loaded
	return loaded.workflow.name === arg ? loaded : undefined
}

/** Fall back to a full catalog scan, matching `arg` against every discovered workflow's declared name. */
async function resolveByCatalogName(
	projectRoot: string,
	arg: string,
	load: WorkflowLoader,
): Promise<WorkflowResolution> {
	const { entries, broken } = await scanWorkflows(projectRoot, load)
	const matches = entries.filter((entry) => entry.name === arg)

	if (matches.length === 1) {
		const match = matches[0] as LoadedWorkflowEntry
		return { ok: true, workflow: match.workflow, filePath: match.filePath }
	}
	if (matches.length > 1) {
		return {
			ok: false,
			error: `workflow "${arg}" is ambiguous\n${matches.map((entry) => `  ${entry.filePath}`).join("\n")}\n  Run again with an explicit file path.`,
		}
	}

	const known = entries.map((entry) => entry.name)
	const searched = path.join(workflowsDir(projectRoot), `${arg}${WORKFLOW_SUFFIX}`)
	const hint = known.length > 0 ? `\n  Known workflows: ${known.join(", ")}` : ""
	const brokenHint = broken
		.map((entry) => `\n  File: ${entry.filePath}\n  ${entry.error.replaceAll("\n", "\n  ")}`)
		.join("")
	return { ok: false, error: `workflow: cannot find "${arg}"\n  Looked for: ${searched}${hint}${brokenHint}` }
}

function validatedLoader(projectRoot: string): WorkflowLoader {
	return async (filePath) => {
		const loaded = await loadValidatedWorkflow({ filePath, projectRoot })
		if (loaded.ok) return loaded.workflow
		throw new Error(loaded.cause ?? "The workflow file no longer exists.")
	}
}
