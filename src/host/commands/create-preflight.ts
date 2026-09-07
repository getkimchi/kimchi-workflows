import { resolveWorkflowPackageManager } from "../workflow-package-manager.ts"
import { type CommandCtx, describe } from "./context.ts"

/** Ensure workflow creation can reach package installation and verification before spending model tokens. */
export async function preflightCreateWorkflow(ctx: CommandCtx): Promise<boolean> {
	ctx.ui.setWorkingMessage("workflow: preparing package manager")
	try {
		await resolveWorkflowPackageManager()
		return true
	} catch (error) {
		ctx.ui.notify(`workflow: could not prepare to create a workflow: ${describe(error)}`, "error")
		return false
	} finally {
		ctx.ui.setWorkingMessage()
	}
}
