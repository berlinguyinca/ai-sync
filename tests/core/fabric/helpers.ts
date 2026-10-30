import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
	url: string;
	requests: http.IncomingMessage[];
	close: () => Promise<void>;
}

/** Starts a real local HTTP server driven by `handler`. */
export async function startServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
	const requests: http.IncomingMessage[] = [];
	const server = http.createServer((req, res) => {
		requests.push(req);
		handler(req, res);
	});
	const sockets = new Set<import("node:net").Socket>();
	server.on("connection", (s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r());
			}),
	};
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

export const sampleHost = {
	host_id: "laptop",
	ai_sync_version: "1.2.3",
	envs_enabled: ["claude", "pi"],
	last_sync_ts: new Date().toISOString(),
	ahead: 0,
	behind: 2,
	drifted_files_count: 1,
	last_error: null,
	checked_at: new Date().toISOString(),
};
