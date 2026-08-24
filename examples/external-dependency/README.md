# External dependency workflow

This example verifies that a workflow can import a third-party package that is not supplied by the Kimchi harness. The workflow imports `slugify` from this directory's package and returns a slug as its structured result.

Install the dedicated package without attaching it to a surrounding pnpm workspace:

```bash
pnpm --dir examples/external-dependency --ignore-workspace install --frozen-lockfile
```

Launch Kimchi from the repository root and run the workflow by path:

```text
/workflow run examples/external-dependency/external-dependency.workflow.ts
```

The completed run should return `kimchi-resolves-workflow-local-dependencies`. Resolving `slugify` from the harness or repository root should fail; resolving it relative to this package should succeed.
