import path from "node:path"
import { defineConfig } from "vitest/config"

/**
 * Default (offline) test run. Excludes `*.integration.test.ts`, which make real network calls and
 * run only via `npm run test:integration` (see vitest.integration.config.ts).
 */
export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@kimchi-dev\/kimchi-workflows$/,
				replacement: path.resolve(import.meta.dirname, "src/flow/index.ts"),
			},
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
	},
})
