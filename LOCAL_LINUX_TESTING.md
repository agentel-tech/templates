# Local Linux testing under CPU emulation

Run the repository's regular commands first. Their defaults remain unchanged:

```sh
pnpm -w check
pnpm -w test
pnpm test:e2e
```

A Linux x86_64 guest emulated on an ARM host can spend more than a minute on
Worker startup or a first SSR request. For diagnosing functional behavior on
that environment, opt into bounded local waits explicitly:

```sh
TEMPLATES_SLOW_LOCAL_TESTS=1 pnpm exec turbo run test --concurrency=2 --continue=always -- --passWithNoTests
TEMPLATES_SLOW_LOCAL_TESTS=1 pnpm test:e2e --retries=0
```

Use two concurrent template tasks to avoid saturating the emulated CPU. The flag
changes test budgets and Voice file scheduling: Playwright startup 300 seconds, case 600
seconds, assertions 30 seconds, actions 60 seconds, navigation 180 seconds;
microfrontend stub startup 180 seconds; Voice harness hooks 60 seconds; Workflow
integration cases 30 seconds. Voice Worker unit files start serially in this
profile to avoid saturating the emulated CPU during Vitest pool initialization. Each health request and polling pause stays within
the remaining startup budget. The live Playwright configuration stays unchanged.
Individual tests can retain stricter explicit case timeouts. Turbo includes the
flag in the test cache key and forwards it in strict mode.

Tests still execute real local Workers, browser assertions, and container paths.
No failed status is accepted as healthy, and no assertion is skipped. A pass with
this profile is diagnostic evidence, not a pass within the official CI defaults
or its 20 minute job budget. Use a native Ubuntu runner to establish that result.
This profile does not authorize deployment and requires no production secrets.
