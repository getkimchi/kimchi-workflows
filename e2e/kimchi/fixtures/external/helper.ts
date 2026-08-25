import { createStep } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

export const helperStep = createStep({
	name: "relative-helper",
	output: Type.Object({ helper: Type.Literal("relative-ok") }),
	run: () => ({ helper: "relative-ok" as const }),
})
