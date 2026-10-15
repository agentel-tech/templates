import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { GrpcContainer } from "../src/index";

function createSocket(chunks: Uint8Array[] = [], keepOpen = false) {
	const written: Uint8Array[] = [];
	const cancel = vi.fn();
	const abort = vi.fn();
	const end = vi.fn();
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const socket: Socket = {
		readable: new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
				for (const chunk of chunks) {
					streamController.enqueue(chunk);
				}
				if (!keepOpen) {
					streamController.close();
				}
			},
			cancel,
		}),
		writable: new WritableStream<Uint8Array>({
			write(chunk) {
				written.push(chunk);
			},
			close: end,
			abort,
		}),
		opened: Promise.resolve({}),
		closed: new Promise(() => {}),
		close: vi.fn().mockResolvedValue(undefined),
		startTls: vi.fn(),
		upgraded: false,
		secureTransport: "off",
		protocol: "tcp",
	};
	return { socket, written, cancel, abort, end, controller: controller! };
}

function createEnv(socket: Socket) {
	const connect = vi.fn().mockReturnValue(socket);
	const getByName = vi.fn().mockReturnValue({ connect });
	const env = { GRPC_CONTAINER: { getByName } } as Env;
	return { env, connect, getByName };
}

const SETTINGS = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0, 0]);

