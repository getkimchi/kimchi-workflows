import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const external = createStep({
	name: "external-step",
	output: Type.Object({ source: Type.Literal("external") }),
	run: () => ({ source: "external" as const }),
})

export default createWorkflow({ name: "external" }).then(external).commit()
