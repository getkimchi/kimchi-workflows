/**
 * Fresh-run entry point for the deterministic engine (spec §4). Validates the workflow's optional
 * top-level input, emits `run-started`, then delegates to the shared step loop.
 *
 * Zero imports from PI, `node:fs`, or any network lib — see src/engine/types.ts.
 */
import type { WorkflowDefinition } from "../flow/types.ts";
import { describeSchemaViolations } from "../flow/validation.ts";
import { iso } from "./context.ts";
import { execute } from "./execute.ts";
import type { HostPort, RunOptions, RunResult } from "./types.ts";

export async function runWorkflow(workflow: WorkflowDefinition, initialInput: unknown, host: HostPort, options: RunOptions = {}): Promise<RunResult> {
  const runId = host.generateRunId();

  if (workflow.inputSchema) {
    const violation = describeSchemaViolations(workflow.inputSchema, initialInput);
    if (violation) {
      const error = `workflow "${workflow.name}" input: ${violation}`;
      await host.emit({ type: "run-crashed", runId, error, at: iso(host) });
      return { runId, status: "crashed", error };
    }
  }

  await host.emit({ type: "run-started", runId, workflowName: workflow.name, input: initialInput, at: iso(host) });

  return execute(workflow, host, { runId, initialInput, stepOutputs: new Map(), previousOutput: initialInput, startIndex: 0 }, options.signal);
}