function createContainer(socket: Socket, running = true) {
	const probe = createSocket([SETTINGS]);
	const connect = vi
		.fn()
		.mockReturnValueOnce(probe.socket)
		.mockReturnValue(socket);
	const container = {
		running,
		start: vi.fn(() => {
			container.running = true;
		}),
		getTcpPort: vi.fn().mockReturnValue({
			connect,
		}),
	};
	const durableObject: GrpcContainer = Object.create(GrpcContainer.prototype);
	Object.defineProperty(durableObject, "ctx", { value: { container } });
	return { durableObject, container, connect, probe };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("gRPC Container Worker", () => {
	it("exposes HTTP status and raw TCP handlers", () => {
		expect(Object.keys(worker)).toEqual(["fetch", "connect"]);
	});

	it("exposes a Worker connect handler", () => {
		expect(typeof worker.connect).toBe("function");
	});

	it("returns a plain-text status response without a UI", async () => {
		const response = await worker.fetch();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(await response.text()).toBe(
			"gRPC Container accepts connections over inbound TCP.\n",
		);
	});

	it("exposes a Durable Object connect handler", () => {
		expect(typeof GrpcContainer.prototype.connect).toBe("function");
	});

	it("does not expose a Durable Object fetch handler", () => {
		const durableObject = GrpcContainer.prototype as DurableObject;

		expect(durableObject.fetch).toBeUndefined();
	});

	it("uses the expected connect handler signatures", () => {
		expect(worker.connect).toHaveLength(2);
		expect(GrpcContainer.prototype.connect).toHaveLength(1);
	});

	it("disables caching for the HTTP status response", async () => {
		const response = await worker.fetch();
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("forwards binary data in both directions and closes both sockets", async () => {
		const request = new Uint8Array([0, 255, 128, 10]);
		const response = new Uint8Array([254, 0, 1]);
		const incoming = createSocket([request]);
		const upstream = createSocket([response]);
		const { env, connect, getByName } = createEnv(upstream.socket);

		await worker.connect(incoming.socket, env);

		expect(getByName).toHaveBeenCalledWith("grpc-demo");
		expect(connect).toHaveBeenCalledWith("grpc-container:50051", {
			allowHalfOpen: true,
			secureTransport: "off",
		});
		expect(upstream.written).toEqual([request]);
		expect(incoming.written).toEqual([response]);
		expect(incoming.socket.close).toHaveBeenCalledOnce();
		expect(upstream.socket.close).toHaveBeenCalledOnce();
	});

	it("keeps the response direction open after the client half-closes", async () => {
		const incoming = createSocket();
		const upstream = createSocket([], true);
		const { env } = createEnv(upstream.socket);
		const connection = worker.connect(incoming.socket, env);

		await vi.waitFor(() => expect(upstream.end).toHaveBeenCalledOnce());
		expect(incoming.socket.close).not.toHaveBeenCalled();
		const goodbye = new TextEncoder().encode("goodbye");
		upstream.controller.enqueue(goodbye);
		upstream.controller.close();
		await connection;

		expect(incoming.written).toEqual([goodbye]);
		expect(incoming.socket.close).toHaveBeenCalledOnce();
	});

	it("closes both sockets without waiting for the other pipe after a failure", async () => {
		const incoming = createSocket([], true);
		const upstream = createSocket([], true);
		const { env } = createEnv(upstream.socket);
		vi.spyOn(incoming.socket.readable, "pipeTo").mockRejectedValue(
			new Error("client disconnected"),
		);
		const connection = worker.connect(incoming.socket, env);

		await connection;

		expect(incoming.socket.close).toHaveBeenCalledOnce();
		expect(upstream.socket.close).toHaveBeenCalledOnce();
	});

	it("closes both sockets if the Durable Object connection fails to open", async () => {
		const incoming = createSocket();
		const upstream = createSocket();
		const { env, connect } = createEnv(upstream.socket);
		connect.mockReset().mockImplementation(() => ({
			...upstream.socket,
			opened: Promise.reject(new Error("upstream unavailable")),
		}));

		await expect(worker.connect(incoming.socket, env)).rejects.toThrow(
			"upstream unavailable",
		);
		expect(incoming.socket.close).toHaveBeenCalledOnce();
		expect(upstream.socket.close).toHaveBeenCalledOnce();
	});

	it("closes the client if creating the Durable Object socket throws", async () => {
		const incoming = createSocket();
		const { env, connect } = createEnv(createSocket().socket);
		connect.mockImplementation(() => {
			throw new Error("connect failed");
		});

		await expect(worker.connect(incoming.socket, env)).rejects.toThrow(
			"connect failed",
		);
		expect(incoming.socket.close).toHaveBeenCalledOnce();
	});
});

describe("gRPC Container lifecycle", () => {
	it("shares protocol readiness across concurrent connections and starts only once", async () => {
		const probe = createSocket([], true);
		const firstUpstream = createSocket();
		const secondUpstream = createSocket();
		const { durableObject, container, connect } = createContainer(
			firstUpstream.socket,
			false,
		);
		connect
			.mockReset()
			.mockReturnValueOnce(probe.socket)
			.mockReturnValueOnce(firstUpstream.socket)
			.mockReturnValueOnce(secondUpstream.socket);
		const first = durableObject.connect(createSocket().socket);
		const second = durableObject.connect(createSocket().socket);
		await vi.waitFor(() => expect(probe.written).toHaveLength(1));
		expect(container.start).toHaveBeenCalledOnce();
		expect(connect).toHaveBeenCalledTimes(1);
		probe.controller.enqueue(SETTINGS);
		probe.controller.close();
		await Promise.all([first, second]);
		expect(connect).toHaveBeenCalledTimes(3);
		expect(probe.socket.close).toHaveBeenCalledOnce();
	});

	it("keeps probe bytes out of the client stream and forwards binary application data", async () => {
		const request = new Uint8Array([0, 255]);
		const response = new Uint8Array([128, 1]);
		const incoming = createSocket([request]);
		const upstream = createSocket([response]);
		const { durableObject, container, probe } = createContainer(
			upstream.socket,
		);
		await durableObject.connect(incoming.socket);
		expect(container.start).not.toHaveBeenCalled();
		expect(container.getTcpPort).toHaveBeenCalledWith(50051);
		expect(new TextDecoder().decode(probe.written[0].subarray(0, 24))).toBe(
			"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
		);
		expect(upstream.written).toEqual([request]);
		expect(incoming.written).toEqual([response]);
		expect(probe.socket.close).toHaveBeenCalledOnce();
	});

	it("accepts a fragmented SETTINGS header without consuming the application stream", async () => {
		const upstream = createSocket();
		const { durableObject, connect } = createContainer(upstream.socket);
		const probe = createSocket([SETTINGS.subarray(0, 3), SETTINGS.subarray(3)]);
		connect
			.mockReset()
			.mockReturnValueOnce(probe.socket)
			.mockReturnValue(upstream.socket);
		await durableObject.connect(createSocket().socket);
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it("retries opened sockets whose protocol response closes before readiness", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const upstream = createSocket();
		const { durableObject, connect, probe } = createContainer(upstream.socket);
		const early = createSocket();
		connect
			.mockReset()
			.mockReturnValueOnce(early.socket)
			.mockReturnValueOnce(probe.socket)
			.mockReturnValue(upstream.socket);
		await durableObject.connect(createSocket().socket);
		expect(connect).toHaveBeenCalledTimes(3);
		expect(early.socket.close).toHaveBeenCalledOnce();
	});

	it("rejects non-SETTINGS and SETTINGS ACK responses before trying a fresh probe", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const upstream = createSocket();
		const { durableObject, connect, probe } = createContainer(upstream.socket);
		const wrong = createSocket([new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0])]);
		const ack = createSocket([new Uint8Array([0, 0, 0, 4, 1, 0, 0, 0, 0])]);
		connect
			.mockReset()
			.mockReturnValueOnce(wrong.socket)
			.mockReturnValueOnce(ack.socket)
			.mockReturnValueOnce(probe.socket)
			.mockReturnValue(upstream.socket);
		await durableObject.connect(createSocket().socket);
		expect(connect).toHaveBeenCalledTimes(4);
		expect(wrong.socket.close).toHaveBeenCalledOnce();
		expect(ack.socket.close).toHaveBeenCalledOnce();
	});

	it("bounds a hung probe and retries without waiting forever", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const upstream = createSocket();
		const { durableObject, connect, probe } = createContainer(upstream.socket);
		const hung = createSocket([], true);
		connect
			.mockReset()
			.mockReturnValueOnce(hung.socket)
			.mockReturnValueOnce(probe.socket)
			.mockReturnValue(upstream.socket);
		await durableObject.connect(createSocket().socket);
		expect(connect).toHaveBeenCalledTimes(3);
		expect(hung.socket.close).toHaveBeenCalledOnce();
	});

	it("restarts a stopped Container and verifies readiness again", async () => {
		const upstream = createSocket();
		const { durableObject, container, connect } = createContainer(
			upstream.socket,
			false,
		);
		await durableObject.connect(createSocket().socket);
		container.running = false;
		const nextProbe = createSocket([SETTINGS]);
		connect
			.mockReturnValueOnce(nextProbe.socket)
			.mockReturnValue(upstream.socket);
		await durableObject.connect(createSocket().socket);
		expect(container.start).toHaveBeenCalledTimes(2);
		expect(container.start).toHaveBeenCalledWith({
			enableInternet: false,
			env: { GRPC_PORT: "50051" },
		});
		expect(nextProbe.socket.close).toHaveBeenCalledOnce();
	});

	it("bounds readiness retries and closes the client when all probes fail", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const incoming = createSocket();
		const upstream = createSocket();
		const { durableObject, connect } = createContainer(upstream.socket);
		connect.mockReset().mockImplementation(() => ({
			...upstream.socket,
			opened: Promise.reject(new Error("connection refused")),
		}));
		await expect(durableObject.connect(incoming.socket)).rejects.toThrow(
			"Container gRPC port did not become ready",
		);
		expect(connect).toHaveBeenCalledTimes(60);
		expect(upstream.socket.close).toHaveBeenCalledTimes(60);
		expect(incoming.socket.close).toHaveBeenCalledOnce();
	});

	it("closes an application socket that fails after a successful probe", async () => {
		const incoming = createSocket();
		const upstream = createSocket();
		const { durableObject, connect, probe } = createContainer(upstream.socket);
		connect
			.mockReset()
			.mockReturnValueOnce(probe.socket)
			.mockImplementation(() => ({
				...upstream.socket,
				opened: Promise.reject(new Error("application connect failed")),
			}));
		await expect(durableObject.connect(incoming.socket)).rejects.toThrow(
			"application connect failed",
		);
		expect(upstream.socket.close).toHaveBeenCalledOnce();
		expect(incoming.socket.close).toHaveBeenCalledOnce();
	});

	it("closes the client when no Container is configured", async () => {
		const incoming = createSocket();
		const durableObject: GrpcContainer = Object.create(GrpcContainer.prototype);
		Object.defineProperty(durableObject, "ctx", { value: {} });
		await expect(durableObject.connect(incoming.socket)).rejects.toThrow(
			"Container binding is unavailable",
		);
		expect(incoming.socket.close).toHaveBeenCalledOnce();
	});
});
