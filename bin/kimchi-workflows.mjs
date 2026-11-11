#!/usr/bin/env node

import { createJiti } from "jiti"

// `run` is the headless batch host (src/host/cli.ts); anything else is the verification
// toolchain's CLI (src/verification/cli.ts), which owns `verify`. Both are loaded through jiti,
// like the extension: a git install never runs the publish build, so `src` is the only entry
// point guaranteed to exist.
const [verb] = process.argv.slice(2)

try {
	const jiti = createJiti(import.meta.url)
	const entry = verb === "run" ? "../src/host/cli.ts" : "../src/verification/cli.ts"
	const { main } = await jiti.import(new URL(entry, import.meta.url).href)
	process.exitCode = await main(process.argv.slice(2))
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 2
}
