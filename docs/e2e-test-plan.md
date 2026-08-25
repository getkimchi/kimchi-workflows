# End-to-End Test Plan: Workflow Extension Lifecycle

## Overview

Seven scripted (no model) end-to-end scenarios that exercise the full workflow extension lifecycle: authoring, validation, package preparation, run, interactive blocking, cancellation, resume, and discovery. They test the extension machinery — not LLM generation — and run in the unit suite.

## Test infrastructure

| Helper | Source | Purpose |
|---|---|---|
| `createTestHost` | `test/helpers.ts` | In-memory store + host port; no PI, no filesystem |
| `createFsStore` | `src/host/fs-store.ts` | Filesystem-backed store; needed for durability/resume-across-restart tests |
| `prepareWorkflowPackageFixture` | `test/workflow-package-fixture.ts` | Offline package fixture (symlinks repo + node_modules; no pnpm) |
| `scriptedSubagent` | `test/fake-subagent.ts` | Scripted agent responses for agent steps |
| `handleRun` / `handleResume` | `src/host/commands/` | Command handlers under test |
| `resolveWorkflow` / `discoverWorkflows` | `src/host/workflow-catalog.ts` | Resolution and discovery under test |

## Scenarios

### 1. Author, validate, and run a simple workflow

**Exercises:** file-based workflow loading, static validation (typecheck), package preparation, run-to-completion.

**Setup:**

- Temp project root with `prepareWorkflowPackageFixture({ directory: workflowsDir(root) })`.
- Write `greet.workflow.ts` — a function-only workflow: `createWorkflow({ name: "greet" }).then(createStep({ name: "say", run: () => ({ message: "hello" }) })).commit()`.

**Steps:**

1. `resolveWorkflow(root, "greet")` — resolves by convention.
2. Assert resolution succeeds; `workflow.name === "greet"`.
3. `handleRun(ctx, store, activeRuns, startAgent, "greet")`.
4. Assert run completes (`result.status === "completed"`).
5. Assert `result.output.message === "hello"`.

**Key assertion:** the workflow was typechecked against the prepared package (no `FRAMEWORK_ROOT` fallback) and loaded via jiti virtual modules, then executed to completion.

---

### 2. Questionnaire blocks, exits, and resumes

**Exercises:** interactive step, blocked-state persistence, resume restoration of the questionnaire.

**Setup:**

- Use `createFsStore` (filesystem, not memory) — the host is destroyed and rebuilt.
- Write `ask.workflow.ts` — a workflow with one `createInteractiveStep` that builds a questionnaire (single-select: "yes" / "no").
- `prepareWorkflowPackageFixture` for validation.

**Steps:**

1. `handleRun` — workflow blocks on the interactive step (`result.status === "blocked"`).
2. Assert a questionnaire is pending (`humanInputOf(result)` is defined).
3. **Destroy the host** — drop the `TestHost` reference; no in-memory state survives.
4. Rebuild: new `createFsStore(runDir)` + new `createHostPort` from the same directory.
5. `handleResume(ctx, store, activeRuns, startAgent, runId)`.
6. Assert the questionnaire is presented again — the run is still blocked, waiting for the same answer.
7. Answer the questionnaire; assert run completes.

**Key assertion:** the blocked state (including the pending questionnaire) is fully reconstructed from the event log, not from in-memory host state.

---

### 3. Run a workflow from an external file path

