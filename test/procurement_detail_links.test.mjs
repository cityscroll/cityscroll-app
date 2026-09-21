import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  procurementIdentifierSearchHref,
  renderProcurementDocument,
} from "../site/procurement_document.mjs";
import { EMMONS_ROUTES, renderEmmonsShelterMonitorPack } from "../site/emmons_shelter_monitor_pack.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import {
  resolveKeywordQuery,
  searchKeywordDocuments,
} from "../site/keyword_matcher.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url)));
const searchReadModel = {
  schema: "cityscroll.shared_procurement_read_model.v1",
  generated_at: null,
  rows: [fixture.object],
  observations: fixture.observations,
  sources: {},
};

test("the procurement facts row continues into the accepted agency and vendor entities", () => {
  const html = renderProcurementDocument(fixture.object, fixture.observations);
  assert.match(html, /<dt>Agency<\/dt><dd><a[^>]+href="\/agencies\/homeless-services\/"[^>]*>[\s\S]*Homeless Services<\/a><\/dd>/);
  assert.match(html, /<dt>Vendor<\/dt><dd><a[^>]+href="\/vendors\/BHRAGS%20HOME%20CARE\/"[^>]*>[\s\S]*BHRAGS HOME CARE CORP<\/a><\/dd>/);
  assert.match(html, /data-pivot-schema="cityscroll\.edge_summary\.v1"/);
});

test("retained contract identifiers link to exact search destinations", () => {
  const html = renderProcurementDocument(fixture.object, fixture.observations);
  assert.match(html, /<dt>Contract ID<\/dt><dd><a[^>]+href="\/search\/\?q=CT107120258801626"[^>]*>CT107120258801626<\/a><\/dd>/);
  assert.match(html, /<dt>PIN \/ EPIN<\/dt><dd><a[^>]+href="\/search\/\?q=07124E0044001"[^>]*>07124E0044001<\/a><\/dd>/);
  assert.equal(procurementIdentifierSearchHref("CT107120258801626"), "/search/?q=CT107120258801626");
  assert.equal(procurementIdentifierSearchHref(""), null);
  assert.equal(procurementIdentifierSearchHref("<script>alert(1)</script>"), null);
});

test("A2: the canonical procurement links back to the pack and the pack retains CB15 and parcel routes", () => {
  const procurementHtml = renderProcurementDocument(fixture.object, fixture.observations);
  const packHtml = renderEmmonsShelterMonitorPack();
  assert.ok(procurementHtml.includes(`href="${EMMONS_ROUTES.issue}"`));
  assert.ok(packHtml.includes(`href="${EMMONS_ROUTES.board}"`));
  assert.ok(packHtml.includes(`href="${EMMONS_ROUTES.parcel}"`));
  assert.doesNotMatch(procurementHtml, /3206 Emmons|separate procurement/i);
});

test("A3: an exact Contract ID search returns the procurement specimen", () => {
  const documents = buildProcurementSearchDocuments(searchReadModel).documents;
  const matches = searchKeywordDocuments(
    documents,
    resolveKeywordQuery("CT107120258801626"),
    { limit: 10 },
  );
  assert.deepEqual(matches.map((document) => document.object_ref), [fixture.object.procurement_id]);
});

test("A4: an exact PIN / EPIN search returns the procurement specimen", () => {
  const documents = buildProcurementSearchDocuments(searchReadModel).documents;
  const matches = searchKeywordDocuments(
    documents,
    resolveKeywordQuery("07124E0044001"),
    { limit: 10 },
  );
  assert.deepEqual(matches.map((document) => document.object_ref), [fixture.object.procurement_id]);
});

test("A6: the document renderer delegates vendor normalization to the typed pivot boundary", () => {
  const source = readFileSync(new URL("../site/procurement_document.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /vendorStem|vendor_stem|vendor[_-]stem/);
});

test("A8: contract-fact links are keyboard-focusable and expose their literal values", () => {
  const html = renderProcurementDocument(fixture.object, fixture.observations);
  const facts = html.match(/<dl class="node-facts">[\s\S]*?<\/dl>/)?.[0] || "";
  for (const [label, value] of [
    ["Agency", "Homeless Services"],
    ["Vendor", "BHRAGS HOME CARE CORP"],
    ["Contract ID", "CT107120258801626"],
    ["PIN / EPIN", "07124E0044001"],
  ]) {
    const cell = facts.match(new RegExp(`<dt>${label.replace("/", "\\/")}<\\/dt><dd>([\\s\\S]*?)<\\/dd>`))?.[1] || "";
    assert.match(cell, new RegExp(`<a\\b[^>]*href=`), `${label} stays an anchor with native keyboard focus`);
    assert.doesNotMatch(cell, /tabindex="-1"/i, `${label} is not removed from the keyboard order`);
    assert.match(cell, new RegExp(value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), `${label} remains the accessible link name`);
  }
});

test("unresolved parties and unsafe identifiers remain readable text", () => {
  const object = {
    ...fixture.object,
    source_observation_refs: ["city_record:unresolved"],
    identity_keys: { contract_ids: ["<script>alert(1)</script>"], epins: [] },
  };
  const observations = [{
    source_system: "city_record",
    source_observation_ref: "city_record:unresolved",
    snapshot: { agency_name: "Unreviewed Agency", vendor_name: "Vendor Unknown" },
  }];
  const html = renderProcurementDocument(object, observations);
  assert.match(html, /Unreviewed Agency/);
  assert.match(html, /Vendor Unknown/);
  assert.doesNotMatch(html, /href="\/agencies\/unreviewed-agency/);
  assert.match(html, /<dt>Contract ID<\/dt><dd>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/dd>/);
});
