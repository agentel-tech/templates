import { DurableObject } from "cloudflare:workers";

const CONTAINER_INSTANCE = "grpc-demo";
const GRPC_PORT = 50051;
const LOCAL_GRPC_PORT = 8788;
const CONTAINER_CONNECT_ATTEMPTS = 60;
const CONTAINER_CONNECT_RETRY_MS = 250;
const CONTAINER_PROBE_TIMEOUT_MS = 1_000;
// A dedicated HTTP/2 connection verifies gRPC readiness without consuming or
// injecting bytes into the client's independent connection.
const HTTP2_PREFACE = new Uint8Array([
	...new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"),
	0,
	0,
	0,
	4,
	0,
	0,
	0,
	0,
	0, // Empty client SETTINGS frame.
]);

const SOCKET_OPTIONS: SocketOptions = {
	// A gRPC client half-closes its request stream before the server finishes
	// writing its response stream, so the two directions must remain independent.
	allowHalfOpen: true,
	// The connection is private between the Durable Object and its Container.
	secureTransport: "off",
};

function log(event: string, details: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ event, ...details }));
}

async function bridgeSockets(left: Socket, right: Socket): Promise<void> {
	try {
		await Promise.all([
			left.readable.pipeTo(right.writable),
			right.readable.pipeTo(left.writable),
		]);
	} catch (error) {
		log("socket_pipe_closed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

export class GrpcContainer extends DurableObject<Env> {
	private starting: Promise<void> | undefined;

	private async probeGrpcPort(container: Container): Promise<void> {
		const probe = container
			.getTcpPort(GRPC_PORT)
			.connect(`10.0.0.1:${GRPC_PORT}`, SOCKET_OPTIONS);
		// Local proxy sockets can report opened before the process is listening.
		// Observe the protocol response instead of treating that as readiness.
		void probe.closed.catch(() => {});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					await probe.opened;
					const writer = probe.writable.getWriter();
					try {
						await writer.write(HTTP2_PREFACE);
					} finally {
						writer.releaseLock();
					}
					const reader = probe.readable.getReader();
					try {
						const header = new Uint8Array(9);
						let received = 0;
						while (received < header.length) {
							const { value, done } = await reader.read();
							if (done)
								throw new Error("Container closed before HTTP/2 SETTINGS");
							const part = value.subarray(0, header.length - received);
							header.set(part, received);
							received += part.length;
						}
						if (
							header[3] !== 4 ||
							header[4] !== 0 ||
							header.slice(5).some((byte) => byte !== 0)
						) {
							throw new Error("Container did not send initial HTTP/2 SETTINGS");
						}
					} finally {
						reader.releaseLock();
					}
				})(),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error("Container HTTP/2 probe timed out")),
						CONTAINER_PROBE_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			await probe.close().catch(() => {});
		}
	}

	private async waitForGrpcPort(container: Container): Promise<void> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= CONTAINER_CONNECT_ATTEMPTS; attempt += 1) {
			try {
				await this.probeGrpcPort(container);
				return;
			} catch (error) {
				lastError = error;
			}
			if (attempt < CONTAINER_CONNECT_ATTEMPTS) {
				await scheduler.wait(CONTAINER_CONNECT_RETRY_MS);
			}
		}
		throw new Error("Container gRPC port did not become ready", {
			cause: lastError,
		});
	}

	private async openGrpcSocket(): Promise<Socket> {
		const container = this.ctx.container;
		if (!container) throw new Error("Container binding is unavailable");
		if (!this.starting) {
			if (!container.running) {
				container.start({
					enableInternet: false,
					env: { GRPC_PORT: String(GRPC_PORT) },
				});
			}
			this.starting = this.waitForGrpcPort(container).finally(() => {
				this.starting = undefined;
			});
		}
		await this.starting;
		const upstream = container
			.getTcpPort(GRPC_PORT)
			.connect(`10.0.0.1:${GRPC_PORT}`, SOCKET_OPTIONS);
		try {
			await upstream.opened;
			return upstream;
		} catch (error) {
			await upstream.close().catch(() => {});
			throw error;
		}
	}

	async connect(socket: Socket): Promise<void> {
		log("durable_object_connection_opened", { containerPort: GRPC_PORT });
		let upstream: Socket | undefined;

		try {
			upstream = await this.openGrpcSocket();
			await bridgeSockets(socket, upstream);
		} finally {
			await Promise.allSettled([socket.close(), upstream?.close()]);
			log("durable_object_connection_closed");
		}
	}
}

const worker = {
	async fetch(): Promise<Response> {
		return new Response(
			"gRPC Container accepts connections over inbound TCP.\n",
			{
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	},

	async connect(socket, env): Promise<void> {
		log("worker_connection_opened", { localPort: LOCAL_GRPC_PORT });
		let durableObjectSocket: Socket | undefined;

		try {
			const container = env.GRPC_CONTAINER.getByName(CONTAINER_INSTANCE);
			durableObjectSocket = container.connect(
				`grpc-container:${GRPC_PORT}`,
				SOCKET_OPTIONS,
			);
			await durableObjectSocket.opened;
			await bridgeSockets(socket, durableObjectSocket);
		} finally {
			await Promise.allSettled([socket.close(), durableObjectSocket?.close()]);
			log("worker_connection_closed");
		}
	},
} satisfies ExportedHandler<Env>;

export default worker;
