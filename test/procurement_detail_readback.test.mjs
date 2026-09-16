import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";
import { renderProcurementDocument, procurementContractWatchHref, procurementVendorFollowHref } from "../site/procurement_document.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url)));
const readback = JSON.parse(readFileSync(new URL("../docs/evidence/procurement-detail-parity/read-back.json", import.meta.url)));
const routeProof = JSON.parse(readFileSync(new URL("../docs/evidence/served-procurement-route/read-back.json", import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL("../docs/evidence/served-procurement-route/capture-manifest.json", import.meta.url)));
const productionRead = JSON.parse(readFileSync(new URL("../docs/evidence/served-procurement-route/production-read.json", import.meta.url)));
const verification = JSON.parse(readFileSync(new URL("../docs/evidence/served-procurement-route/verification-receipt.json", import.meta.url)));
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

test("A7: measured layout boxes show no overflow and the two viewports differ", () => {
  const html = renderProcurementDocument(fixture.object, fixture.observations);
  const links = [...html.matchAll(/<a\b([^>]*)>/g)].map((match) => match[1]);
  assert.equal(links.length, routeProof.layout.keyboard.visible_native_links);
  assert.ok(links.every((attrs) => /\bhref=/.test(attrs)));
  assert.equal((html.match(/tabindex=["']-1["']/gi) || []).length, routeProof.layout.keyboard.negative_tabindex);
  const desktop = routeProof.layout.desktop;
  const mobile = routeProof.layout.mobile;
  assert.equal(desktop.overflow, false);
  assert.equal(mobile.overflow, false);
  assert.ok(desktop.scroll_width <= desktop.inner_width + 1);
  assert.ok(mobile.scroll_width <= mobile.inner_width + 1);
  assert.notEqual(desktop.viewport[0], mobile.viewport[0]);
  assert.notEqual(desktop.client_width, mobile.client_width);
  assert.equal(routeProof.layout.viewports_differ, true);
  assert.equal(manifest.captures.length, 2);
  assert.notEqual(manifest.captures[0].layout_sha256, manifest.captures[1].layout_sha256);
  for (const capture of manifest.captures) {
    assert.equal(capture.layout.overflow, false);
    assert.match(capture.layout_sha256, /^[a-f0-9]{64}$/);
    assert.match(capture.screenshot_sha256, /^[a-f0-9]{64}$/);
  }
});

test("A7: keyboard traversal reaches every named destination", () => {
  const named = routeProof.layout.keyboard.named_destinations;
  assert.ok(named);
  assert.deepEqual(named.expected_destinations, manifest.expected_links);
  assert.equal(named.all_named_destinations_reached, true);
  assert.deepEqual(named.missing_destinations, []);
  assert.equal(named.reached_in_tab_order.length, manifest.expected_links.length);
  for (const href of manifest.expected_links) {
    assert.ok(named.reached_in_tab_order.includes(href), href);
  }
  assert.deepEqual(manifest.keyboard_traversal.reached_in_tab_order, named.reached_in_tab_order);
});

test("A7: the retained accessibility receipt proves both viewport scans ran", async () => {
  await withPinnedClock("2026-09-09T06:33:01.880Z", () => {
    const accessibility = routeProof.accessibility;
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

test("A4: the retained production read shows each exact search returns the specimen once", () => {
  assert.equal(productionRead.schema, "cityscroll.served_procurement_route_production_read.v1");
  assert.equal(productionRead.summary.result, "pass");
  assert.equal(productionRead.live_origin, "https://cityscroll.org");
  assert.ok(productionRead.served_build_vintage.worker_commit);
  const searches = productionRead.reads.filter((read) => read.kind === "exact_identifier_search");
  assert.equal(searches.length, 2);
  for (const search of searches) {
    assert.equal(search.results_length, 1, search.url);
    assert.equal(search.distinct_object_refs, 1, search.url);
    assert.equal(search.result, "pass", search.url);
    assert.ok(search.served_build_vintage.worker_commit);
    assert.match(search.response_sha256, /^[a-f0-9]{64}$/);
  }
});

test("A8: the retained verification receipt records suite exit statuses", () => {
  assert.equal(verification.schema, "cityscroll.served_procurement_route_verification_receipt.v1");
  assert.equal(verification.summary.status, "passed");
  assert.equal(verification.summary.failed, 0);
  assert.ok(verification.commands.length >= 6);
  assert.ok(verification.commands.every((entry) => entry.status !== "failed"));
  assert.equal(routeProof.verification.receipt, "docs/evidence/served-procurement-route/verification-receipt.json");
  assert.equal(routeProof.verification.status, "passed");
  assert.notEqual(routeProof.verification.command, "node --test test/procurement_detail_readback.test.mjs");
});
