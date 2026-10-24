# Testing

## Browser journeys

The retained browser journeys live in [`test/browser/`](../test/browser/): each Node test entrypoint invokes its adjacent Python Playwright harness against a fixture-backed local server. The `Retained browser journeys` CI gate provisions the repository-pinned Chromium and runs `node --test test/browser/*.test.mjs` on every pull request; the same command runs in the full local prepush path (`make a11y` or `./tools/preflight-required-checks.sh --full`) when the host has the browser environment installed. Missing harnesses, Python Playwright, or launchable Chromium fail the test with a diagnostic instead of being skipped.

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

[`tools/preflight-required-checks.sh`](../tools/preflight-required-checks.sh) also pins
`CROL_BUILD_DAY` for the run so primary-document rebuilds share one instant. When unset, that
default comes from the committed money-open snapshot vintage
(`site/data/money_default_open.json` via
[`tools/resolve_preflight_build_day.mjs`](../tools/resolve_preflight_build_day.mjs)), matching the
browser fixture clock — not wall-clock today. An explicit `CROL_BUILD_DAY` still wins.
`CITYSCROLL_TEST_TIME_SHIFT_DAYS` continues to shift `Date.now` for time-travel variants and does
not replace the build-day pin.

For a direct family run, set `NODE_OPTIONS` to import the preload and use
`--test-concurrency=2`. CI exercises the site-node, Worker, and combined families at +1 and +45
days in the non-required `Time-travel` workflow. That check should be promoted to required only
after it is green on `main`; failures should identify the test file and line that still depends on
an unpinned wall clock.

Shifted suites must leave tracked files untouched. Tests that build evidence payloads or capture
manifests compare against committed `docs/evidence/` fixtures (or write under a temp directory)
instead of rewriting those paths. The legacy-name guard suite (`test/stale_name_guard.test.mjs`)
likewise mutates only a temporary fixture tree via `LEGACY_NAME_GUARD_ROOT`, never the tracked
`.github/legacy-name-allowlist.txt` or a repo-root probe. The Time-travel workflow finishes with
`node tools/assert_tracked_working_tree_clean.mjs`, which fails when `git status --porcelain`
reports tracked modifications after the suite.

## Source boundary verification

[`tools/verify_engine_app_boundary.mjs`](../tools/verify_engine_app_boundary.mjs) checks a
reviewed ownership ledger against an inventory derived from the committed tree: tracked files,
Worker bindings (including typed Durable Object bindings and migrations), schedules, workflow jobs,
entrypoints, routing clauses, and the import graph. Source is observed with a pinned parser and is
never executed. The ledger is private evidence: the command reads it only from the absolute path in
`CITYSCROLL_ENGINE_APP_LEDGER`, refuses a path inside the repository checkout, and prints only
bounded status and finding counts.

```sh
CITYSCROLL_ENGINE_APP_LEDGER=/absolute/path/outside/the/checkout/ledger.json \
  node tools/verify_engine_app_boundary.mjs --stage foundation
```

CI does not hold the private ledger, so it never runs this command against the real tree. Instead
[`test/engine_app_boundary.test.mjs`](../test/engine_app_boundary.test.mjs) builds synthetic Git
fixtures and asserts the adversarial cases: an unowned unit, a forbidden binding assigned to the
engine, a reverse import into private code, and a stale source revision or evidence hash all fail,
and a missing ledger or unsupported stage exits non-zero rather than passing. A passing test suite
is therefore evidence that the verifier works, not evidence that the real tree's ownership ledger
is complete. The `site-node` family installs the pinned parser with `npm ci` and requires Python
3.11+ with the PyYAML pin in `tools/source_verification_requirements.txt` for the TOML and workflow
observers. CI installs that file in the `site-node` job; locally, `make setup-a11y` installs it into
the shared accessibility Python environment the pre-push hook runs the preflight in.
