import { defineConfig } from "vitest/config"

/** Compiled-harness E2E tests own external processes and one shared project package, so they run serially. */
export default defineConfig({
	test: {
		include: ["e2e/kimchi/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 180_000,
		hookTimeout: 360_000,
	},
})
