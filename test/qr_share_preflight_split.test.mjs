import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("required preflight runs the independent land canary, not QR capture assertions", () => {
  const preflight = read("tools/preflight-required-checks.sh");
  assert.match(preflight, /capture_qr_share\.py --land-canary/);
  assert.doesNotMatch(preflight, /capture_qr_share\.py --verify-only/);
});

test("QR capture remains a non-blocking accessibility diagnostic", () => {
  const shard = read("tools/run_a11y_ci_shard.sh");
  assert.match(
    shard,
    /if ! tools\/run_a11y_functional_check\.sh qr-share[\s\S]*?non-blocking/,
  );
});

test("full QR capture prepares its Pages-shaped artifacts itself", () => {
  const capture = read("test/functional/capture_qr_share.py");
  assert.match(capture, /tools\/prepare_functional_site\.sh/);
  assert.match(capture, /cannot be combined with --verify-only/);
});
