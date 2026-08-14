import { GENERATED_AUTHORING_REFERENCE } from "./generated/authoring-reference.ts"

const GUIDE_URL = "https://github.com/getkimchi/kimchi-workflows/blob/master/docs/authoring.md"
const TESTING_URL = "https://github.com/getkimchi/kimchi-workflows/blob/master/docs/testing.md"
const DEPENDENCIES_URL = "https://github.com/getkimchi/kimchi-workflows/blob/master/docs/dependencies.md"

const QUICK_REFERENCE_SYMBOLS = new Set([
	"createWorkflow",
	"WorkflowBuilder.then",
	"WorkflowBuilder.map",
	"WorkflowBuilder.branch",
	"WorkflowBuilder.dowhile",
	"WorkflowBuilder.dountil",
	"WorkflowBuilder.foreach",
	"WorkflowBuilder.parallel",
	"WorkflowBuilder.workflow",
	"WorkflowBuilder.commit",
	"createStep",
	"createAgentStep",
	"createQuestionnaireStep",
	"createInteractiveStep",
	"RunContext.getStepResult",
	"RunContext.getInitData",
	"RunContext.scope",
])

/** Compact, version-matched API help for the implementation agent. */
export function renderAuthoringGuidance(): string {
	const signatures = Object.values(GENERATED_AUTHORING_REFERENCE)
		.flat()
		.filter((entry) => QUICK_REFERENCE_SYMBOLS.has(entry.symbol))
		.map((entry) => `- ${entry.signature}`)

	return `WORKFLOW AUTHORING REFERENCE

Use this embedded, version-matched reference first. Do not search old Git branches, obsolete package names,
registry tarballs, or private source paths. For deeper explanations and examples, consult:
- Authoring: ${GUIDE_URL}
- Testing: ${TESTING_URL}
- Dependencies: ${DEPENDENCIES_URL}

Execution semantics:
- createStep runs deterministic TypeScript. createAgentStep runs the harness agent tool loop.
- Agent steps can use registered harness tools in either execution mode. Foreground shares the current session;
  background: true requests an isolated subprocess and context window.
- A reporting agent declares output and completes through workflow_submit_result. An acting agent whose product is side
  effects may omit output.
- Adjacent nodes exchange the previous output through the next input schema. Logical plan stages do not need to
  map one-to-one to agent steps; prefer bounded structured hand-offs over raw webpages or command output.

Public API signatures:
${signatures.join("\n")}

Focused tests import createTestRun and agent helpers from @kimchi-dev/kimchi-workflows/testing. Stub agent/network
work and keep deterministic local steps real.`
}
