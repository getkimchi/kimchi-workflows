# Example workflows

Each file default-exports a committed `WorkflowDefinition`. Run one from the PI harness with:

```
/workflow run examples/<name>.workflow.ts
```

Agent/Q&A examples need a model (pinned examples use `kimchi-dev/kimi-k2.7`; `local-code-review` uses the active session model); the function-only and
questionnaire/interactive examples run with no network.

| Example | Kind | What it shows | Run |
| --- | --- | --- | --- |
| `hello` | function | A single function step with a TypeBox output (the tracer bullet). | `/workflow run examples/hello.workflow.ts` |
| `pipeline` | function | Linear hand-off (`parse → count`) plus a non-adjacent `.map()` that reaches back to an earlier step. | `/workflow run examples/pipeline.workflow.ts` |
| `batch` | function | A sequential `.foreach()` over a list (item-as-input; ordered array output). | `/workflow run examples/batch.workflow.ts` |
| `fan-out` | function | `.parallel()` fan-out over two independent steps sharing the same input; output keyed by arm name. | `/workflow run examples/fan-out.workflow.ts` |
| `foreach-concurrent` | function | A `.foreach()` with `concurrency: 3` (item-as-input; output ordered by item, not completion). | `/workflow run examples/foreach-concurrent.workflow.ts` |
| `survey` | questionnaire | A questionnaire step gathers structured input up front, then a later step consumes it. | `/workflow run examples/survey.workflow.ts` |
| `approval` | interactive | Persist Markdown, render it through PI, and collect a resumable approve/revise response. | `/workflow run examples/approval.workflow.ts` |
| `summarize` | agent | A single agent step returning schema-valid structured output (`{ summary, keywords }`). | `/workflow run examples/summarize.workflow.ts` |
| `review-loop` | agent + loop | An agent proposes a slug, a function check evaluates it, `.dountil` it passes (max-iteration guard). | `/workflow run examples/review-loop.workflow.ts` |
| `planning` | Q&A agent | A planning agent that may ask a clarifying question (parks), then plans on the answer. | `/workflow run examples/planning.workflow.ts` |
| `code-review` | agent + parallel + filesystem | A review graph with intent inference, parallel specialists, synthesis, and report persistence. | `/workflow run examples/code-review.workflow.ts` |
| `local-code-review` | Git + agent | A single-pass Kimchi review of the current branch against its default base, including staged, unstaged, and untracked files. Set `KIMCHI_REVIEW_BASE_REF` for a non-default MR target. | `/workflow run examples/local-code-review.workflow.ts` |
| `kimchi-bug-investigation` | questionnaire + agent + filesystem | A guided evidence and source investigation that writes a bug report. | `/workflow run examples/kimchi-bug-investigation.workflow.ts` |
| `external-dependency` | function + dependency | A workflow importing `slugify` from the shared examples package. | `/workflow run examples/external-dependency.workflow.ts` |

`local-code-review` needs no MR or GitLab login. It compares the current working tree to the merge base with the
locally available `origin/HEAD` (falling back to `origin/master`, `origin/main`, `master`, or `main`). Set
`KIMCHI_REVIEW_BASE_REF` to a locally available target ref if the MR targets a different branch. It does not fetch,
run tests, or modify source files.

## Tests

- **Offline** (`pnpm run test:examples` from the repository root): the shared `examples/` package runs every example
  end-to-end through the engine. Agent responses and side-effectful steps are schema-checked test doubles, so this
  suite needs no model credentials and does not touch Git or write reports.
- **Live** (`pnpm run test:integration`, gated on `KIMCHI_API_KEY`): `summarize`, `review-loop`, and `planning` also
  run against `kimchi-dev/kimi-k2.7`.
