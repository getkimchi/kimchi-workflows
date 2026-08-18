# Plan: Lock-Free Workflow Execution

> Source PRD: Conversation decision to allow all workflow runs, including runs of the same workflow, to execute concurrently without project or workflow locks.

## Architectural decisions

- **Execution policy**: The host imposes no project-, workflow-, or run-level exclusivity rule.
- **Persistence**: Runs continue to use independent JSONL event logs keyed by run ID; no database or shared scheduler is introduced.
- **Cancellation**: An in-process registry retains abort controllers for locally executing runs but never rejects an execution.
- **Concurrency ownership**: Workflow authors are responsible for coordinating shared files, branches, and external resources.
- **Recovery**: There is no stale-lock reclaim path; a process cannot infer or rewrite another process's abandoned run while starting unrelated work.

---

## Phase 1: Lock-Free Workflow Execution

**User stories**: As a workflow author, I can run multiple instances of any workflows concurrently; as an operator, I can still identify, inspect, and cancel locally executing runs.

### What to build

Remove exclusive execution locking from the workflow host while retaining non-exclusive lifecycle observation for cancellation, progress, and telemetry. Update the command behavior and specification so concurrent runs are accepted and resource conflicts are explicitly the workflow author's responsibility.

### Acceptance criteria

- [x] Starting or resuming a run is never rejected because another run is executing.
- [x] Multiple instances of the same workflow may execute concurrently.
- [x] Each run continues writing to its own event log.
- [x] Locally executing runs remain cancellable by run ID.
- [x] Bare cancellation is accepted only when it identifies a single local execution or a single blocked run.
- [x] No project lock file is created or reclaimed.
- [x] Specifications and tests describe and verify unrestricted run concurrency.
