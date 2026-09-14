import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  procurementIdentifierSearchHref,
  renderProcurementDocument,
} from "../site/procurement_document.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url)));

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
