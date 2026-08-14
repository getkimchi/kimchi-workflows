# Authoring workflows

Workflows are ordinary TypeScript modules that default-export a committed `WorkflowDefinition`. Put project
workflows in `.kimchi/workflows/*.workflow.ts`, or pass a workflow file directly to `/workflow run`.

```ts
import { Type } from "typebox"
import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"

const greet = createStep({
	name: "greet",
	output: Type.Object({ message: Type.String() }),
	run: () => ({ message: "Hello" }),
})

export default createWorkflow({ name: "hello" }).then(greet).commit()
```

## Choose the smallest suitable step

- `createStep` runs deterministic TypeScript. Use it for formatting, validation, file or API clients, and other
  behavior that does not require a model.
- `createAgentStep` runs the harness agent loop. Declare `output` when later steps consume structured data; the
  agent then completes through `workflow_submit_result`. Omit `output` when the step's product is its side effects.
- `createQuestionnaireStep` deterministically collects schema-shaped user input.
- `createInteractiveStep` is for a custom resumable host interaction.

Agent steps can use the harness's registered tools in either execution mode. By default an agent step shares the
current session. `background: true` gives it an isolated subprocess and context window; use the mode whose context
and lifecycle fit the work rather than treating background execution as a tool-access switch.

## Data flow

An adjacent node receives the previous node's output. Declare an `input` schema when that boundary benefits from
validation. For non-adjacent data, use `ctx.getStepResult(name)`; use `ctx.getInitData()` for workflow input and
`ctx.scope()` for the surrounding branch, loop, foreach, parallel, or nested-workflow frame.

Logical stages in a behavioral plan do not have to become separate model calls. If one agent can gather and reduce
external information safely, prefer one bounded structured result over handing an entire webpage or command log to
another agent.

## Control flow

The builder supports linear `.then()`, pure `.map()`, `.branch()`, guarded `.dowhile()` and `.dountil()` loops,
`.foreach()`, `.parallel()`, and nested `.workflow()` nodes. Control flow is engine-owned and deterministic; models
do work inside agent steps but do not decide transitions.

See the [generated API reference](api-reference.md) for exact signatures and invariants, and the
[examples](../examples/README.md) for one focused workflow per construct.

## Keep modules safe to import

Workflow discovery imports workflow modules. Define schemas and steps at module scope, commit the workflow, and
export it; do not perform filesystem, network, or process work during import. Put effects inside step callbacks.

## Verification

`/workflow create` first prepares `.kimchi/workflows` as a private pnpm package with a lockfile and verification
toolchain. The framework then loads the workflow through the real Jiti runtime and asks that package to type-check
the entry and execute one submitted Vitest file. Add third-party imports to this package so authoring,
verification, and runtime module lookup agree. See [Testing](testing.md) and [Dependencies](dependencies.md).
