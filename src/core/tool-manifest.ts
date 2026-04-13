import { z } from "zod";

export const ToolTypeSchema = z.enum(["pip", "cargo", "npm", "claude-plugin", "system"]);

// Typed verification strategies - prevents command injection
export const VerifyStrategySchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("binary-exists"),
		name: z.string(), // Binary name to check via `which`
	}),
	z.object({
		type: z.literal("command-output"),
		command: z.string(), // Must be the tool's own binary
		args: z.array(z.string()), // Separate args, no shell interpretation
		expectContains: z.string().optional(),
	}),
	z.object({
		type: z.literal("pip-package"),
		name: z.string(),
	}),
	z.object({
		type: z.literal("cargo-crate"),
		name: z.string(),
	}),
	z.object({
		type: z.literal("npm-package"),
		name: z.string(),
	}),
]);

export const PostInstallActionSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("run-command"),
		command: z.string(), // Must be tool's own binary
		args: z.array(z.string()),
	}),
	z.object({
		type: z.literal("none"),
	}),
]);

export const ToolEntrySchema = z
	.object({
		name: z.string(),
		type: ToolTypeSchema,
		package: z.string().optional(),
		marketplace: z.string().optional(),
		version: z.string().optional(),
		postInstall: PostInstallActionSchema.default({ type: "none" }),
		verify: VerifyStrategySchema,
		required: z.boolean().default(true),
	})
	.refine(
		(tool) => {
			if (tool.verify.type === "command-output") {
				return tool.verify.command === tool.name || tool.verify.command === tool.package;
			}
			if (tool.postInstall.type === "run-command") {
				return tool.postInstall.command === tool.name || tool.postInstall.command === tool.package;
			}
			return true;
		},
		{
			message: "verify/postInstall commands must reference the tool's own binary (name or package)",
		},
	);

export const ToolManifestSchema = z.object({
	version: z.literal(1),
	discoveredAt: z.string().datetime(),
	sourcePlatform: z.enum(["darwin", "linux", "win32"]),
	tools: z.array(ToolEntrySchema),
	autoInstall: z.boolean().default(false),
});

// Export types
export type ToolType = z.infer<typeof ToolTypeSchema>;
export type ToolEntry = z.infer<typeof ToolEntrySchema>;
export type ToolManifest = z.infer<typeof ToolManifestSchema>;
export type VerifyStrategy = z.infer<typeof VerifyStrategySchema>;
export type PostInstallAction = z.infer<typeof PostInstallActionSchema>;
