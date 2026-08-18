/** Resolve workflow definitions recorded in run provenance. */

import { fileURLToPath } from "node:url"
import type { RunEvent, RunMetaEvent, WorkflowSource } from "../engine/types.ts"
import type { WorkflowDefinition } from "../flow/types.ts"
import createWorkflowWorkflow from "./builtin/create.workflow.ts"
import { loadWorkflowFile } from "./load-workflow.ts"
import { loadValidatedWorkflow, type WorkflowPreflightResult } from "./workflow-preflight.ts"

export { workflowSourceLabel } from "./workflow-source.ts"

/**
 * The old package-owned source path persisted before run provenance gained an explicit built-in ID.
 * New runs never record this path; it exists only to keep already-recorded create runs readable.
 */
const LEGACY_BUILTIN_CREATE_WORKFLOW_FILE = fileURLToPath(
	new URL("../../src/host/builtin/create.workflow.ts", import.meta.url),
)
const LEGACY_COMPILED_CREATE_WORKFLOW_FILE = fileURLToPath(
	new URL("../../dist/host/builtin/create.workflow.ts", import.meta.url),
)
const LEGACY_CREATE_WORKFLOW_FILES = new Set([
	LEGACY_BUILTIN_CREATE_WORKFLOW_FILE,
	LEGACY_COMPILED_CREATE_WORKFLOW_FILE,
])

/** The package-owned registration used by `/workflow create`; definition and provenance cannot drift apart. */
export const BUILTIN_CREATE_WORKFLOW = {
	source: { kind: "builtin", id: "create" } as const satisfies WorkflowSource,
	workflow: createWorkflowWorkflow,
}

const BUILTIN_WORKFLOWS: Readonly<Record<string, WorkflowDefinition>> = {
	[BUILTIN_CREATE_WORKFLOW.source.id]: BUILTIN_CREATE_WORKFLOW.workflow,
}

/** Read new provenance, translating the exact legacy create path into the package-owned built-in ID. */
export function workflowSourceOf(events: readonly RunEvent[]): WorkflowSource | undefined {
	const meta = events.find((event): event is RunMetaEvent => event.type === "run-meta")
	if (!meta) return undefined
	if (Object.hasOwn(meta, "workflowSource")) {
		const source: unknown = meta.workflowSource
		return isWorkflowSource(source) ? source : undefined
	}
	const legacyPath: unknown = meta.workflowFilePath
	if (typeof legacyPath !== "string" || !legacyPath) return undefined
	return LEGACY_CREATE_WORKFLOW_FILES.has(legacyPath)
		? BUILTIN_CREATE_WORKFLOW.source
		: { kind: "file", path: legacyPath }
}

/**
 * Package-owned built-ins are trusted definitions already imported by the extension. Project-authored
 * definitions retain the TypeScript-before-evaluation preflight that protects against edited source.
 * Explicit registry IDs keep trust independent of workflow names; exact paths are recognized only for legacy logs.
 */
export function loadRecordedWorkflow(options: {
	readonly source: WorkflowSource
	readonly projectRoot: string
}): Promise<WorkflowPreflightResult> {
	if (options.source.kind === "builtin") return Promise.resolve(resolveBuiltin(options.source.id))
	return loadValidatedWorkflow({ filePath: options.source.path, projectRoot: options.projectRoot })
}

/** Reload between attended turns while preserving each source kind's existing runtime behavior. */
export async function reloadRecordedWorkflow(source: WorkflowSource): Promise<WorkflowDefinition> {
	if (source.kind === "builtin") {
		const loaded = resolveBuiltin(source.id)
		if (!loaded.ok) throw new Error(loaded.cause)
		return loaded.workflow
	}
	return loadWorkflowFile(source.path)
}

function resolveBuiltin(id: string): WorkflowPreflightResult {
	const workflow = BUILTIN_WORKFLOWS[id]
	return workflow
		? { ok: true, workflow }
		: { ok: false, cause: `package-owned workflow "${id}" is not registered in this build` }
}

function isWorkflowSource(value: unknown): value is WorkflowSource {
	if (!value || typeof value !== "object") return false
	const source = value as { readonly kind?: unknown; readonly id?: unknown; readonly path?: unknown }
	return (
		(source.kind === "builtin" && typeof source.id === "string" && source.id.length > 0) ||
		(source.kind === "file" && typeof source.path === "string" && source.path.length > 0)
	)
}
