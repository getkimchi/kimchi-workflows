import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@kimchi-dev\/kimchi-workflows\/testing$/,
				replacement: path.resolve(import.meta.dirname, "../src/testing/index.ts"),
			},
			{
				find: /^@kimchi-dev\/kimchi-workflows$/,
				replacement: path.resolve(import.meta.dirname, "../src/flow/index.ts"),
			},
		],
	},
	test: {
		include: ["**/*.test.ts"],
		exclude: ["node_modules/**", "**/*.integration.test.ts"],
	},
})
