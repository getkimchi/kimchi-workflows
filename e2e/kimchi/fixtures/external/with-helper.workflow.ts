import { createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { helperStep } from "./helper.ts"

export default createWorkflow({ name: "with-helper" }).then(helperStep).commit()
