import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  BROWSE_FACETS,
  buildBrowseView,
  renderBrowseView,
} from "../site/browse_view.mjs";
import { resolveAgencyIdentity } from "../site/agency_identity.mjs";

const BY_FACET_FIELD = {
  contracts: ["agency_name"],
  staffing: ["agency_name"],
  zoning: ["primary_applicant", "agency_name"],
  property: ["agency_name"],
  rules: ["agency_name"],
  meetings: ["agency_name"],
};

const BY_FACET_SOURCE = {
  contracts: "site/data/money_default_open.json",
  staffing: "site/data/staffing_default_hires.json",
  zoning: "site/data/land_default_ulurp.json",
  property: "site/data/property_domain_observations.json",
  rules: "site/data/rules_domain_observations.json",
  meetings: "site/data/meetings_domain_observations.json",
};

function readPayload(facet) {
  return JSON.parse(fs.readFileSync(BY_FACET_SOURCE[facet], "utf8"));
}

function rowsForFacet(payload, facet) {
  return Array.isArray(payload?.[BROWSE_FACETS[facet].rowsKey]) ? payload[BROWSE_FACETS[facet].rowsKey] : [];
}

function canonicalAgencyFromRows(facet, rows) {
  const fields = BY_FACET_FIELD[facet];
  for (const row of rows) {
    for (const field of fields) {
      const value = String(row?.[field] || "").trim();
      if (!value) continue;
      return resolveAgencyIdentity(value).canonical_id;
    }
  }
  return "";
}

function countRowsByAgency(rows, facet, agencyId) {
  const fields = BY_FACET_FIELD[facet];
  let matches = 0;
  for (const row of rows) {
    for (const field of fields) {
      const canonical = resolveAgencyIdentity(String(row?.[field] || "")).canonical_id;
      if (canonical === agencyId) {
        matches += 1;
        break;
      }
    }
  }
  return matches;
}

function facetSearchParams(agencyId, extra = {}) {
  const params = new URLSearchParams(extra);
  params.set("facet", JSON.stringify({ entity_refs_all: [`agency:id:${agencyId}`] }));
  return params;
}

function scopeChip(href) {
  return href.match(/href="([^"]+)" class="x-remove-scope"/);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("browse scope conformance: every registered lens filters when given fixture agency scope", () => {
  for (const facet of Object.keys(BROWSE_FACETS)) {
    const payload = readPayload(facet);
    const rows = rowsForFacet(payload, facet);
    const agencyId = canonicalAgencyFromRows(facet, rows);
    assert.ok(agencyId, `${facet} has at least one agency value`);

    const params = facetSearchParams(agencyId);
    const view = buildBrowseView(facet, payload, params, { limit: 1000 });
    const expected = countRowsByAgency(rows, facet, agencyId);

    assert.equal(view.scope.hasScopeFacet, true, `${facet} has scope facet`);
    assert.equal(view.scope.mode, expected > 0 ? "applied" : "empty", `${facet} scope mode`);
    assert.equal(view.total, expected, `${facet} scope filter count matches precomputed scope`);

    const html = renderBrowseView(view);
    const match = scopeChip(html);
    assert.ok(match, `${facet} renders scope chip`);
    const removed = new URLSearchParams(new URL(`https://cityscroll.org/${match[1]}`).search);
    assert.equal(removed.has("facet"), false, `${facet} remove keeps non-scope filters only`);

    if (view.scope.mode === "applied") {
      const label = resolveAgencyIdentity(agencyId).canonical_name;
      assert.match(html, new RegExp(`Filtered to ${escapeRegExp(label)}`));
    } else {
      assert.match(html, /No records in this lens match/);
    }
  }
});

