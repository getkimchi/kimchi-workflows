import { defineConfig } from "vitest/config"

/**
 * Integration run: real network calls to the model gateway. Requires `KIMCHI_API_KEY` (read from
 * the environment or `../kimchi-dev/.env`); the test self-skips when the key is absent.
 */
export default defineConfig({
	test: {
		include: ["test/**/*.integration.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
})
