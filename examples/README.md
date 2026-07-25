# Example workflows

Each file default-exports a committed `WorkflowDefinition`. Run one from the PI harness with:

```
/workflow run examples/<name>.workflow.ts
```

Agent/Q&A examples need a model (they use `kimchi-dev/kimi-k2.7`); the function-only and
questionnaire examples run with no network.

| Example | Kind | What it shows | Run |
| --- | --- | --- | --- |
| `hello` | function | A single function step with a TypeBox output (the tracer bullet). | `/workflow run examples/hello.workflow.ts` |
| `pipeline` | function | Linear hand-off (`parse → count`) plus a non-adjacent `.map()` that reaches back to an earlier step. | `/workflow run examples/pipeline.workflow.ts` |
| `batch` | function | A sequential `.foreach()` over a list (item-as-input; ordered array output). | `/workflow run examples/batch.workflow.ts` |
| `fan-out` | function | `.parallel()` fan-out over two independent steps sharing the same input; output keyed by arm name. | `/workflow run examples/fan-out.workflow.ts` |
| `foreach-concurrent` | function | A `.foreach()` with `concurrency: 3` (item-as-input; output ordered by item, not completion). | `/workflow run examples/foreach-concurrent.workflow.ts` |
| `survey` | questionnaire | A questionnaire step gathers structured input up front, then a later step consumes it. | `/workflow run examples/survey.workflow.ts` |
| `summarize` | agent | A single agent step returning schema-valid structured output (`{ summary, keywords }`). | `/workflow run examples/summarize.workflow.ts` |
| `review-loop` | agent + loop | An agent proposes a slug, a function check evaluates it, `.dountil` it passes (max-iteration guard). | `/workflow run examples/review-loop.workflow.ts` |
| `planning` | Q&A agent | A planning agent that may ask a clarifying question (parks), then plans on the answer. | `/workflow run examples/planning.workflow.ts` |

## Tests

- **Offline** (`npm test`): `test/examples-suite.test.ts` runs every LLM-free example (`hello`,
  `pipeline`, `batch`, `fan-out`, `foreach-concurrent`, `survey`) end-to-end through the engine with
  a fake host.
- **Live** (`npm run test:integration`, gated on `KIMCHI_API_KEY`): the agent-bearing examples
  (`summarize`, `review-loop`, `planning`) run against `kimchi-dev/kimi-k2.7`.
