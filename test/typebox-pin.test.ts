/**
 * The typebox we test against must be the typebox the harness runs us on.
 *
 * PI's extension loader does not resolve `typebox` from the consuming project at all: it builds its
 * own jiti with `alias` (Node) or `virtualModules` (compiled Bun binary) pointing at the copy bundled
 * with `@earendil-works/pi-coding-agent`, and that mapping wins over any local `node_modules`. So our
 * declared version has no say at runtime — it only decides what `vitest` and `tsc` see. When the two
 * drift, the suite silently stops testing the code the harness executes (a caret range once left tests
 * on 1.3.6 while every real run used PI's 1.1.38).
 *
 * Hence the exact pin, and hence this test: a PI upgrade that moves typebox fails here, which is the
 * signal to re-pin `devDependencies.typebox` to match rather than to widen the range.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

/**
 * Read a dependency's own manifest by locating its directory, not by importing it: typebox hides
 * `./package.json` behind its `exports` map, and PI declares no `.` entry at all (only subpaths), so
 * both defeat `require.resolve`. The `node_modules` search path does not care about either.
 */
function manifestOf(packageName: string): PackageManifest {
  for (const dir of require.resolve.paths(packageName) ?? []) {
    const candidate = path.join(dir, packageName, "package.json");
    if (!existsSync(candidate)) continue;
    return JSON.parse(readFileSync(candidate, "utf8")) as PackageManifest;
  }
  throw new Error(`could not locate the package.json of "${packageName}"`);
}

/** What PI hands to extensions: the version its own package.json pins. */
function piBundledTypeboxVersion(): string {
  const pinned = manifestOf("@earendil-works/pi-coding-agent").dependencies?.typebox;
  if (!pinned) throw new Error("@earendil-works/pi-coding-agent no longer declares a typebox dependency — check how it provides typebox to extensions now");
  return pinned;
}

describe("typebox pin", () => {
  it("matches the copy PI bundles for extensions", () => {
    expect(manifestOf("typebox").version).toBe(piBundledTypeboxVersion());
  });

  it("is pinned exactly, so a range can never reintroduce the drift", () => {
    const self = require("../package.json") as { devDependencies: Record<string, string>; dependencies?: Record<string, string> };
    expect(self.devDependencies.typebox).toMatch(/^\d+\.\d+\.\d+$/);
    // PI provides typebox at runtime (docs/packages.md), so shipping our own copy would be dead weight.
    expect(self.dependencies?.typebox).toBeUndefined();
  });
});
