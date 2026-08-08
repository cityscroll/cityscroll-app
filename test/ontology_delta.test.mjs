import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DIMENSION_LABELS,
  ONTOLOGY_DELTA_COPY,
  ONTOLOGY_DELTA_METHOD,
  ONTOLOGY_DELTA_SCHEMA,
  ONTOLOGY_DELTA_SHARE_PATH,
  buildOntologyDeltaLookup,
  diffInventories,
  extractGraphInventory,
  normalizeInventory,
  renderOntologyDeltaDocument,
} from "../site/ontology_delta.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "site/data/ontology_inventory_baseline.json");
const LOOKUP = join(ROOT, "site/data/ontology_delta_lookup.json");
const DOC = join(ROOT, "site/graph/ontology-delta/index.html");

const DISCLAIMERSLOP = /not\s+(?:just|only|merely|simply)\s+.+\s+but\b|this is not\b|we do not claim\b|may not be complete\b|disclaimer\b|experimental\b|beta feature\b|please note that\b/i;

function fixtureSources() {
  return {
    entityIntelligence: {
      generated_at: "2026-08-06T19:05:45.517Z",
      version: "cross_domain_object_link_v2",
      entity_count: 3,
      domains: ["money", "land", "franchise"],
      by_ref: {
        "agency:id:parks-and-recreation": {
          root: {
            kind: "agency",
            ref: "agency:id:parks-and-recreation",
            canonical_id: "parks-and-recreation",
            display_name: "Parks and Recreation",
          },
          links: [
            { type: "published_by_agency" },
            { type: "paid_to_vendor" },
            { type: "corroborates_contract" },
          ],
          domains: {
            money: {
              status: "matched",
              objects: [
                { object_kind: "award" },
                { object_kind: "contract" },
                { object_kind: "payment" },
              ],
            },
            land: {
              status: "matched",
              objects: [{ object_kind: "project" }],
            },
          },
        },
        "agency:id:new-agency-demo": {
          root: {
            kind: "agency",
            ref: "agency:id:new-agency-demo",
            canonical_id: "new-agency-demo",
            display_name: "New Agency Demo",
          },
          links: [{ type: "hosts_meeting" }],
          domains: {
            meetings: {
              status: "matched",
              objects: [{ object_kind: "hearing" }],
            },
          },
        },
        "vendor:stem:acme": {
          root: { kind: "vendor", display_name: "Acme" },
          links: [{ type: "named_vendor" }],
          domains: { money: { status: "matched", objects: [{ object_kind: "award" }] } },
        },
      },
    },
    constellation: {
      generated_at: "2026-08-07T00:00:00Z",
      agency_count: 2,
      by_id: {
        "parks-and-recreation": {
          display_name: "Parks and Recreation",
          categories: {
            contracts: { status: "matched", count: 3 },
            meetings: { status: "empty", count: 0 },
            rules: { status: "empty", count: 0 },
            obligations: { status: "matched", count: 5 },
            staffing: { status: "matched", count: 2 },
          },
        },
      },
    },
    obligations: {
      generated_at: "2026-08-07T12:00:00Z",
      summary: { agency_count: 1 },
      by_agency: {
        "parks-and-recreation": {
          agency_name: "Parks and Recreation",
          obligations: [
            { deliverable_type: "rulemaking" },
            { deliverable_type: "report" },
            { deliverable_type: "program" },
          ],
        },
      },
    },
  };
}

const slimBaseline = {
  schema: "cityscroll.ontology_inventory.v1",
  role: "baseline",
  label: "fixture_baseline",
  as_of: "2026-08-02T00:00:00Z",
  root_kinds: ["agency"],
  domains: ["money", "land"],
  object_kinds: ["award", "project", "hearing"],
  edge_types: ["published_by_agency", "hosts_meeting"],
  agency_ids: ["parks-and-recreation"],
  agencies: [{ id: "parks-and-recreation", display_name: "Parks and Recreation" }],
  constellation_categories: [],
  deliverable_types: [],
};

test("extractGraphInventory collects kinds, edges, agencies, categories, deliverables", () => {
  const inv = extractGraphInventory(fixtureSources());
  assert.ok(inv.root_kinds.includes("agency"));
  assert.ok(inv.root_kinds.includes("vendor"));
  assert.ok(inv.domains.includes("franchise"));
  assert.ok(inv.object_kinds.includes("contract"));
  assert.ok(inv.object_kinds.includes("payment"));
  assert.ok(inv.edge_types.includes("paid_to_vendor"));
  assert.ok(inv.edge_types.includes("corroborates_contract"));
  assert.ok(inv.agency_ids.includes("new-agency-demo"));
  assert.ok(inv.constellation_categories.includes("obligations"));
  assert.ok(inv.constellation_categories.includes("staffing"));
  assert.ok(inv.deliverable_types.includes("rulemaking"));
  assert.equal(inv.vendor_count, 1);
});

