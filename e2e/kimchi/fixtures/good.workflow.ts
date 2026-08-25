import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const good = createStep({
	name: "good-step",
	output: Type.Object({ good: Type.Boolean() }),
	run: () => ({ good: true }),
})

export default createWorkflow({ name: "good", description: "Still runnable beside a broken file" }).then(good).commit()
