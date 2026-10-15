import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Workflow execution remains real; only the local emulation budget changes.
		testTimeout: process.env.TEMPLATES_SLOW_LOCAL_TESTS === "1" ? 30000 : 5000,
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
