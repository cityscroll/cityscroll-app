/**
 * Offered-facet-actually-filters detector.
 *
 * Catches the class of bug where a Browse lens (or agency constellation
 * section link) *offers* a scope that does not actually narrow results —
 * meetings borough (#676) and staffing agency (this fix) are field cases.
 *
 * For each offered agency scope on each registered Browse lens:
 *   (a) when the unfiltered set demonstrably contains the scope, filtered
 *       results are a non-empty strict subset;
 *   (b) every remaining row carries the claimed agency edge.
 *
 * Also covers agency-profile "Notices by section → filtered to this agency"
 * hrefs: each must resolve to a lens+facet that genuinely filters.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import { BROWSE_FACETS, buildBrowseView } from "../site/browse_view.mjs";
import {
  hireMatchesAgencyScope,
} from "../site/staffing_agency_scope.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

const BY_FACET_SOURCE = {
  contracts: "site/data/money_default_open.json",
  staffing: "site/data/staffing_default_hires.json",
  zoning: "site/data/land_default_ulurp.json",
  property: "site/data/property_domain_observations.json",
  rules: "site/data/rules_domain_observations.json",
  meetings: "site/data/meetings_domain_observations.json",
};

const BY_FACET_AGENCY_FIELDS = {
  contracts: ["agency_name"],
  staffing: ["agency_name"],
  zoning: ["primary_applicant", "agency_name"],
  property: ["agency_name"],
  rules: ["agency_name"],
  meetings: ["agency_name"],
};

function readPayload(facet) {
  return JSON.parse(fs.readFileSync(BY_FACET_SOURCE[facet], "utf8"));
}

function rowsForFacet(payload, facet) {
  const key = BROWSE_FACETS[facet].rowsKey;
  return Array.isArray(payload?.[key]) ? payload[key] : [];
}

function rowAgencyId(facet, row) {
  for (const field of BY_FACET_AGENCY_FIELDS[facet]) {
    const value = String(row?.[field] || "").trim();
    if (!value) continue;
    const id = resolveAgencyIdentity(value).canonical_id;
    if (id) return id;
  }
  return "";
}

function agenciesPresentInRows(facet, rows) {
  const counts = new Map();
  for (const row of rows) {
    const id = rowAgencyId(facet, row);
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function facetParams(agencyId) {
  return new URLSearchParams({
    facet: JSON.stringify({ entity_refs_all: [`agency:id:${agencyId}`] }),
  });
}

test("offered-facet-actually-filters: every Browse lens narrows when the fixture contains the agency", () => {
  const failures = [];
  for (const facet of Object.keys(BROWSE_FACETS)) {
    const payload = readPayload(facet);
    const rows = rowsForFacet(payload, facet);
    assert.ok(rows.length > 0, `${facet} fixture has rows`);
    const present = agenciesPresentInRows(facet, rows);
    assert.ok(present.size > 0, `${facet} fixture has at least one agency edge`);

    // Sample up to three agencies present in the unfiltered set.
    const sample = [...present.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    for (const [agencyId, unfilteredCount] of sample) {
      // The unfiltered set demonstrably contains this scope.
      assert.ok(unfilteredCount > 0 && unfilteredCount <= rows.length);

      const view = buildBrowseView(facet, payload, facetParams(agencyId), { limit: 10_000 });
      if (view.total === 0) {
        failures.push(`${facet}/${agencyId}: filtered to 0 though unfiltered had ${unfilteredCount}`);
        continue;
      }
      if (view.total >= rows.length) {
        failures.push(`${facet}/${agencyId}: filtered total ${view.total} is not a strict subset of ${rows.length}`);
        continue;
      }
      if (view.scope.mode !== "applied") {
        failures.push(`${facet}/${agencyId}: expected scope mode applied, got ${view.scope.mode}`);
      }
      const foreign = view.rows.filter((row) => rowAgencyId(facet, row) !== agencyId);
      if (foreign.length) {
        failures.push(`${facet}/${agencyId}: ${foreign.length} rows lack the claimed agency edge`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("offered-facet-actually-filters: meetings borough scope still narrows (field case #676)", () => {
  const payload = {
    rows: [
      {
        request_id: "parks-brooklyn",
        agency_name: "Parks and Recreation",
        short_title: "Seasonal ice rink at McCarren Park Pool, Brooklyn",
        event_date: "2026-08-10",
        affected_area: { scope: "local", boroughs: ["Brooklyn"] },
      },
      {
        request_id: "parks-queens",
        agency_name: "Parks and Recreation",
        short_title: "Queens recreation hearing",
        event_date: "2026-08-12",
        affected_area: { scope: "local", boroughs: ["Queens"] },
      },
    ],
  };
  const facet = JSON.stringify({ entity_refs_all: ["agency:id:parks-and-recreation"] });
  const all = buildBrowseView("meetings", payload, new URLSearchParams({ when: "all", facet }), { limit: 1000 });
  assert.equal(all.total, 2);
  const brooklyn = buildBrowseView(
    "meetings",
    payload,
    new URLSearchParams({ when: "all", boro: "Brooklyn", facet }),
    { limit: 1000 },
  );
  assert.ok(brooklyn.total > 0, "borough present in unfiltered set must not collapse to zero");
  assert.ok(brooklyn.total < all.total, "borough scope must be a strict subset");
  assert.deepEqual(brooklyn.rows.map((row) => row.request_id), ["parks-brooklyn"]);
});

test("offered-facet-actually-filters: staffing Parks agency scope filters appointments (field case)", () => {
  // Citywide default hires often omit Parks; the offered scope must still filter
  // a mixed corpus that includes the published personnel spelling.
  const notices = Staffing.hireNotices([
    {
      request_id: "parks-a",
      start_date: "2026-04-24T00:00:00.000",
      agency_name: "DEPT OF PARKS & RECREATION",
      additional_description_1:
        "Effective Date: 04/20/2026; Provisional Status: No; Title Code: 81310; Reason For Change: APPOINTED; Salary: 50000.00; Employee Name: A,PARKS",
    },
    {
      request_id: "parks-b",
      start_date: "2026-04-23T00:00:00.000",
      agency_name: "DEPT OF PARKS & RECREATION",
      additional_description_1:
        "Effective Date: 04/19/2026; Provisional Status: No; Title Code: 81310; Reason For Change: APPOINTED; Salary: 51000.00; Employee Name: B,PARKS",
    },
    {
      request_id: "pd-a",
      start_date: "2026-04-25T00:00:00.000",
      agency_name: "POLICE DEPARTMENT",
      additional_description_1:
        "Effective Date: 04/21/2026; Provisional Status: No; Title Code: 70210; Reason For Change: APPOINTED; Salary: 60000.00; Employee Name: A,PD",
    },
  ], []);
  const agency = resolveAgencyIdentity("parks-and-recreation").canonical_name;
  const filtered = Staffing.filterHireNotices(notices, {
    agency,
    agencyMatch: (name) => hireMatchesAgencyScope(name, agency),
  });
  assert.ok(filtered.length > 0, "Parks appointments present in the unfiltered set must remain");
  assert.ok(filtered.length < notices.length, "Parks scope must be a strict subset");
  assert.ok(filtered.every((row) => hireMatchesAgencyScope(row.agency, agency)));
});

test("offered-facet-actually-filters: agency section chips target Browse facets that filter", () => {
  const entities = fs.readFileSync(new URL("../site/app/entities.mjs", import.meta.url), "utf8");
  // Section links must use document Browse + entity_refs_all (not bare #people?agency=).
  assert.match(entities, /data-agency-section-scope/);
  assert.match(entities, /entity_refs_all/);
  assert.match(entities, /\/browse\/\$\{browse\}\//);

  // For each lens whose fixture contains a known agency, the Browse view must
  // honor the same facet the section chip mints.
  const targets = [
    { facet: "contracts", agencyId: null },
    { facet: "meetings", agencyId: null },
    { facet: "rules", agencyId: null },
    { facet: "staffing", agencyId: null },
  ];
  for (const target of targets) {
    const payload = readPayload(target.facet);
    const rows = rowsForFacet(payload, target.facet);
    const present = agenciesPresentInRows(target.facet, rows);
    if (!present.size) continue;
    const [agencyId, count] = [...present.entries()].sort((a, b) => b[1] - a[1])[0];
    target.agencyId = agencyId;
    const view = buildBrowseView(target.facet, payload, facetParams(agencyId), { limit: 10_000 });
    assert.ok(count > 0);
    assert.equal(view.scope.mode, "applied", `${target.facet} section-chip facet applies`);
    assert.ok(view.total > 0, `${target.facet} section-chip facet non-empty`);
    assert.ok(view.total < rows.length, `${target.facet} section-chip facet is a strict subset`);
  }
});
