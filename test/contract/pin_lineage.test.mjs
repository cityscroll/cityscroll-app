// Contract test: the PIN-honesty primitives (usablePin/pinBase/isBlanketChain) must agree
// byte-for-byte across site and worker (see docs/drift-inventory.md #8). These decide whether a
// notice's procurement-ID history reads as a genuine paper trail — a silent mismatch here would
// mean the site shows a renewal chain the worker's cron-time enrichment disagrees is real, or
// vice versa.
//
//   node --test test/contract/pin_lineage.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSite } from "./site_extract.mjs";
import { usablePin as workerUsablePin, pinBase as workerPinBase, isBlanketChain as workerIsBlanketChain } from "../../worker/src/lib/lineage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = JSON.parse(readFileSync(join(ROOT, "test/contract/fixtures/pin_lineage.json"), "utf8"));

const { usablePin: siteUsablePin, pinBase: sitePinBase, isBlanketChain: siteIsBlanketChain } = loadSite([
  "JUNK_PINS", "JUNK_PIN_TEXT_RE", "usablePin",
  "RENEWAL_SUFFIX_RE", "pinBase",
  "isBlanketChain",
]);

for (const { input, note } of fixtures.usablePin) {
  test(`usablePin(${JSON.stringify(input)}) matches across site and worker — ${note}`, () => {
    assert.equal(siteUsablePin(input), workerUsablePin(input));
  });
}

for (const { input, note } of fixtures.pinBase) {
  test(`pinBase(${JSON.stringify(input)}) matches across site and worker — ${note}`, () => {
    assert.equal(sitePinBase(input), workerPinBase(input));
  });
}

for (const { input, note } of fixtures.isBlanketChain) {
  test(`isBlanketChain(${JSON.stringify(input)}) matches across site and worker — ${note}`, () => {
    assert.equal(siteIsBlanketChain(input), workerIsBlanketChain(input));
  });
}
