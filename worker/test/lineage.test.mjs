// Pins lib/lineage.mjs's computeLineageSignal() — the CANDIDATE-level (not per-row) lineage-
// richness judgment w12-17 uses to decide whether a suggestion chip's OWN live results
// conspicuously carry prior award cycles. This is the cron-time twin of PR #61's (w12-10)
// per-row computeLineageBadgeCounts(): same pinBase()-widening/isBlanketChain()/
// LINEAGE_MAX_STAGES honesty rules, ported here so the worker can judge a candidate without a
// browser — but this file asks "what SHARE of a sample has history" rather than "what count
// does this ONE row have".
//
// Before this card: suggestion chips carried no signal at all about which ones lead to
// contracts with a paper trail worth exploring — the site owner directive was to surface that,
// with a subtle indicator, not leave it undiscoverable.
//
// Fixtures are the real "construction contracts over $500k" candidate's own live results
// (SUGGESTION_POOL money idx 0), queried from the City Record dataset (SODA dg92-zbpx) on
// 2026-07-15: a 25-row sample ordered start_date DESC (the exact shape
// suggestionSampleParams() builds), of which 6 rows resolve to a genuine 2-stage Award/Intent-
// to-Award chain once each PIN is widened and looked up (Correction PIN 07222B0008003, Parks
// and Recreation PIN 84623B0128001, Homeless Services PIN 07122P0023001, Transportation PIN
// 84121P0023002, Citywide Administrative Services PIN 85623B0004001, and a second Correction
// chain at PIN 07222B0004001 — each pair's two real stages queried live) — a 24% share. The
// sample also includes the real pinBase()-widening collision PR #61 (w12-10) already documents
// (PIN 82626R0001001, agency "Environmental Protection", widens to base "82626" and
// prefix-matches 125 unrelated rows live as of 2026-07-15 — reduced to 16 same-shaped rows here
// to keep the fixture readable, same convention PR #61's own test uses for this exact PIN) and
// correctly excludes it as uncertain rather than counting it as a 125-cycle chain.
//
//   node --test test/lineage.test.mjs   (from the crol-list/worker/ dir)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usablePin, pinBase, isBlanketChain, lineageChainKey, lineageDedupeKey, lineageBatchClauses,
  computeLineageSignal, LINEAGE_SAMPLE_MIN, LINEAGE_RICH_MIN_SHARE,
} from "../src/lib/lineage.mjs";

const constructionSample = [
  { pin: "85026B0058001", agency_name: "Design and Construction" },
  { pin: "82624B0040001R001", agency_name: "Environmental Protection" },
  { pin: "07222B0008003R001", agency_name: "Correction" },
  { pin: "82624B0038001R001", agency_name: "Environmental Protection" },
  { pin: "82626R0001001", agency_name: "Environmental Protection" },
  { pin: "82624B0041001R001", agency_name: "Environmental Protection" },
  { pin: "82624B0043001R001", agency_name: "Environmental Protection" },
  { pin: "85026B0033001", agency_name: "Design and Construction" },
  { pin: "85023P0003002R001", agency_name: "Design and Construction" },
  { pin: "82624B0042001R001", agency_name: "Environmental Protection" },
  { pin: "85023P0003003R001", agency_name: "Design and Construction" },
  { pin: "84626B0062001", agency_name: "Parks and Recreation" },
  { pin: "84626B0028001", agency_name: "Parks and Recreation" },
  { pin: "85026B0074001", agency_name: "Design and Construction" },
  { pin: "84623B0128001R001", agency_name: "Parks and Recreation" },
  { pin: "07122P0023001R001", agency_name: "Homeless Services" },
  { pin: "85026B0021001", agency_name: "Design and Construction" },
  { pin: "82626W0061001", agency_name: "Environmental Protection" },
  { pin: "84625B0150001", agency_name: "Parks and Recreation" },
  { pin: "84121P0023002R001", agency_name: "Transportation" },
  { pin: "85623B0004001R001", agency_name: "Citywide Administrative Services" },
  { pin: "84124P0003001", agency_name: "Transportation" },
  { pin: "82626E0006001", agency_name: "Environmental Protection" },
  { pin: "07222B0004001R001", agency_name: "Correction" },
  { pin: "84626W0028001", agency_name: "Parks and Recreation" },
];

// Real two-stage Award chains, each queried live (start_date ASC) for its own base+agency.
const constructionBatch = [
  { pin: "07222B0008003", agency_name: "Correction", type_of_notice_description: "Award" },
  { pin: "07222B0008003R001", agency_name: "Correction", type_of_notice_description: "Award" },
  { pin: "84623B0128001", agency_name: "Parks and Recreation", type_of_notice_description: "Award" },
  { pin: "84623B0128001R001", agency_name: "Parks and Recreation", type_of_notice_description: "Award" },
  { pin: "07122P0023001", agency_name: "Homeless Services", type_of_notice_description: "Award" },
  { pin: "07122P0023001R001", agency_name: "Homeless Services", type_of_notice_description: "Award" },
  { pin: "84121P0023002", agency_name: "Transportation", type_of_notice_description: "Award" },
  { pin: "84121P0023002R001", agency_name: "Transportation", type_of_notice_description: "Award" },
  { pin: "85623B0004001", agency_name: "Citywide Administrative Services", type_of_notice_description: "Award" },
  { pin: "85623B0004001R001", agency_name: "Citywide Administrative Services", type_of_notice_description: "Award" },
  { pin: "07222B0004001", agency_name: "Correction", type_of_notice_description: "Award" },
  { pin: "07222B0004001R001", agency_name: "Correction", type_of_notice_description: "Award" },
  // Real PIN-prefix collision (see file header) — 16 same-shaped stand-ins for the 125 real
  // rows a live "82626%" + agency_name='Environmental Protection' query returns.
  ...Array.from({ length: 16 }, (_, i) => ({
    pin: `82626${i}`, agency_name: "Environmental Protection",
    type_of_notice_description: i % 3 === 0 ? "Intent to Award" : "Award",
  })),
];

