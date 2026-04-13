import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ProvisionConfig {
	autoInstall: boolean;
	confirmBeforeInstall: boolean;
	rollbackOnFailure: boolean;
}

const DEFAULTS: ProvisionConfig = {
	autoInstall: false,
	confirmBeforeInstall: true,
	rollbackOnFailure: true,
};

export async function loadProvisionConfig(syncRepoDir: string): Promise<ProvisionConfig> {
	try {
		const configPath = path.join(syncRepoDir, "tools", "config.json");
		const content = await fs.readFile(configPath, "utf-8");
		const parsed = JSON.parse(content);
		return { ...DEFAULTS, ...parsed };
	} catch {
		return DEFAULTS;
	}
}
