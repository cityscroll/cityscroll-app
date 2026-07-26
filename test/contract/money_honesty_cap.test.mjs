// Contract test: the Money-lens "honesty cap" — Award notices with contract_amount >= $10B are
// EDA-confirmed data-entry errors (worker/src/ingest.mjs: "3 rows >= $10B are data-entry errors,
// max legit ~= $6.68B") and must be excluded from every Award query on both sides, everywhere.
//
// This is a real, live pair, not a hypothetical: index.html carried the threshold's OLD value
// ($5,000,000,000) in 9 separate query-building call sites while one call site (added later,
// alongside the worker's own $10B) and every worker file had already moved to $10B — silently
// excluding real, legitimate contracts between $5B and $10B from the Money lens, agency/vendor
// profiles, and stats aggregates. Fixed in the same change that added this test
// (see docs/drift-inventory.md #1). This test pins the CONSTANT itself so a future edit to one
// call site without the others fails the build instead of shipping unnoticed.
//
//   node --test test/contract/money_honesty_cap.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CANONICAL_CAP = 10000000000; // $10B — worker/src/ingest.mjs's AMOUNT_CAP = 1e10

function capsFoundIn(text) {
  const caps = new Set();
  for (const m of text.matchAll(/contract_amount\s*<\s*(\d+)/g)) caps.add(Number(m[1]));
  return caps;
}

test("index.html: every 'contract_amount <' clause uses the canonical $10B cap", () => {
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  const caps = capsFoundIn(src);
  assert.ok(caps.size > 0, "expected to find at least one contract_amount cap clause in index.html");
  assert.deepEqual([...caps], [CANONICAL_CAP], `index.html has a stale/inconsistent cap: found ${[...caps]}`);
});

test("worker/src/lib/compile.mjs: cron-replay query uses the canonical $10B cap", () => {
  const src = readFileSync(join(ROOT, "worker/src/lib/compile.mjs"), "utf8");
  assert.deepEqual([...capsFoundIn(src)], [CANONICAL_CAP]);
});

test("worker/src/alerts.mjs: live award-watch query uses the canonical $10B cap", () => {
  const src = readFileSync(join(ROOT, "worker/src/alerts.mjs"), "utf8");
  assert.deepEqual([...capsFoundIn(src)], [CANONICAL_CAP]);
});

test("worker/src/ingest.mjs: D1 ingest's AMOUNT_CAP matches the canonical $10B cap", () => {
  const src = readFileSync(join(ROOT, "worker/src/ingest.mjs"), "utf8");
  const m = src.match(/AMOUNT_CAP\s*=\s*([0-9.e+]+)/i);
  assert.ok(m, "AMOUNT_CAP constant not found in worker/src/ingest.mjs");
  assert.equal(Number(m[1]), CANONICAL_CAP);
});

// The `contract_amount <` regex above only catches the SODA $where-clause form of this cap.
// The stale $5B value also showed up as a plain numeric guard — `X >= 5e9` in index.html's
// awardContext() — that the same-named contract_amount pattern never matches. Belt-and-suspenders:
// no form of the OLD $5B value (decimal or scientific notation) should appear anywhere in either
// tree at all, regardless of what syntactic shape a future stray copy takes.
const STALE_CAP_PATTERN = /\b5000000000\b|\b5e9\b/;

test("index.html: no stale $5B literal in any form (decimal or scientific notation)", () => {
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  assert.doesNotMatch(src, STALE_CAP_PATTERN);
});

test("worker/src: no stale $5B literal in any form (decimal or scientific notation)", () => {
  for (const f of ["alerts.mjs", "ingest.mjs", "lib/compile.mjs"]) {
    const src = readFileSync(join(ROOT, "worker/src", f), "utf8");
    assert.doesNotMatch(src, STALE_CAP_PATTERN, `worker/src/${f}`);
  }
});
