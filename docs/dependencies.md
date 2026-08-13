# Workflow dependencies

Project workflows share one private pnpm package at `.kimchi/workflows/`. `/workflow create` initializes and
maintains its `package.json`, `pnpm-lock.yaml`, verification scripts, and development toolchain. It does not create
one package per workflow.

The managed development dependencies include the matching workflow framework, TypeBox, TypeScript, Vitest, and
the PI types needed by workflow authoring. The harness still supplies its own framework, TypeBox, and PI modules
when it loads a workflow through Jiti; the package copies exist for editor support and verification, not to replace
the host runtime.

## Third-party packages

A workflow may import ordinary packages such as `date-fns` or an API client. Add them to the workflow package:

```bash
pnpm --dir .kimchi/workflows add date-fns
```

Jiti resolves those imports from `.kimchi/workflows/node_modules`, beside the workflow files. The same dependency
and lockfile are used by the package-owned verifier, so runtime and verification do not accidentally depend on the
parent repository's toolchain.

Keep project-specific packages in `dependencies` or `devDependencies` as usual. Future `/workflow create` runs
preserve user dependencies and scripts while restoring the managed verification command and its required
development dependencies. The initial managed install uses `--ignore-scripts`; a later explicit `pnpm add` follows
the package manager's normal lifecycle-script policy.
