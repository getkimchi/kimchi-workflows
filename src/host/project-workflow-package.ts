import { workflowsDir } from "./project-dir.ts"
import {
	prepareWorkflowPackage,
	type WorkflowPackageInstaller,
	type WorkflowPackagePreparation,
} from "./workflow-package.ts"

/** Prepare the central package used by every authored workflow in a project. */
export function prepareProjectWorkflowPackage(options: {
	readonly projectRoot: string
	readonly signal?: AbortSignal
	/** Test seam forwarded to {@link prepareWorkflowPackage}. */
	readonly install?: WorkflowPackageInstaller
}): Promise<WorkflowPackagePreparation> {
	return prepareWorkflowPackage({
		directory: workflowsDir(options.projectRoot),
		signal: options.signal,
		install: options.install,
	})
}