**Exercises:** explicit-path resolution, validation against the central project package (not the file's own location).

**Setup:**

- Temp project root with `prepareWorkflowPackageFixture({ directory: workflowsDir(root) })`.
- Write the workflow **outside** `.kimchi/workflows` — e.g. `<root>/scripts/external.workflow.ts`.
- The workflow imports `@kimchi-dev/kimchi-workflows` and `typebox` (framework declarations come from the central package).

**Steps:**

1. `resolveWorkflow(root, "scripts/external.workflow.ts")` — path resolution, not name.
2. Assert resolution succeeds.
3. `handleRun(ctx, store, activeRuns, startAgent, path.relative(root, externalPath))`.
4. Assert run completes.

**Key assertion:** a workflow outside `.kimchi/workflows` validates and runs against the central project package's framework declarations — not by walking up to find a `package.json` at the file's location.

---

### 4. Cancel a running workflow and confirm it is resumable

**Exercises:** cancellation, run-lease release, resumability from cancelled state.

**Setup:**

- Use `createFsStore`.
- Write `slow.workflow.ts` — a workflow with one step that calls `host.sleep(60_000)` (or an agent step driven by `scriptedSubagent` that never exits on its own).
- `prepareWorkflowPackageFixture`.

**Steps:**

1. `handleRun` — start the workflow (it will be in-flight in the sleep/agent step).
2. Cancel the run: `handleCancel(ctx, store, activeRuns, runId)` (or equivalent lifecycle command).
3. Assert the run status is `"cancelled"`.
4. Assert the run-lease is released (`activeRuns.find(runId)` is empty).
5. `handleResume(ctx, store, activeRuns, startAgent, runId)` — the run resumes from its last checkpoint.
6. Assert it either completes or blocks (depending on workflow design).

**Key assertion:** cancellation stops execution cleanly, releases the execution lease, and leaves the run in a resumable state — not a dead end.

---

### 5. External file with a relative helper import

**Exercises:** relative import resolution from the authored location, not the central package.

**Setup:**

- Temp project root with `prepareWorkflowPackageFixture`.
- Write `<root>/scripts/external.workflow.ts` that imports `./helper.ts`.
- Write `<root>/scripts/helper.ts` exporting a `createStep`.
- The workflow uses the imported step.

**Steps:**

1. `resolveWorkflow(root, "scripts/external.workflow.ts")`.
2. Assert resolution succeeds (typecheck follows the relative import).
3. `handleRun` — assert run completes; the helper step executed.

**Key assertion:** the workflow's relative imports resolve from the file's own directory (`scripts/`), not from `.kimchi/workflows/` — the central package provides framework declarations only, not the workflow's own source tree.

---

### 6. Foreach/map data flow

**Exercises:** `.map` and `.foreach` control flow, non-adjacent data handoff, step-session spawning.

**Setup:**

- Temp project root with `prepareWorkflowPackageFixture`.
- Write `pipeline.workflow.ts` — modeled on `examples/pipeline.workflow.ts`: a workflow that maps over an array (e.g. `["a", "b", "c"]`), processes each item through a step, and hands the collected results to a non-adjacent summary step.
- If the map/foreach steps are agent steps, use `scriptedSubagent` to return deterministic output.

**Steps:**

1. `resolveWorkflow` + `handleRun`.
2. Assert run completes.
3. Assert the summary step received all mapped results (e.g. `result.output.summary` contains data from all three items).

**Key assertion:** data flows correctly through `.map`/`.foreach` to a downstream step that is not the immediate successor — the engine's core data-handoff guarantee.

---

### 7. Broken workflow surfaces in listing without crashing

**Exercises:** discovery resilience, `broken` catalog reporting.

**Setup:**

- Temp project root with `prepareWorkflowPackageFixture`.
- Write a valid `good.workflow.ts`.
- Write a broken `bad.workflow.ts` — e.g. `export default const nope = ;` (syntax error) or `throw new Error("boom")` (runtime error at import).

**Steps:**

1. `discoverWorkflows(root)`.
2. Assert `catalog.entries` contains the good workflow with correct name.
3. Assert `catalog.broken` contains the bad workflow with its file path and an error string.
4. Assert discovery did NOT throw — one broken file doesn't prevent listing the rest.
5. `resolveWorkflow(root, "good")` — assert it still resolves and runs.

**Key assertion:** a broken workflow file is reported, not silently skipped or fatal — discovery is resilient, and valid workflows alongside it remain runnable.

---

## Out of scope

- **Model-driven workflow generation** (`/workflow create` with an LLM) — already covered by `test/create-workflow.integration.test.ts`.
- **Control-flow convergence** (review loops, `.dountil`) — already covered by `test/review-loop.integration.test.ts`.
- **Bundled-binary execution** — Phase 4/5 scope; requires a compiled Kimchi binary.
- **Upgrade/coexistence safety** — Phase 6 scope.