test("diffInventories reports only additions present now", () => {
  const current = extractGraphInventory(fixtureSources());
  const delta = diffInventories(slimBaseline, current);
  assert.equal(delta.schema, ONTOLOGY_DELTA_SCHEMA);
  assert.equal(delta.method, ONTOLOGY_DELTA_METHOD);
  assert.equal(delta.share_path, ONTOLOGY_DELTA_SHARE_PATH);
  assert.ok(delta.has_deltas);

  const edgeIds = delta.added.edge_types.map((x) => x.id);
  assert.ok(edgeIds.includes("paid_to_vendor"));
  assert.ok(edgeIds.includes("corroborates_contract"));
  assert.ok(!edgeIds.includes("published_by_agency"));

  const kindIds = delta.added.object_kinds.map((x) => x.id);
  assert.ok(kindIds.includes("contract"));
  assert.ok(kindIds.includes("payment"));
  assert.ok(!kindIds.includes("award"));

  const agencyIds = delta.added.agencies.map((x) => x.id);
  assert.ok(agencyIds.includes("new-agency-demo"));
  assert.ok(!agencyIds.includes("parks-and-recreation"));

  assert.ok(delta.added.constellation_categories.some((x) => x.id === "obligations"));
  assert.ok(delta.added.deliverable_types.some((x) => x.id === "rulemaking"));
  assert.ok(delta.added.root_kinds.some((x) => x.id === "vendor"));
  assert.ok(delta.added.domains.some((x) => x.id === "franchise"));
});

test("diffInventories does not invent deltas when inventories match", () => {
  const inv = extractGraphInventory(fixtureSources());
  const delta = diffInventories(inv, inv);
  assert.equal(delta.total_added, 0);
  assert.equal(delta.has_deltas, false);
  for (const items of Object.values(delta.added)) {
    assert.equal(items.length, 0);
  }
});

test("renderOntologyDeltaDocument paints deltas without disclaimerslop", () => {
  const lookup = buildOntologyDeltaLookup({
    baseline: slimBaseline,
    ...fixtureSources(),
    generatedAt: "2026-08-06T19:05:45.517Z",
  });
  const html = renderOntologyDeltaDocument(lookup);
  assert.match(html, /id="ontology-delta"/);
  assert.match(html, /data-has-deltas="1"/);
  assert.match(html, /What's new in the graph|What&apos;s new in the graph|What&#39;s new in the graph/);
  assert.match(html, /Paid to a vendor|paid_to_vendor/);
  assert.match(html, /New Agency Demo/);
  assert.match(html, /href="\/agencies\/new-agency-demo\/"/);
  assert.match(html, /canonical" href="\/graph\/ontology-delta\/"/);
  assert.doesNotMatch(html, DISCLAIMERSLOP);
  // Machine subject_ref must not print as body text.
  assert.doesNotMatch(html, />agency:id:/);
  assert.ok(Object.keys(DIMENSION_LABELS).length >= 5);
  assert.ok(ONTOLOGY_DELTA_COPY.lead.length > 20);
});

test("normalizeInventory accepts agency_ids without full agency rows", () => {
  const inv = normalizeInventory({
    agency_ids: ["finance", "buildings"],
    edge_types: ["issued_rule"],
  });
  assert.deepEqual(inv.agency_ids, ["buildings", "finance"]);
  assert.equal(inv.agencies.length, 2);
  assert.deepEqual(inv.edge_types, ["issued_rule"]);
});

test("committed baseline + built artifacts exist and show real deltas", () => {
  assert.ok(existsSync(BASELINE), "baseline inventory must be committed");
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  assert.equal(baseline.schema, "cityscroll.ontology_inventory.v1");
  assert.ok(baseline.agency_ids?.length > 0);
  assert.ok(baseline.edge_types?.length > 0);

  // Prefer built artifacts when present (local build / CI).
  if (existsSync(LOOKUP) && existsSync(DOC)) {
    const lookup = JSON.parse(readFileSync(LOOKUP, "utf8"));
    assert.equal(lookup.schema, ONTOLOGY_DELTA_SCHEMA);
    assert.equal(lookup.share_path, ONTOLOGY_DELTA_SHARE_PATH);
    assert.ok(lookup.total_added > 0, "live data should surface structural growth vs franchise-era baseline");
    assert.ok(lookup.added?.edge_types?.length || lookup.added?.agencies?.length || lookup.added?.object_kinds?.length);

    const html = readFileSync(DOC, "utf8");
    assert.match(html, /id="ontology-delta"/);
    assert.match(html, /data-has-deltas="1"/);
    assert.doesNotMatch(html, DISCLAIMERSLOP);
    assert.match(html, /Relationship types|Object kinds|Agencies in the graph/);
  }
});
