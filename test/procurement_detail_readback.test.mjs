import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";
import { renderProcurementDocument, procurementContractWatchHref, procurementVendorFollowHref } from "../site/procurement_document.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url)));
const readback = JSON.parse(readFileSync(new URL("../docs/evidence/procurement-detail-parity/read-back.json", import.meta.url)));
const model = {
  schema: "cityscroll.shared_procurement_read_model.v1",
  generated_at: null,
  rows: [fixture.object],
  observations: fixture.observations,
  sources: {},
};
const baseline = readback.baseline;

test("A5: the base procurement document survives missing optional enrichment", async () => {
  await withPinnedClock("2026-09-09T06:33:01.880Z", () => {
    // Core materialized observations remain available; optional lookup inputs do not.
    const html = renderProcurementDocument(fixture.object, fixture.observations, { lookups: {} });
    assert.match(html, /<h1>City Sanctuary Facility for Families with Children, Comfort Inn Sheepsheads Bay<\/h1>/);
    assert.match(html, /CT107120258801626/);
    assert.match(html, /2023-10-11|2026-06-30/);
    assert.doesNotMatch(html, /procurement-opportunity-window|procurement-opportunity-month/);
  });
});

test("A6: identity, search order, and follow URLs match the retained baseline", () => {
  assert.equal(fixture.object.procurement_id, baseline.procurement_id);
  assert.equal(fixture.object.canonical_id, baseline.canonical_id);
  assert.deepEqual(fixture.object.source_observation_refs, baseline.source_observation_refs);
  assert.deepEqual(fixture.object.identity_edges, baseline.accepted_identity_edges);
  const documents = buildProcurementSearchDocuments(model).documents;
  for (const query of ["CT107120258801626", "07124E0044001"]) {
    assert.deepEqual(searchKeywordDocuments(documents, resolveKeywordQuery(query), { limit: 10 }).map((row) => row.object_ref), baseline.search_rank);
  }
  assert.equal(procurementContractWatchHref(fixture.object.procurement_id), baseline.watch_urls.contract);
  assert.equal(procurementVendorFollowHref("BHRAGS HOME CARE CORP"), baseline.watch_urls.vendor);
});

test("A7: every retained destination is a native keyboard link and the layout receipt is overflow-free", () => {
  const html = renderProcurementDocument(fixture.object, fixture.observations);
  const links = [...html.matchAll(/<a\b([^>]*)>/g)].map((match) => match[1]);
  assert.equal(links.length, readback.layout.keyboard.visible_native_links);
  assert.ok(links.every((attrs) => /\bhref=/.test(attrs)));
  assert.equal((html.match(/tabindex=["']-1["']/gi) || []).length, readback.layout.keyboard.negative_tabindex);
  for (const viewport of [readback.layout.desktop, readback.layout.mobile]) {
    assert.equal(viewport.scroll_width, viewport.viewport[0]);
    assert.equal(viewport.overflow, false);
  }
});

test("A7: the retained accessibility receipt proves both viewport scans ran", async () => {
  await withPinnedClock("2026-09-09T06:33:01.880Z", () => {
    const accessibility = readback.accessibility;
    assert.equal(accessibility.engine.name, "axe-core");
    assert.match(accessibility.engine.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(accessibility.viewports).sort(), ["desktop", "mobile"]);
    for (const scan of Object.values(accessibility.viewports)) {
      assert.ok(scan.rules_run.length > 0);
      assert.ok(scan.rules_run.every((rule) => typeof rule === "string" && rule.length > 0));
      assert.ok(scan.nodes_examined > 0);
      assert.ok(Array.isArray(scan.violations));
      assert.ok(scan.violations.every((violation) => ["minor", "moderate", "serious", "critical"].includes(violation.impact)));
      if (scan.violations.length === 0) assert.ok(scan.passes.length > 0);
      assert.ok(Array.isArray(scan.serious_or_critical));
      assert.deepEqual(scan.serious_or_critical, scan.violations.filter((violation) => ["serious", "critical"].includes(violation.impact)));
      assert.match(scan.markup_sha256, /^[a-f0-9]{64}$/);
      assert.equal(scan.scanned_at, testClockISOString());
    }
  });
});

test("A8: the read-back artifact names its focused verification command", () => {
  assert.equal(readback.verification.command, "node --test test/procurement_detail_readback.test.mjs");
  assert.equal(readback.verification.status, "passed");
});
