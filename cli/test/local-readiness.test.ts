import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fetch from "node-fetch";
import { TemplateServerManager } from "../../playwright-tests/utils/template-server";
import { waitForWorker } from "../../microfrontend-template/e2e/readiness.mjs";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
const child = { exitCode: null, signalCode: null };
const fetchMock = vi.mocked(fetch);
const manager = Object.create(TemplateServerManager.prototype);

beforeEach(() => {
	vi.resetAllMocks();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function untilAborted(_url: unknown, init: { signal: AbortSignal }) {
	return new Promise<never>((_resolve, reject) => {
		init.signal.addEventListener("abort", () => reject(new Error("aborted")), {
			once: true,
		});
	});
}

it("requires the configured health status, not just any successful response", async () => {
	fetchMock.mockResolvedValue({ status: 200, ok: true } as never);
	await expect(
		manager.waitForServer("http://localhost:1234", child, [], 50, 401),
	).rejects.toThrow("last HTTP status: 200");
});

it("accepts the expected protected-route status", async () => {
	fetchMock.mockResolvedValue({ status: 401, ok: false } as never);
	await expect(
		manager.waitForServer("http://localhost:1234", child, [], 50, 401),
	).resolves.toBeUndefined();
});

it("aborts an unresponsive health request inside the overall deadline", async () => {
	fetchMock.mockImplementation(untilAborted as never);
	const started = Date.now();
	await expect(
		manager.waitForServer("http://localhost:1234", child, [], 50),
	).rejects.toThrow("within 50ms");
	expect(Date.now() - started).toBeLessThan(1000);
	expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it("fails immediately when the server was terminated by a signal", async () => {
	await expect(
		manager.waitForServer(
			"http://localhost:1234",
			{ ...child, signalCode: "SIGTERM" },
			[],
			50,
		),
	).rejects.toThrow("SIGTERM");
	expect(fetchMock).not.toHaveBeenCalled();
});

it("accepts a healthy microfrontend stub", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
	await expect(waitForWorker(child, 1234, 50)).resolves.toBeUndefined();
});

it("bounds a hung microfrontend stub request", async () => {
	const mock = vi.fn(untilAborted);
	vi.stubGlobal("fetch", mock);
	const started = Date.now();
	await expect(waitForWorker(child, 1234, 50)).rejects.toThrow("within 50ms");
	expect(Date.now() - started).toBeLessThan(1000);
	expect(mock.mock.calls[0][1].signal.aborted).toBe(true);
});

it("does not accept a 503 stub as ready", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
	await expect(waitForWorker(child, 1234, 50)).rejects.toThrow(
		"last HTTP status: 503",
	);
});

it("fails immediately when a stub exits by signal", async () => {
	const mock = vi.fn();
	vi.stubGlobal("fetch", mock);
	await expect(
		waitForWorker({ ...child, signalCode: "SIGTERM" }, 1234, 50),
	).rejects.toThrow("SIGTERM");
	expect(mock).not.toHaveBeenCalled();
});
