import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BOUNDARY_REFERENCE,
  CHECKED_DOCUMENTS,
  EVIDENCE_BOUNDARIES,
  RETIRED_CLAIMS,
  ROUTED_SUMMARIES,
  buildCollectionBoundaryFacts,
  documentsLoadingClarity,
  readClarityLoader,
  topLevelSiteDocuments,
  verifyCollectionBoundaryDocumentation,
} from "../tools/collection_boundary_facts.mjs";

const reference = readFileSync(new URL(`../${BOUNDARY_REFERENCE}`, import.meta.url), "utf8");

test("the third-party loader is configured, not dormant", () => {
  const loader = readClarityLoader();
  // The loader's own gate is a non-empty project id, so this is the fact that
  // decides whether the tag is requested at all.
  assert.equal(loader.configured, true);
  assert.equal(loader.tag_origin, "https://www.clarity.ms/tag/");
});

test("every top-level site document includes the loader", () => {
  const topLevel = topLevelSiteDocuments();
  const loading = documentsLoadingClarity();
  assert.ok(topLevel.length > 0);
  for (const path of topLevel) assert.ok(loading.includes(path), path);
  // The search shell carries it too, and resolves it through its own base href.
  assert.ok(loading.includes("site/search/index.html"));
});

test("all three declared opt-out signals are read by the loader", () => {
  assert.deepEqual(readClarityLoader().skip_signals, [
    "navigator.doNotTrack",
    "navigator.msDoNotTrack",
    "navigator.globalPrivacyControl",
  ]);
});

test("masking is a code-level attribute pass, and the load outcome is never observed", () => {
  const loader = readClarityLoader();
  assert.equal(loader.mask_attribute, "data-clarity-mask");
  assert.equal(loader.mask_selector, "input, textarea, select");
  assert.deepEqual(loader.named_masked_fields, ["adest", "fbemail"]);
  // Nothing in the tree reads the injected script's outcome, so no committed fact
  // can say collection succeeded.
  assert.equal(loader.load_outcome_observed, false);
});

test("the public projection is exactly two counts over two named periods", () => {
  const published = buildCollectionBoundaryFacts().public_search_usage;
  assert.deepEqual(published.metric_ids, ["searches_run", "searches_returning_records"]);
  assert.deepEqual(published.period_ids, ["last7d", "last30d"]);
  assert.equal(published.schema, "cityscroll.public_search_usage.v1");
});

test("the retention each private path configures is read from its own contract", () => {
  const facts = buildCollectionBoundaryFacts();
  assert.equal(facts.first_party_analytics.retention_days, 90);
  assert.equal(facts.search_execution_receipts.retention_days, 30);
  assert.equal(facts.account_search_history.retention_days, 90);
  assert.equal(facts.account_search_history.max_entries, 25);
  // The third-party path is the one with no retention declared in this repository.
  assert.equal(Object.hasOwn(facts.third_party_loader, "retention_days"), false);
});

test("the reference records provider-side facts as unestablished rather than asserting them", () => {
  for (const boundary of EVIDENCE_BOUNDARIES) {
    assert.match(reference, new RegExp(`\\| ${boundary} \\| Not established here \\|`), boundary);
  }
  // The one mention of a dashboard masking mode describes an instruction to an
  // operator, never a setting this repository observed.
  const strictLines = reference.split("\n").filter((line) => line.includes("Strict"));
  assert.equal(strictLines.length, 1);
  assert.match(strictLines[0], /instructs an operator/);
  assert.match(strictLines[0], /Not established here/);
});

test("retired absolute claims match the sentences they replaced and not the corrections", () => {
  const retiredTracker = "no required accounts, no fingerprinting, no third-party trackers, and no visitor profiles";
  const retiredStats = "public `/stats` never reads or returns product-use telemetry.";
  assert.ok(RETIRED_CLAIMS.some((claim) => claim.pattern.test(retiredTracker)));
  assert.ok(RETIRED_CLAIMS.some((claim) => claim.pattern.test(retiredStats)));
  for (const path of CHECKED_DOCUMENTS) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    for (const claim of RETIRED_CLAIMS) {
      assert.doesNotMatch(text, claim.pattern, `${path} / ${claim.pattern.source}`);
    }
  }
});

test("both architecture summaries route to the owned reference", () => {
  const link = BOUNDARY_REFERENCE.split("/").pop();
  for (const path of ROUTED_SUMMARIES) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(text.includes(link), path);
  }
});

test("the owned reference agrees with the committed code", () => {
  assert.deepEqual(verifyCollectionBoundaryDocumentation().findings, []);
});
