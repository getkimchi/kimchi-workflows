import { defineConfig } from "vitest/config"

/**
 * Default (offline) test run. Excludes `*.integration.test.ts`, which make real network calls and
 * run only via `npm run test:integration` (see vitest.integration.config.ts).
 */
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
	},
})
