# Testing

## Wall-clock tests

Tests must be deterministic about the instant they reason about. Prefer passing an explicit
`now`, `clock`, or date value into the code under test. When a legacy path reads the process
clock directly, use the shared [`test/helpers/test_clock.mjs`](../test/helpers/test_clock.mjs)
helper:

```js
import { withPinnedClock } from "./helpers/test_clock.mjs";

await withPinnedClock("2026-09-14T00:00:00.000Z", async () => {
  // Exercise the code that reads Date or Date.now here.
});
```

`withPinnedClock` pins both `new Date()` and `Date.now()` and restores the previous `Date` in a
`finally` block. Keep scopes short and do not overlap them in concurrently running tests; the
process clock is global. Explicit constructor arguments such as `new Date("...")` are unchanged.

The `node tools/audit-test-clocks.mjs` static lint runs in the PR `static-standards` check and the
local prepush family. It rejects new or changed test files that read `new Date()`, `Date.now()`,
`Temporal.Now`, or a direct wrapper around them without a pinned clock or explicit time injection.
For a test that genuinely must observe the real clock, put `// test-clock: allow-real-clock` on
the specific read line and briefly state why; this is the only wall-clock exception mechanism.

The preload at [`test/helpers/test_clock_preload.mjs`](../test/helpers/test_clock_preload.mjs)
shifts and freezes the process clock for a whole test process. The existing local runner applies
it when `CITYSCROLL_TEST_TIME_SHIFT_DAYS` is set and caps Node test concurrency at 2:

```sh
CITYSCROLL_TEST_TIME_SHIFT_DAYS=1 ./tools/preflight-required-checks.sh
CITYSCROLL_TEST_TIME_SHIFT_DAYS=45 ./tools/preflight-required-checks.sh
```

For a direct family run, set `NODE_OPTIONS` to import the preload and use
`--test-concurrency=2`. CI exercises the site-node, Worker, and combined families at +1 and +45
days in the non-required `Time-travel` workflow. That check should be promoted to required only
after it is green on `main`; failures should identify the test file and line that still depends on
an unpinned wall clock.
