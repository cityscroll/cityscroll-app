// Contract test: vendorStem() must return byte-identical output on both sides for every fixture
// case (see docs/drift-inventory.md #5). Vendor-name identity backs watch matching (client) and
// cron replay (worker) — a stemmed mismatch means a subscriber's watch silently stops matching
// notices the site itself considers the same vendor.
//
//   node --test test/contract/vendor_stem.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSite } from "./site_extract.mjs";
import { vendorStem as workerVendorStem } from "../../worker/src/lib/compile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = JSON.parse(readFileSync(join(ROOT, "test/contract/fixtures/vendor_stem.json"), "utf8"));

const { vendorStem: siteVendorStem } = loadSite(["cleanText", "VENDOR_SUFFIX", "vendorStem"]);

for (const { input, note } of fixtures) {
  test(`vendorStem("${input}") matches across site and worker — ${note}`, () => {
    assert.equal(siteVendorStem(input), workerVendorStem(input));
  });
}

test("fixture set is non-empty", () => {
  assert.ok(fixtures.length > 5, "fixture file looks truncated");
});
