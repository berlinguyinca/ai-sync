import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFabricConfig, parseFabricUrl } from "../../../src/core/fabric/config.js";

describe("fabric config", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "fabric-cfg-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("is null when nothing is configured", async () => {
		expect(await loadFabricConfig(dir, {})).toBeNull();
	});

	it("reads the env var, which wins over the file", async () => {
		await fs.mkdir(path.join(dir, "tools"));
		await fs.writeFile(path.join(dir, "tools", "fabric.json"), '{"url":"http://file.example"}');
		expect(await loadFabricConfig(dir, { AI_SYNC_FABRIC_URL: "http://env.example/" })).toEqual({
			url: "http://env.example",
		});
		expect(await loadFabricConfig(dir, {})).toEqual({ url: "http://file.example" });
	});

	it("rejects malformed files and bad URLs", async () => {
		await fs.mkdir(path.join(dir, "tools"));
		await fs.writeFile(path.join(dir, "tools", "fabric.json"), "{nope");
		await expect(loadFabricConfig(dir, {})).rejects.toThrow(/Invalid JSON/);
		await fs.writeFile(path.join(dir, "tools", "fabric.json"), '{"url": 5}');
		await expect(loadFabricConfig(dir, {})).rejects.toThrow(/url/);
		for (const bad of ["file:///etc/passwd", "ftp://x", "not a url", "http://u:p@host", ""]) {
			expect(() => parseFabricUrl(bad)).toThrow();
		}
	});
});
