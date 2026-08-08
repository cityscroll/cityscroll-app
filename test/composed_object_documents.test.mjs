import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildDistrictDigestView, buildMonitorPackView, buildParcelBiographyView, districtDigestPath, districtDigestSubjectRef, districtPivotHref, monitorPackPath, monitorPackSubjectRef, parcelPath, parcelSectionLabel, renderComposedObjectDocument } from "../site/composed_object_documents.mjs";

const registry = JSON.parse(readFileSync(new URL("../site/data/watch_templates.json", import.meta.url), "utf8"));
const digests = JSON.parse(readFileSync(new URL("../site/data/district_weekly_digests.json", import.meta.url), "utf8"));
const crossDomain = JSON.parse(readFileSync(new URL("../site/data/property_cross_domain_lookup.json", import.meta.url), "utf8"));
const taxLien = JSON.parse(readFileSync(new URL("../site/data/tax_lien_sale_bbl.json", import.meta.url), "utf8"));
const cofo = JSON.parse(readFileSync(new URL("../site/data/dob_cofo_lookup.json", import.meta.url), "utf8"));

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

test("parcel biographies are complete civic-object documents with exact-BBL watches", () => {
  const bbl = Object.keys(crossDomain.by_bbl).find((id) => cofo.by_bbl[id]);
  const view = buildParcelBiographyView({ bbl, crossDomain, taxLien, cofo });
  assert.equal(parcelPath(bbl), `/parcels/${bbl}/`);
  assert.equal(view.kind, "parcel");
  assert.deepEqual(view.sections && Object.keys(view.sections), ["property", "land", "ll48", "tax_lien", "cofo"]);
  const html = renderComposedObjectDocument(view);
  assert.match(html, /rel="canonical" href="https:\/\/cityscroll\.org\/parcels\/\d{10}\//);
  assert.match(html, /lens=property/);
  // Watch filter is URL-encoded in the href (colon → %3A).
  assert.match(html, new RegExp(`subject_refs_all(?:.|\\n)*?bbl(?:%3A|:)${bbl}`));
  assert.match(html, /reader-friendly record of public information connected with this parcel/);
  assert.match(html, /public records that name this exact parcel/);
  assert.match(html, /data-export-class="object_identity"/);
  assert.match(html, /data-export-class="object_actions"/);
  assert.match(html, /data-export-class="object_members"/);
  assert.match(html, /data-export-class="object_provenance"/);
  assert.match(html, /href="#land\/[A-Za-z0-9_-]+"/);
  assert.doesNotMatch(html, /#land\?project=/);
  // Shared node-page layout (same grammar as exam documents).
  assert.match(html, /class="node-document civic-object-document"/);
  assert.match(html, /class="node-hero civic-object-hero"/);
  assert.match(html, /class="[^"]*node-actions/);
  assert.match(html, /class="[^"]*node-action[^"]*primary/);
  assert.match(html, /data-node-document="1"/);
  // Each source group is its own labeled card; ll48 must not reuse "Land projects".
  assert.match(html, /data-parcel-biography-domain="land"[^>]*>[\s\S]*?<h2>Land projects<\/h2>/);
  assert.match(html, /data-parcel-biography-domain="ll48"[^>]*>[\s\S]*?<h2>City-owned or leased property suitability<\/h2>/);
  const landHeadings = html.match(/>Land projects</g) || [];
  assert.equal(landHeadings.length, 1, "Land projects section must appear exactly once");
  assert.equal(parcelSectionLabel("ll48"), "City-owned or leased property suitability");
  assert.equal(parcelSectionLabel("land"), "Land projects");
  assert.equal(parcelSectionLabel("unknown"), null);
});
