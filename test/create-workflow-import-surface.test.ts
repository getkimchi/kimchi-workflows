import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The built-in create workflow is reloaded through `loadWorkflowFile`'s restricted loader — on
 * `/workflow resume`, and by the attended loop after its questionnaire is answered. That loader
 * resolves ONLY the specifiers below; anything else falls back to filesystem resolution, which in the
 * installed harness has no `@earendil-works/pi-coding-agent` on disk (it is a peer, virtual in PI's
 * own extension loader). This suite pins the static import closure so a harness-only import cannot
 * sneak back in — a load test cannot: in THIS repo the bare import resolves via the devDependency.
 */

/** What `loadWorkflowFile` resolves: `workflowModules` keys, node built-ins, and its own `jiti` dependency. */
const LOADER_RESOLVABLE = new Set([
	"typebox",
	"typebox/value",
	"typebox/compile",
	"@kimchi-dev/kimchi-workflows",
	"@kimchi-dev/kimchi-workflows/flow",
	"@kimchi-dev/kimchi-workflows/engine",
	"jiti",
])

/** Type-only imports are erased before the loader sees them, so `import type` / `export type` are skipped. */
const IMPORT_RE =
	/(?:^|\n)\s*(?:import|export)\s(?!type\s)[^"'\n]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g

async function importClosure(entry: string): Promise<Map<string, string[]>> {
	const bareBySource = new Map<string, string[]>()
	const queue = [entry]
	const seen = new Set<string>()
	while (queue.length > 0) {
		const file = queue.pop() as string
		if (seen.has(file)) continue
		seen.add(file)
		const source = await readFile(file, "utf8")
		for (const match of source.matchAll(IMPORT_RE)) {
			const specifier = (match[1] ?? match[2]) as string
			if (specifier.startsWith("node:")) continue
			if (specifier.startsWith(".")) {
				queue.push(path.resolve(path.dirname(file), specifier))
				continue
			}
			const bare = bareBySource.get(file) ?? []
			bare.push(specifier)
			bareBySource.set(file, bare)
		}
	}
	return bareBySource
}

describe("builtin create workflow import surface", () => {
	it("stays loadable by loadWorkflowFile: every bare import in its closure is loader-resolvable", async () => {
		const entry = path.resolve(import.meta.dirname, "../src/host/builtin/create.workflow.ts")
		const offenders: string[] = []
		for (const [file, specifiers] of await importClosure(entry)) {
			for (const specifier of specifiers) {
				if (!LOADER_RESOLVABLE.has(specifier)) offenders.push(`${path.relative(process.cwd(), file)} → ${specifier}`)
			}
		}
		expect(offenders).toEqual([])
	})
})
