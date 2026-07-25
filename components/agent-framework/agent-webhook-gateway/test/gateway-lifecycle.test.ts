import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { type GatewayLifecycleService, startGatewayListener } from "../src/gateway-lifecycle.ts";

interface RecordedService extends GatewayLifecycleService {
	startCount: number;
	closeCount: number;
}

function createRecordedService(): RecordedService {
	return {
		startCount: 0,
		closeCount: 0,
		start() {
			this.startCount += 1;
		},
		async close() {
			this.closeCount += 1;
		},
	};
}

async function listen(server: Server): Promise<AddressInfo> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return server.address() as AddressInfo;
}

async function close(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

describe("Gateway listener lifecycle", () => {
	it("starts both workers and closes the listener and services exactly once", async () => {
		const service = createRecordedService();
		const healthService = createRecordedService();
		const server = createServer((_request, response) => {
			response.end("ok");
		});
		const runtime = await startGatewayListener({
			server,
			host: "127.0.0.1",
			port: 0,
			service,
			healthService,
		});
		const address = server.address() as AddressInfo;

		expect((await fetch(`http://127.0.0.1:${address.port}`)).status).toBe(200);
		expect(server.listenerCount("error")).toBe(0);
		await runtime.close();
		await runtime.close();

		expect(server.listening).toBe(false);
		expect(service).toMatchObject({ startCount: 1, closeCount: 1 });
		expect(healthService).toMatchObject({ startCount: 1, closeCount: 1 });
	});

	it("closes both services when the configured port cannot be bound", async () => {
		const occupiedServer = createServer();
		const occupiedAddress = await listen(occupiedServer);
		const service = createRecordedService();
		const healthService = createRecordedService();
		const server = createServer();
		try {
			await expect(
				startGatewayListener({
					server,
					host: "127.0.0.1",
					port: occupiedAddress.port,
					service,
					healthService,
				}),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
			expect(service).toMatchObject({ startCount: 1, closeCount: 1 });
			expect(healthService).toMatchObject({ startCount: 1, closeCount: 1 });
		} finally {
			await close(server);
			await close(occupiedServer);
		}
	});
});
