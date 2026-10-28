/**
 * Workflow catalog: discover the workflows a project defines, and resolve a command argument to one.
 *
 * Authored workflows live in two layers (spec §6.8): the project's `<projectRoot>/.<app>/workflows/`
 * and the user's global `<agentDir>/workflows/`. The project layer is authoritative — a global file
 * whose installed identity collides with a project file is shadowed and cannot be selected by
 * identity — while broken files are reported from BOTH layers rather than silently skipped. Both
 * layers follow the harness convention for project resources (`extensions/`, `skills/`, `prompts/`
 * under the same directory). These are SOURCE directories: run logs and step sessions live in the
 * harness's session directory (project-dir.ts's `runArtifactsDir`).
 *
 * Installed identity comes from the filename, so completion and run lookup need only read the
 * directories. Listing still imports candidates for descriptions and broken-file diagnostics. Run
 * resolution validates and evaluates only the exact selected file.
 */
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { WorkflowDefinition } from "../flow/types.ts"
import { loadWorkflowFile, WORKFLOW_SUFFIX } from "./load-workflow.ts"
import { globalWorkflowsDir, workflowsDir } from "./project-dir.ts"
import { loadValidatedWorkflow } from "./workflow-preflight.ts"
import { bindWorkflowFileIdentity, workflowFileIdentity } from "./workflow-source.ts"

export { WORKFLOW_SUFFIX } from "./load-workflow.ts"

/** Which catalog layer a discovered workflow was installed in (spec §6.8). */
export type WorkflowScope = "project" | "global"

/** A discovered workflow: its installed identity plus metadata loaded for catalog views. */
export interface WorkflowEntry {
	/** The source filename without `.workflow.ts`; canonical for completion, lookup, and new runs. */
	readonly identity: string
	/** The definition's authored name. Retained as definition metadata; it is not a command selector. */
	readonly name: string
	readonly description?: string
	readonly filePath: string
	/** Which layer installed this file: the project's own catalog, or the user's global directory. */
	readonly scope: WorkflowScope
}

/** A file in a workflows directory that failed to load — surfaced rather than silently skipped. */
export interface BrokenWorkflow {
	readonly filePath: string
	readonly error: string
}

export interface WorkflowCatalog {
	readonly entries: readonly WorkflowEntry[]
	readonly broken: readonly BrokenWorkflow[]
}

type WorkflowLoader = (filePath: string) => Promise<WorkflowDefinition>

/**
 * Cheap, load-free enumeration used by completion and missing-workflow diagnostics. Merged across
 * both layers and deduped by identity, so a suggestion always names a file the command will load.
 */
export async function listWorkflowIdentities(
	projectRoot: string,
	globalDir: string = globalWorkflowsDir(),
): Promise<readonly string[]> {
	const [project, global] = await Promise.all([workflowFiles(workflowsDir(projectRoot)), workflowFiles(globalDir)])
	const identities = new Set<string>()
	for (const file of [...project, ...global]) identities.add(workflowFileIdentity(file))
	return [...identities].sort((a, b) => a.localeCompare(b))
}

/**
 * Load every workflow the project and the user's global directory define, sorted by name; the
 * project's file shadows a same-identity global one. A file that throws is reported in `broken`
 * instead of failing the whole catalog — one unparseable workflow must not make `/workflow list`
 * useless. A missing directory is simply an empty layer.
 */
export async function discoverWorkflows(
	projectRoot: string,
	globalDir: string = globalWorkflowsDir(),
): Promise<WorkflowCatalog> {
	return scanWorkflows(projectRoot, globalDir, loadWorkflowFile)
}

async function scanWorkflows(projectRoot: string, globalDir: string, load: WorkflowLoader): Promise<WorkflowCatalog> {
	const [project, global] = await Promise.all([
		scanWorkflowDir(workflowsDir(projectRoot), "project", load),
		scanWorkflowDir(globalDir, "global", load),
	])
	// Project wins (spec §6.8's precedence): a shadowed global file cannot be selected by identity.
	const shadowed = new Set(project.entries.map((entry) => entry.identity))
	return {
		entries: [...project.entries, ...global.entries.filter((entry) => !shadowed.has(entry.identity))].sort((a, b) =>
			a.identity.localeCompare(b.identity),
		),
		// Broken files are never hidden, whatever layer they live in — even a shadowed one: a user
		// keeping a broken copy in both layers still needs to hear about both.
		broken: [...project.broken, ...global.broken],
	}
}

async function scanWorkflowDir(dir: string, scope: WorkflowScope, load: WorkflowLoader) {
	const entries: WorkflowEntry[] = []
	const broken: BrokenWorkflow[] = []

	for (const filePath of await workflowFiles(dir)) {
		try {
			const workflow = await load(filePath)
			entries.push({
				identity: workflowFileIdentity(filePath),
				name: workflow.name,
				description: workflow.description,
				filePath,
				scope,
			})
		} catch (err) {
			broken.push({ filePath, error: err instanceof Error ? err.message : String(err) })
		}
	}

	return { entries, broken }
}

async function workflowFiles(dir: string): Promise<string[]> {
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
 * loaded once, and its root runtime name is bound to the filename-derived identity. Identity lookup
 * checks the project layer first, then the global one — a project file always wins (spec §6.8).
 */
export async function resolveWorkflow(
	projectRoot: string,
	arg: string,
	globalDir: string = globalWorkflowsDir(),
): Promise<WorkflowResolution> {
	const load = validatedLoader(projectRoot)
	if (arg.endsWith(".ts")) {
		const filePath = path.resolve(projectRoot, arg)
		if (!existsSync(filePath)) return { ok: false, error: `workflow: file does not exist\n  ${filePath}` }
		return loadAsResolution(filePath, arg, load)
	}

	const filePath = path.join(workflowsDir(projectRoot), `${arg}${WORKFLOW_SUFFIX}`)
	if (existsSync(filePath)) return loadAsResolution(filePath, arg, load)
	const globalFilePath = path.join(globalDir, `${arg}${WORKFLOW_SUFFIX}`)
	if (existsSync(globalFilePath)) return loadAsResolution(globalFilePath, arg, load)

	const known = await listWorkflowIdentities(projectRoot, globalDir)
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
