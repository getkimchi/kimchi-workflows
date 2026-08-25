import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const say = createStep({
	name: "say",
	output: Type.Object({ message: Type.String() }),
	run: () => ({ message: "hello" }),
})

export default createWorkflow({ name: "greet" }).then(say).commit()
