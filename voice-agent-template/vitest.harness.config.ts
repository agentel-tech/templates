import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Real Wrangler listen/reset/close operations need more time under CPU emulation.
		hookTimeout: process.env.TEMPLATES_SLOW_LOCAL_TESTS === "1" ? 60000 : 10000,
		include: ["test-harness/**/*.test.ts"],
	},
});
