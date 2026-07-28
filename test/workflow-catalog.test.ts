import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workflowsDir } from "../src/host/project-dir.ts";
import { discoverWorkflows, resolveWorkflow } from "../src/host/workflow-catalog.ts";

/**
 * Discovery reads real files through the real loader, so these tests build throwaway projects on
 * disk rather than faking the filesystem.
 */

const flowImport = path.resolve(import.meta.dirname, "../src/flow/index.ts");

/**
 * A minimal, valid workflow module. Imports resolve by absolute path: these files are written into a
 * temp directory with no `node_modules`, so a bare specifier like `typebox` would not resolve there.
 */
function workflowSource(name: string, description?: string): string {
  const options = description === undefined ? `{ name: "${name}" }` : `{ name: "${name}", description: "${description}" }`;
  return [
    `import { createStep, createWorkflow } from "${flowImport}";`,
    `const step = createStep({ name: "${name}-step", run: () => ({ ok: true }) });`,
    `export default createWorkflow(${options}).then(step).commit();`,
  ].join("\n");
}

/** Build a project whose workflows directory (`.<app>/workflows/`) holds the given files. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-"));
  const dir = workflowsDir(root);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  return root;
}

describe("discoverWorkflows", () => {
  it("is empty when the project has no workflows directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-empty-"));
    expect(await discoverWorkflows(root)).toEqual({ entries: [], broken: [] });
  });

  it("lists each workflow by declared name and description, sorted by name", async () => {
    const root = await project({
      "zeta.workflow.ts": workflowSource("zeta", "the last one"),
      "alpha.workflow.ts": workflowSource("alpha", "the first one"),
    });

    const { entries, broken } = await discoverWorkflows(root);

    expect(broken).toEqual([]);
    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "zeta"]); // by name, not by filename
    expect(entries[0]?.description).toBe("the first one");
    expect(entries[0]?.filePath).toBe(path.join(workflowsDir(root), "alpha.workflow.ts"));
  });

  // The directory is a SOURCE directory now — run logs and step sessions live with the harness's
  // sessions (project-dir.ts) — but discovery still filters, so the lock and an author's own helpers
  // and notes are never imported.
  it("ignores the run lock and anything without the .workflow.ts suffix", async () => {
    const root = await project({
      "real.workflow.ts": workflowSource("real"),
      ".run.lock": '{"runId":"workflow-real-1a2b3c4d"}',
      "helper.ts": "export const notAWorkflow = 1;",
      "notes.md": "# scratch",
    });

    const { entries, broken } = await discoverWorkflows(root);

    expect(entries.map((entry) => entry.name)).toEqual(["real"]);
    expect(broken).toEqual([]);
  });

  it("reports a broken workflow instead of failing the whole catalog", async () => {
    const root = await project({
      "good.workflow.ts": workflowSource("good"),
      "bad.workflow.ts": "export default { not: 'a workflow' };",
    });

    const { entries, broken } = await discoverWorkflows(root);

    expect(entries.map((entry) => entry.name)).toEqual(["good"]); // the good one still lists
    expect(broken).toHaveLength(1);
    expect(broken[0]?.filePath).toContain("bad.workflow.ts");
    expect(broken[0]?.error).toMatch(/does not export a workflow/);
  });
});

describe("resolveWorkflow", () => {
  it("resolves a declared name from the catalog", async () => {
    const root = await project({ "deploy.workflow.ts": workflowSource("deploy") });

    const resolved = await resolveWorkflow(root, "deploy");

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.workflow.name).toBe("deploy");
      expect(resolved.filePath).toContain("deploy.workflow.ts");
    }
  });

  it("resolves a path relative to the project root", async () => {
    const root = await project({ "deploy.workflow.ts": workflowSource("deploy") });

    const resolved = await resolveWorkflow(root, path.relative(root, path.join(workflowsDir(root), "deploy.workflow.ts")));

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.workflow.name).toBe("deploy");
  });

  it("explains an unknown name and lists what is available", async () => {
    const root = await project({ "deploy.workflow.ts": workflowSource("deploy") });

    const resolved = await resolveWorkflow(root, "nope");

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toMatch(/no workflow named "nope"/);
      expect(resolved.error).toMatch(/Known workflows: deploy/);
    }
  });

  it("reports why a named path failed to load", async () => {
    const root = await project({ "bad.workflow.ts": "throw new Error('boom at import');" });

    const resolved = await resolveWorkflow(root, path.relative(root, path.join(workflowsDir(root), "bad.workflow.ts")));

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toMatch(/failed to load/);
  });
});

/**
 * Discovery imports project code to read declared names, so resolving one workflow must not execute
 * the others. These files append to a log at import time, making execution observable.
 */
describe("resolveWorkflow does not execute unrelated workflows (adversarial regression)", () => {
  async function projectWithTracing(): Promise<{ root: string; log: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-trace-"));
    const dir = workflowsDir(root);
    await mkdir(dir, { recursive: true });
    const log = path.join(root, "imports.log");
    for (const name of ["alpha", "beta", "gamma"]) {
      const source = [`import { appendFileSync } from "node:fs";`, `appendFileSync(${JSON.stringify(log)}, "${name}\\n");`, workflowSource(name)].join("\n");
      await writeFile(path.join(dir, `${name}.workflow.ts`), source, "utf8");
    }
    return { root, log };
  }

  const imported = async (log: string): Promise<string[]> => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0);

  it("imports only the requested workflow when it follows the <name>.workflow.ts convention", async () => {
    const { root, log } = await projectWithTracing();

    const resolved = await resolveWorkflow(root, "alpha");

    expect(resolved.ok).toBe(true);
    expect(await imported(log)).toEqual(["alpha"]); // beta and gamma never ran
  });

  it("falls back to a full scan only when the convention does not hold", async () => {
    const { root, log } = await projectWithTracing();
    // A workflow whose declared name does not match its filename can only be found by scanning.
    await writeFile(path.join(workflowsDir(root), "misnamed.workflow.ts"), workflowSource("delta"), "utf8");

    const resolved = await resolveWorkflow(root, "delta");

    expect(resolved.ok).toBe(true);
    expect((await imported(log)).length).toBeGreaterThan(1); // the scan did import the others
  });
});
