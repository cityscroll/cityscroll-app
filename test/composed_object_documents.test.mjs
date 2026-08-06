import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildDistrictDigestView, buildMonitorPackView, districtDigestPath, districtDigestSubjectRef, districtPivotHref, monitorPackPath, monitorPackSubjectRef, renderComposedObjectDocument } from "../site/composed_object_documents.mjs";

const registry = JSON.parse(readFileSync(new URL("../site/data/watch_templates.json", import.meta.url), "utf8"));
const digests = JSON.parse(readFileSync(new URL("../site/data/district_weekly_digests.json", import.meta.url), "utf8"));

test("monitor packs are independently addressable typed documents", () => {
  const view = buildMonitorPackView(registry, "restaurants");
  assert.equal(monitorPackPath("restaurants"), "/following/packs/restaurants/");
  assert.equal(monitorPackSubjectRef("restaurants"), "monitor-pack:restaurants");
  assert.equal(view.kind, "monitor-pack");
  assert.ok(view.watches.length >= 2);
  const html = renderComposedObjectDocument(view);
  assert.match(html, /data-civic-object-kind="monitor-pack"/);
  assert.match(html, /data-export-class="object_identity"/);
  assert.match(html, /data-object-export="xlsx"/);
});

test("district digests preserve the canonical district identity through scope", () => {
  const view = buildDistrictDigestView(digests, "33");
  assert.equal(districtDigestPath("33"), "/districts/council/33/digest/");
  assert.equal(districtDigestSubjectRef("33"), "district-digest:council-33");
  assert.equal(view.council_district, "33");
  assert.match(districtPivotHref("33"), /council=33/);
  const html = renderComposedObjectDocument(view);
  assert.match(html, /data-civic-object-kind="district-digest"/);
  assert.match(html, /data-subject-ref="district:council-33"/);
  assert.match(html, /data-export-class="object_provenance"/);
});
