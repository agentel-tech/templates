import { waitForWorker } from "./readiness.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

function availablePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Unable to allocate a port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const stateRoot = mkdtempSync(join(tmpdir(), "microfrontend-e2e-"));
const children = [];

async function start(config, providedArgs, waitUntilReady = false) {
	const port = providedArgs ? Number(providedArgs[1]) : await availablePort();
	const listenArgs = providedArgs ?? ["--port", String(port)];
	if (!listenArgs.includes("--inspector-port")) {
		listenArgs.push("--inspector-port", String(await availablePort()));
	}
	const child = spawn(
		pnpm,
		[
			"exec",
			"wrangler",
			"dev",
			"--config",
			config,
			"--persist-to",
			join(stateRoot, basename(config)),
			...listenArgs,
		],
		{ stdio: "inherit" },
	);
	children.push(child);
	if (waitUntilReady) await waitForWorker(child, port);
	return child;
}

function cleanup() {
	rmSync(stateRoot, { recursive: true, force: true });
}

process.once("exit", cleanup);
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(130));

await start("e2e/worker-a.wrangler.jsonc", undefined, true);
await start("e2e/worker-b.wrangler.jsonc", undefined, true);
const main = await start("wrangler.e2e.jsonc", process.argv.slice(2));
main.once("exit", (code) => process.exit(code ?? 1));