test("computeLineageSignal: the real 'construction contracts over $500k' candidate is lineage-rich (6/25 = 24% share)", () => {
  const signal = computeLineageSignal(constructionSample, constructionBatch);
  assert.equal(signal.sampleSize, 25);
  assert.equal(signal.lineageCount, 6);
  assert.ok(Math.abs(signal.lineageShare - 0.24) < 1e-9);
  assert.equal(signal.lineageRich, true);
});

test("computeLineageSignal: the real PIN-prefix collision (82626R0001001) is excluded, not counted as a chain", () => {
  // Isolate just the collision row — if it counted as "history", it would report a nonsensical
  // 16+-cycle chain instead of "uncertain".
  const signal = computeLineageSignal(
    [{ pin: "82626R0001001", agency_name: "Environmental Protection" }],
    constructionBatch,
  );
  assert.equal(signal.lineageCount, 0);
  assert.equal(signal.lineageRich, false);
});

test("computeLineageSignal: an all-chainless sample is not lineage-rich", () => {
  const sample = [
    { pin: "84626B0062001", agency_name: "Parks and Recreation" },
    { pin: "84626B0028001", agency_name: "Parks and Recreation" },
    { pin: "85026B0058001", agency_name: "Design and Construction" },
    { pin: "85026B0033001", agency_name: "Design and Construction" },
    { pin: "84124P0003001", agency_name: "Transportation" },
  ];
  const signal = computeLineageSignal(sample, []);
  assert.equal(signal.lineageCount, 0);
  assert.equal(signal.lineageRich, false);
});

test("computeLineageSignal: below LINEAGE_SAMPLE_MIN never reports lineage-rich, even at 100% share", () => {
  const sample = constructionSample.slice(0, LINEAGE_SAMPLE_MIN - 1).map((r) => ({ pin: r.pin, agency_name: r.agency_name }));
  // Force every sampled row to resolve via the real Correction chain so share would be 100%.
  const forced = sample.map(() => ({ pin: "07222B0008003R001", agency_name: "Correction" }));
  const signal = computeLineageSignal(forced, constructionBatch);
  assert.equal(signal.sampleSize, LINEAGE_SAMPLE_MIN - 1);
  assert.equal(signal.lineageRich, false, "sample too small to trust, regardless of share");
});

test("computeLineageSignal: a share below LINEAGE_RICH_MIN_SHARE is not lineage-rich even with a healthy sample", () => {
  // 1 chain-bearing row diluted across a large chainless sample.
  const chainless = Array.from({ length: 20 }, (_, i) => ({ pin: `2026${i}999`, agency_name: "Parks" }));
  const sample = [{ pin: "07222B0008003R001", agency_name: "Correction" }, ...chainless];
  const signal = computeLineageSignal(sample, constructionBatch);
  assert.equal(signal.lineageCount, 1);
  assert.ok(signal.lineageShare < LINEAGE_RICH_MIN_SHARE);
  assert.equal(signal.lineageRich, false);
});

test("computeLineageSignal: rows with no usable PIN are skipped, not counted toward the sample's chain share", () => {
  const sample = [{ pin: "TBD", agency_name: "Parks" }, { pin: "07222B0008003R001", agency_name: "Correction" }];
  const signal = computeLineageSignal(sample, constructionBatch);
  assert.equal(signal.lineageCount, 1);
});

test("computeLineageSignal: an empty sample is not lineage-rich (no data, not a guess)", () => {
  const signal = computeLineageSignal([], constructionBatch);
  assert.equal(signal.lineageRich, false);
  assert.equal(signal.lineageShare, 0);
});

// ---- the ported chain-key / batch-clause helpers (same shape as PR #61's client-side ones) --

test("pinBase: widens a renewal-suffixed PIN, leaves a bare PIN alone", () => {
  assert.equal(pinBase("07222B0008003R001"), "07222B0008003");
  assert.equal(pinBase("84626B0062001"), null);
});

test("usablePin: rejects known City Record junk placeholders", () => {
  assert.equal(usablePin("TBD"), false);
  assert.equal(usablePin("SEE BELOW"), false);
  assert.equal(usablePin("07222B0008003R001"), true);
});

test("isBlanketChain: a >5-row all-Award pool is a blanket code, not a rebid cadence", () => {
  const blanket = Array.from({ length: 6 }, () => ({ pin: "82714CC00040", agency_name: "Sanitation", type_of_notice_description: "Award" }));
  assert.equal(isBlanketChain(blanket), true);
  assert.equal(isBlanketChain(blanket.slice(0, 2)), false);
});

test("lineageChainKey / lineageDedupeKey: two rows of the same widened chain collapse to one key", () => {
  const a = lineageChainKey({ pin: "07222B0008003R001", agency_name: "Correction" });
  const b = lineageChainKey({ pin: "07222B0008003", agency_name: "Correction" });
  assert.equal(lineageDedupeKey(a), lineageDedupeKey(b));
});

test("lineageBatchClauses: quote-escapes and widens the same way loadLineageBadges() does client-side", () => {
  const keys = [lineageChainKey({ pin: "07222B0008003R001", agency_name: "Correction" })];
  assert.equal(lineageBatchClauses(keys)[0], "(pin LIKE '07222B0008003%' AND agency_name='Correction')");
});
