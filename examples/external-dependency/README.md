# External dependency workflow

This example verifies that a workflow can import a third-party package that is not supplied by the Kimchi harness. The workflow imports `slugify` from the shared `examples/` package and returns a slug as its structured result.

Install the shared examples package without attaching it to a surrounding pnpm workspace:

```bash
pnpm --dir examples --ignore-workspace install --frozen-lockfile
```

Type-check every example with that package's TypeScript and declared dependencies:

```bash
pnpm run typecheck:examples
```

Then run the offline suite for every example against the current repository checkout:

```bash
pnpm run test:examples
```

Launch Kimchi from the repository root and run the workflow by path:

```text
/workflow run examples/external-dependency/external-dependency.workflow.ts
```

The completed run should return `kimchi-resolves-workflow-local-dependencies`. Resolving `slugify` from the harness or repository root should fail; resolving it relative to this package should succeed.
