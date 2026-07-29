// The namespace imports below are the payload handed to jiti's `virtualModules` (see
// `workflowModules`): it wants whole module objects, which is precisely what a namespace import is.
// biome-ignore-all lint/performance/noNamespaceImport: virtualModules takes module objects, not bindings

import { createJiti } from "jiti"
import * as typebox from "typebox"
import * as typeboxCompile from "typebox/compile"
import * as typeboxValue from "typebox/value"
import * as engine from "../engine/index.ts"
import * as flow from "../flow/index.ts"
import type { WorkflowDefinition } from "../flow/types.ts"

/**
 * What an authored workflow may import without the project installing anything.
 *
 * A workflow file is loaded from the *project's* directory, and Node resolves its bare imports from
 * there — not from wherever this engine happens to live. So `import { Type } from "typebox"` in
 * `<project>/.<app>/workflows/foo.workflow.ts` fails unless that project has its own `node_modules`,
 * which is a strange thing to demand of a repo whose only crime is wanting a workflow.
 *
 * PI solves the identical problem for extensions the same way (its loader maps `typebox` & friends to
 * the copies it bundles), and we pass MODULES rather than paths for two reasons:
 *
 *  - in a compiled Bun binary — how the harness actually ships — PI's typebox exists only as a virtual
 *    module. There is no file on disk to point an alias at, so `require.resolve("typebox")` has
 *    nothing to find and a path-based alias would be unbuildable.
 *  - it guarantees ONE instance. The workflow's `Type.Object(...)` and the engine's `Value.Check(...)`
 *    are then provably the same typebox, and the workflow's `@getkimchi/kimchi-workflows` is the very module
 *    object running the engine — not a second copy that node resolution happened to find.
 *
 * The modules we hand out are whatever OUR imports above resolved to, so under the harness a workflow
 * transitively gets PI's bundled typebox — the same one the engine is validating against.
 *
 * The keys are exactly the package's published names, no more: the bare package (the authoring API),
 * `/flow` naming that same module, and `/engine` for the run-shaped types a workflow can legitimately
 * reach for. Both already sit in this process's module graph, so exposing them costs nothing. `/host`
 * and `/testing` are deliberately absent: a workflow driving its own host would invert the layering,
 * and a project's tests for its workflows run under its own test runner, never through this loader.
 *
 * Nothing here may name a directory (`…/src/flow`). What resolves under this loader must also resolve
 * after a real `npm install`, and the `exports` map publishes names, not layout.
 *
 * Node built-ins (`node:fs`, `node:path`, …) need no entry here; jiti resolves them natively.
 */
const workflowModules = {
	typebox,
	"typebox/value": typeboxValue,
	"typebox/compile": typeboxCompile,
	"@getkimchi/kimchi-workflows": flow,
	"@getkimchi/kimchi-workflows/flow": flow,
	"@getkimchi/kimchi-workflows/engine": engine,
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { name?: unknown }).name === "string" &&
		Array.isArray((value as { nodes?: unknown }).nodes)
	)
}

/**
 * Load a workflow `.ts` file at runtime (spec §1.4: "loaded via PI's existing TypeScript
 * loader ... on `/workflow run`"). Uses `jiti` — the same TS-loading approach PI's own CLI
 * depends on — so no separate build step is required for workflow authors.
 *
 * A fresh jiti per call, deliberately: its module cache is per-instance, so a workflow edited between
 * two runs of the same session is re-read rather than served stale.
 *
 * Accepts either `export default workflow` or `export const workflow = ...`.
 */
export async function loadWorkflowFile(absolutePath: string): Promise<WorkflowDefinition> {
	const jiti = createJiti(import.meta.url, { virtualModules: workflowModules })
	const moduleExports = (await jiti.import(absolutePath)) as Record<string, unknown>

	const candidate = moduleExports.default ?? moduleExports.workflow
	if (!isWorkflowDefinition(candidate)) {
		throw new Error(
			`"${absolutePath}" does not export a workflow (expected a default export or a "workflow" named export from createWorkflow(...).commit())`,
		)
	}
	return candidate
}
