import { afterEach, describe, expect, it } from "vitest";
import {
	FABRIC_MAX_BYTES,
	FabricError,
	fetchFabricConfig,
	fetchFabricHosts,
} from "../../../src/core/fabric/client.js";
import { json, sampleHost, startServer, type TestServer } from "./helpers.js";

let server: TestServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("fabric client", () => {
	it("returns validated hosts and sends the token as X-API-Key", async () => {
		server = await startServer((_req, res) => json(res, 200, { hosts: [sampleHost] }));
		const hosts = await fetchFabricHosts(server.url, { AI_SYNC_FABRIC_TOKEN: "s3cret" });
		expect(hosts).toEqual([sampleHost]);
		expect(server.requests[0].url).toBe("/api/v1/ai-sync");
		expect(server.requests[0].headers["x-api-key"]).toBe("s3cret");
	});

	it("sends no X-API-Key without a token", async () => {
		server = await startServer((_req, res) => json(res, 200, { hosts: [] }));
		await fetchFabricHosts(server.url, {});
		expect(server.requests[0].headers["x-api-key"]).toBeUndefined();
	});

	it("rejects structurally invalid responses", async () => {
		server = await startServer((_req, res) =>
			json(res, 200, { hosts: [{ ...sampleHost, ahead: "many" }] }),
		);
		await expect(fetchFabricHosts(server.url, {})).rejects.toMatchObject({ kind: "invalid" });
	});

	it("rejects non-JSON bodies", async () => {
		server = await startServer((_req, res) => res.end("<html>"));
		await expect(fetchFabricHosts(server.url, {})).rejects.toMatchObject({ kind: "invalid" });
	});

	it("rejects oversize bodies (declared and streamed)", async () => {
		server = await startServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("x".repeat(FABRIC_MAX_BYTES + 10));
		});
		await expect(fetchFabricHosts(server.url, {})).rejects.toMatchObject({ kind: "oversize" });
		await server.close();
		server = await startServer((_req, res) => {
			res.writeHead(200, { "Transfer-Encoding": "chunked" });
			res.write("x".repeat(FABRIC_MAX_BYTES + 10));
			res.end();
		});
		await expect(fetchFabricHosts(server.url, {})).rejects.toMatchObject({ kind: "oversize" });
	});

	it("times out on a stalled server", async () => {
		server = await startServer(() => {
			// never respond
		});
		const started = Date.now();
		await expect(fetchFabricHosts(server.url, {})).rejects.toMatchObject({ kind: "timeout" });
		expect(Date.now() - started).toBeLessThan(8000);
	}, 15_000);

	it("surfaces 401 without leaking the token", async () => {
		server = await startServer((_req, res) => json(res, 401, { error: "nope" }));
		const err = await fetchFabricHosts(server.url, { AI_SYNC_FABRIC_TOKEN: "s3cret" }).catch(
			(e) => e,
		);
		expect(err).toBeInstanceOf(FabricError);
		expect(err.status).toBe(401);
		expect(String(err.message)).not.toContain("s3cret");
	});

	it("does not follow redirects (token stays on the configured origin)", async () => {
		const target = await startServer((_req, res) => json(res, 200, { hosts: [] }));
		server = await startServer((_req, res) => {
			res.writeHead(302, { Location: `${target.url}/api/v1/ai-sync` });
			res.end();
		});
		await expect(
			fetchFabricHosts(server.url, { AI_SYNC_FABRIC_TOKEN: "t" }),
		).rejects.toBeInstanceOf(FabricError);
		expect(target.requests).toHaveLength(0);
		await target.close();
	});

	it("reports an unreachable endpoint as a network error", async () => {
		server = await startServer(() => {});
		const url = server.url;
		await server.close();
		server = undefined;
		await expect(fetchFabricHosts(url, {})).rejects.toMatchObject({ kind: "network" });
	});

	it("fetches shared config, null on 404, and validates shape", async () => {
		const cfg = {
			repo_url: "https://x/y.git",
			branch: "main",
			envs: ["claude"],
			merge_enabled: true,
		};
		server = await startServer((_req, res) => json(res, 200, cfg));
		expect(await fetchFabricConfig(server.url, {})).toEqual(cfg);
		await server.close();
		server = await startServer((_req, res) => json(res, 404, {}));
		expect(await fetchFabricConfig(server.url, {})).toBeNull();
		await server.close();
		server = await startServer((_req, res) => json(res, 200, { repo_url: 1 }));
		await expect(fetchFabricConfig(server.url, {})).rejects.toMatchObject({ kind: "invalid" });
	});
});
