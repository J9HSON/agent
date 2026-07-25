import type { Server } from "node:http";

export interface GatewayLifecycleService {
	start(): void;
	close(): Promise<void>;
}

export interface GatewayListenerOptions {
	server: Server;
	host: string;
	port: number;
	service: GatewayLifecycleService;
	healthService?: GatewayLifecycleService;
}

export interface GatewayListener {
	close(): Promise<void>;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function closeResources(options: GatewayListenerOptions): Promise<void> {
	const errors: unknown[] = [];
	for (const close of [
		() => closeServer(options.server),
		() => options.healthService?.close(),
		() => options.service.close(),
	]) {
		try {
			await close();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) {
		throw errors[0];
	}
	if (errors.length > 1) {
		throw new AggregateError(errors, "Multiple Gateway resources failed to close");
	}
}

export async function startGatewayListener(options: GatewayListenerOptions): Promise<GatewayListener> {
	let closePromise: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closePromise ??= closeResources(options);
		return closePromise;
	};
	try {
		options.healthService?.start();
		options.service.start();
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				options.server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				options.server.off("error", onError);
				resolve();
			};
			options.server.once("error", onError);
			options.server.once("listening", onListening);
			try {
				options.server.listen(options.port, options.host);
			} catch (error) {
				options.server.off("error", onError);
				options.server.off("listening", onListening);
				reject(error);
			}
		});
	} catch (startupError) {
		try {
			await close();
		} catch (closeError) {
			throw new AggregateError([startupError, closeError], "Gateway startup and cleanup both failed");
		}
		throw startupError;
	}
	return { close };
}
