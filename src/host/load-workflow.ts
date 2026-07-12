import { createJiti } from "jiti";
import type { WorkflowDefinition } from "../flow/types.ts";

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

/**
 * Load a workflow `.ts` file at runtime (spec §1.4: "loaded via PI's existing TypeScript
 * loader ... on `/workflow run`"). Uses `jiti` — the same TS-loading approach PI's own CLI
 * depends on — so no separate build step is required for workflow authors.
 *
 * Accepts either `export default workflow` or `export const workflow = ...`.
 */
export async function loadWorkflowFile(absolutePath: string): Promise<WorkflowDefinition> {
  const jiti = createJiti(import.meta.url);
  const moduleExports = (await jiti.import(absolutePath)) as Record<string, unknown>;

  const candidate = moduleExports.default ?? moduleExports.workflow;
  if (!isWorkflowDefinition(candidate)) {
    throw new Error(
      `"${absolutePath}" does not export a workflow (expected a default export or a "workflow" named export from createWorkflow(...).commit())`,
    );
  }
  return candidate;
}
