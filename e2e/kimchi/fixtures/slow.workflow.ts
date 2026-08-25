import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const slow = createStep({
	name: "slow-step",
	output: Type.Object({ resumed: Type.Boolean() }),
	run: async ({ abortSignal }) => {
		const marker = path.join(process.cwd(), ".slow-first-attempt")
		if (existsSync(marker)) return { resumed: true }
		writeFileSync(marker, "started\n", "utf8")
		return await new Promise<never>((_resolve, reject) => {
			const abort = () => reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("cancelled"))
			if (abortSignal.aborted) abort()
			else abortSignal.addEventListener("abort", abort, { once: true })
		})
	},
})

export default createWorkflow({ name: "slow" }).then(slow).commit()
