#!/usr/bin/env node

import { createJiti } from "jiti"

try {
	const jiti = createJiti(import.meta.url)
	const { main } = await jiti.import(new URL("../src/verification/cli.ts", import.meta.url).href)
	process.exitCode = await main(process.argv.slice(2))
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 2
}