test("contracts conformance: a three-way typed scope is an all-ref intersection with removable chips", () => {
  const payload = {
    open_as_of: "2026-08-05",
    notices: [
      {
        request_id: "triple",
        agency_name: "Housing Preservation and Development",
        short_title: "Timbale Terrace services",
        entity_refs_all: [
          "project:2022M0258",
          "agency:id:housing-preservation-and-development",
          "vendor:stem:MAKE%20IT%20ZESTY",
        ],
      },
      {
        request_id: "agency-vendor",
        agency_name: "Housing Preservation and Development",
        short_title: "Vendor contract under the agency",
        entity_refs_all: [
          "agency:id:housing-preservation-and-development",
          "vendor:stem:MAKE%20IT%20ZESTY",
        ],
      },
      {
        request_id: "agency-project",
        agency_name: "Housing Preservation and Development",
        short_title: "Project record under the agency",
        entity_refs_all: [
          "project:2022M0258",
          "agency:id:housing-preservation-and-development",
        ],
      },
      {
        request_id: "project-vendor",
        agency_name: "Other agency",
        short_title: "Vendor work on the project",
        entity_refs_all: [
          "project:2022M0258",
          "vendor:stem:MAKE%20IT%20ZESTY",
        ],
      },
    ],
  };
  const refs = [
    "project:2022M0258",
    "agency:id:housing-preservation-and-development",
    "vendor:stem:MAKE%20IT%20ZESTY",
  ];
  const params = new URLSearchParams({ facet: JSON.stringify({ entity_refs_all: refs }) });
  const view = buildBrowseView("contracts", payload, params, { limit: 1000 });

  assert.equal(view.total, 1, "only the row carrying all three edges matches");
  assert.equal(view.scope.mode, "applied");
  assert.deepEqual(view.scope.refs.map((item) => item.ref).sort(), refs.sort());

  const html = renderBrowseView(view);
  const chips = [...html.matchAll(/href="([^"]+)" class="x-remove-scope"/g)];
  assert.equal(chips.length, 3, "each typed constraint gets its own removable chip");
  for (const [, href] of chips) {
    const removed = new URLSearchParams(new URL(href, "https://cityscroll.org").search);
    const remaining = JSON.parse(removed.get("facet")).entity_refs_all;
    assert.equal(remaining.length, 2, "removing one chip leaves a valid two-way scope");
    const roundTrip = buildBrowseView("contracts", payload, removed, { limit: 1000 });
    assert.equal(roundTrip.scope.mode, "applied");
    assert.equal(roundTrip.total, 2);
  }
});

test("captain six scope URLs with DCWP exhibit explicit scope/empty state by lens", () => {
  const target = "consumer-and-worker-protection";
  const targetName = resolveAgencyIdentity(target).canonical_name;
  for (const facet of Object.keys(BROWSE_FACETS)) {
    const payload = readPayload(facet);
    const rows = rowsForFacet(payload, facet);
    const expected = countRowsByAgency(rows, facet, target);
    const params = new URLSearchParams({
      agency: targetName,
      facet: JSON.stringify({ entity_refs_all: [`agency:id:${target}`] }),
    });
    const view = buildBrowseView(facet, payload, params, { limit: 1000 });
    const html = renderBrowseView(view);

    if (expected > 0) {
      assert.equal(view.scope.mode, "applied", `${facet} applies DCWP scope when matches are present`);
      assert.equal(view.total, expected, `${facet} DCWP scope count is bounded correctly`);
    } else {
      assert.equal(view.scope.mode, "empty", `${facet} explicitly shows empty scope state`);
      assert.equal(view.total, 0, `${facet} DCWP scope has no matching rows`);
      assert.match(html, new RegExp(`No records in this lens match ${targetName}\.`));
    }

    const match = scopeChip(html);
    assert.ok(match, `${facet} includes active scope chip`);
  }
});

test("unsupported facet kinds stay honest and do not claim active filtering", () => {
  const payload = readPayload("contracts");
  const params = new URLSearchParams({ facet: JSON.stringify({ entity_refs_all: ["vendor:stem:sample-vendor"] }) });
  const rows = rowsForFacet(payload, "contracts");
  const view = buildBrowseView("contracts", payload, params, { limit: 1000 });

  assert.equal(view.scope.mode, "unsupported", "contracts does not apply unsupported vendor scope kind");
  assert.equal(view.total, rows.length, "unsupported scope keeps contract rows visible");

  const html = renderBrowseView(view);
  assert.match(html, /does not support this scope filter/);
  assert.ok(!/Filtered to/.test(html));
});

test("legacy agency URLs normalize to the same filtered view as canonical facet URLs", () => {
  const payload = readPayload("contracts");
  const rows = rowsForFacet(payload, "contracts");
  const agency = String(rows[0].agency_name);
  const id = resolveAgencyIdentity(agency).canonical_id;
  const legacy = new URLSearchParams({ agency });
  const canonical = new URLSearchParams({ facet: JSON.stringify({ entity_refs_all: [`agency:id:${id}`] }) });
  const legacyView = buildBrowseView("contracts", payload, legacy, { limit: 1000 });
  const canonicalView = buildBrowseView("contracts", payload, canonical, { limit: 1000 });
  assert.equal(legacyView.total, canonicalView.total);
  assert.deepEqual(legacyView.rows.map((row) => row.request_id), canonicalView.rows.map((row) => row.request_id));
  assert.equal(legacyView.scope.mode, "applied");
  assert.equal(canonicalView.scope.mode, "applied");
});
