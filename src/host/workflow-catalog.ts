/**
 * Workflow catalog: discover the workflows a project defines, and resolve a command argument to one.
 *
 * Authored workflows live in `<projectRoot>/.<app>/workflows/` as `*.workflow.ts` (project-dir.ts
 * derives `<app>`), following the harness convention for project resources (`extensions/`, `skills/`,
 * `prompts/` under the same directory). This is now a SOURCE directory and nothing else: run logs and
 * step sessions moved to the harness's session directory (project-dir.ts's `runArtifactsDir`), and the
 * only non-source file left here is the dot-prefixed run lock.
 *
 * Discovery *imports* every candidate to read its declared name, which executes project code — the
 * same trust boundary the harness's own `extensions/` sits behind. Workflow modules must therefore be
 * free of import-time side effects: build the definition, export it, do nothing else.
 */
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { WorkflowDefinition } from "../flow/types.ts"
import { loadWorkflowFile, WORKFLOW_SUFFIX } from "./load-workflow.ts"
import { workflowsDir } from "./project-dir.ts"

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

/**
 * Load every workflow in the project's workflows directory, sorted by name. A file that throws is
 * reported in `broken` instead of failing the whole catalog — one unparseable workflow must not make
 * `/workflow list` useless. A missing directory is simply an empty catalog.
 */
export async function discoverWorkflows(projectRoot: string): Promise<WorkflowCatalog> {
	const dir = workflowsDir(projectRoot)
	const files = await readdir(dir).catch(() => [] as string[])

	const entries: WorkflowEntry[] = []
	const broken: BrokenWorkflow[] = []

	for (const file of files.filter((name) => name.endsWith(WORKFLOW_SUFFIX)).sort()) {
		const filePath = path.join(dir, file)
		try {
			const workflow = await loadWorkflowFile(filePath)
			entries.push({ name: workflow.name, description: workflow.description, filePath })
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
	if (arg.endsWith(".ts")) {
		return loadAsResolution(path.resolve(projectRoot, arg), arg)
	}

	// Fast path: by convention a workflow lives in `<name>.workflow.ts`. Trying that first means the
	// common case imports exactly one module, instead of executing every workflow in the project just
	// to read their declared names.
	const byConvention = await resolveByConvention(projectRoot, arg)
	if (byConvention) return byConvention

	return resolveByCatalogName(projectRoot, arg)
}

/** Load `filePath` as a workflow, wrapping a failure with `arg` (the user-facing argument) for context. */
async function loadAsResolution(filePath: string, arg: string): Promise<WorkflowResolution> {
	try {
		return { ok: true, workflow: await loadWorkflowFile(filePath), filePath }
	} catch (err) {
		return { ok: false, error: `failed to load "${arg}": ${err instanceof Error ? err.message : String(err)}` }
	}
}

/** The `<name>.workflow.ts` convention path, if it exists AND its declared name actually matches `arg`. */
async function resolveByConvention(projectRoot: string, arg: string): Promise<WorkflowResolution | undefined> {
	const byConvention = path.join(workflowsDir(projectRoot), `${arg}${WORKFLOW_SUFFIX}`)
	if (!existsSync(byConvention)) return undefined
	const workflow = await loadWorkflowFile(byConvention).catch(() => undefined)
	return workflow?.name === arg ? { ok: true, workflow, filePath: byConvention } : undefined
}

/** Fall back to a full catalog scan, matching `arg` against every discovered workflow's declared name. */
async function resolveByCatalogName(projectRoot: string, arg: string): Promise<WorkflowResolution> {
	const { entries } = await discoverWorkflows(projectRoot)
	const matches = entries.filter((entry) => entry.name === arg)

	if (matches.length === 1) {
		const match = matches[0] as WorkflowEntry
		return loadAsResolution(match.filePath, match.filePath)
	}
	if (matches.length > 1) {
		return { ok: false, error: `"${arg}" is ambiguous: ${matches.map((entry) => entry.filePath).join(", ")}` }
	}

	const known = entries.map((entry) => entry.name)
	const hint =
		known.length > 0 ? ` Known workflows: ${known.join(", ")}.` : ` No workflows found in ${workflowsDir(projectRoot)}.`
	return { ok: false, error: `no workflow named "${arg}" (and no such file).${hint}` }
}
