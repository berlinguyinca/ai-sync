import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		setupFiles: ["tests/setup/hermetic-env.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
		},
	},
});
