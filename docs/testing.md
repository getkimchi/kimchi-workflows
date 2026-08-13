# Testing workflows

Use the public `@kimchi-dev/kimchi-workflows/testing` helpers to run a committed workflow without Kimchi, a model,
or network access.

```ts
import { describe, expect, it } from "vitest"
import { createTestRun } from "@kimchi-dev/kimchi-workflows/testing"
import workflow from "./weather.workflow.ts"

describe("weather", () => {
	it("formats the fetched forecast", async () => {
		const run = await createTestRun(workflow, {
			steps: {
				fetch: () => ({ temperature: "18 °C", conditions: "Cloudy" }),
			},
		})

		expect(run.status).toBe("completed")
		expect(run.output).toEqual({ summary: "Cloudy, 18 °C" })
	})
})
```

Stub agent, network, and destructive effects. Keep deterministic formatting, validation, branching, and data-flow
logic real. Assert both completion and the final observable result or effect. For model protocol behavior, use
helpers such as `reply`, `ask`, `raw`, `fails`, and `throws`; for an authoring test, a step override is usually
clearer.

## Package-owned verification

`/workflow create` prepares `.kimchi/workflows` as a self-contained pnpm package before authoring starts. From the
project root, reproduce the same focused check with:

```bash
pnpm --dir .kimchi/workflows run verify:workflow -- \
  --entry ./weather.workflow.ts \
  --test ./weather.workflow.test.ts
```

The command uses the TypeScript and Vitest versions in that package's lockfile. It generates isolated temporary
configuration, type-checks the submitted workflow and test, and then executes exactly that test file. It neither
loads the parent project's Vitest configuration nor runs a broader test suite.

For ordinary test-runner ergonomics, run every workflow test through the package's default verification script:

```bash
pnpm --dir .kimchi/workflows run verify
```

The focused verifier is stricter: zero executed tests, skipped-only tests, collection errors, assertion failures,
unhandled errors, or TypeScript errors all fail verification. Third-party imports resolve from the workflow
package, matching Jiti's runtime module lookup.
