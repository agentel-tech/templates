// Keep each request and polling delay inside the overall startup budget.
export async function waitForWorker(
	child,
	port,
	timeoutMs = process.env.TEMPLATES_SLOW_LOCAL_TESTS === "1" ? 180_000 : 15_000,
) {
	const deadline = Date.now() + timeoutMs;
	let lastStatus;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(
				`Stub Worker exited with ${child.signalCode ?? child.exitCode}`,
			);
		}
		try {
			const response = await fetch(`http://localhost:${port}`, {
				signal: AbortSignal.timeout(
					Math.max(1, Math.min(10_000, deadline - Date.now())),
				),
			});
			lastStatus = response.status;
			if (response.ok) return;
		} catch {
			// Worker is still starting, or the bounded request was aborted.
		}
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, Math.min(100, deadline - Date.now()))),
		);
	}
	throw new Error(
		`Stub Worker on port ${port} did not start within ${timeoutMs}ms (last HTTP status: ${lastStatus ?? "none"})`,
	);
}
