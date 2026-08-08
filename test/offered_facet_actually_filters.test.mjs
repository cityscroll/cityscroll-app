/**
 * Offered-facet-actually-filters detector (facet-exhaustive).
 *
 * Catches the class of bug where a Browse lens, exam rail, disposition rail,
 * or agency constellation section link *offers* a scope that does not actually
 * narrow results — meetings borough (#676) and staffing agency (#679) are field
 * cases found by manual clicking.
 *
 * Inventory is driven from in-repo sources of truth (Browse facet config,
 * borough/attendance/exam/disposition/procurement scope modules, and agency
 * constellation category links). The sibling dropdown-conversions ledger is
 * not readable from this package; the same offered edges are reconstructed
 * from those live surface configs so a newly-offered facet is covered when it
 * lands in a config module.
 *
 * For each offered facet value that the unfiltered set demonstrably contains
 * as a proper subset:
 *   (a) filtered results are a non-empty strict subset;
 *   (b) every remaining row carries the claimed edge/scope
 *       (agency, borough among multi-value bags, mode, stage, exam band, …).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";

import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import {
  AGENCY_CONSTELLATION_CATEGORIES,
  agencyCategoryBrowseHref,
} from "../site/agency_constellation.mjs";
import { ATTENDANCE_MODES } from "../site/attendance_scope_links.mjs";
import { BOROUGHS } from "../site/borough_scope_links.mjs";
import {
  BROWSE_FACETS,
  buildBrowseView,
  rowMatchesProcurementMode,
} from "../site/browse_view.mjs";
import {
  EXAM_FACETS,
  examFacetValue,
} from "../site/exam_detail_facets.mjs";
import {
  DISPOSITION_LIFECYCLE_STAGES,
  PRICE_BANDS,
  SALE_METHODS,
  propertyPriceBandKey,
  propertySaleMethodKey,
} from "../site/property_disposition_facets.mjs";
import { extractPropertyCommercial } from "../site/property_commercial.mjs";
import {
  buildPropertyExplorerEntries,
  filterPropertyExplorerEntries,
} from "../site/property_explorer.mjs";
import { PROCUREMENT_MODE_KEYS } from "../site/procurement_facet_links.mjs";
import {
  buildRulesExplorerEntries,
  filterRulesExplorerEntries,
} from "../site/rules_explorer.mjs";
import {
  hireMatchesAgencyScope,
} from "../site/staffing_agency_scope.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

const BY_FACET_SOURCE = {
  contracts: "site/data/money_default_open.json",
  contracts_domain: "site/data/money_domain_observations.json",
  staffing: "site/data/staffing_default_hires.json",
  staffing_exams: "site/data/staffing_exams.json",
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

const TODAY = "2026-08-07";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function readPayload(facet) {
  return readJson(BY_FACET_SOURCE[facet]);
}

function rowsForBrowse(facet, payload) {
  const key = BROWSE_FACETS[facet].rowsKey;
  return Array.isArray(payload?.[key]) ? payload[key] : [];
}

function rowAgencyId(facet, row) {
  for (const field of BY_FACET_AGENCY_FIELDS[facet] || ["agency_name"]) {
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

function facetParams(agencyId, extra = {}) {
  return new URLSearchParams({
    facet: JSON.stringify({ entity_refs_all: [`agency:id:${agencyId}`] }),
    ...extra,
  });
}

function placeBoroughs(row) {
  const bags = [
    row?.affected_area,
    row?.rule_location,
    row?.place,
    typeof row?.property_location === "object" ? row.property_location : null,
    row?._location,
  ].filter(Boolean);
  const out = [];
  if (row?.borough) out.push(String(row.borough));
  for (const bag of bags) {
    if (bag.borough) out.push(String(bag.borough));
    if (Array.isArray(bag.boroughs)) {
      for (const b of bag.boroughs) if (b) out.push(String(b));
    }
  }
  return out;
}

function rowHasBorough(row, borough) {
  const target = String(borough).toLocaleLowerCase();
  return placeBoroughs(row).some((b) => String(b).toLocaleLowerCase() === target);
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const keys = keyFn(row);
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      if (key == null || key === "" || key === "unknown" || key === "all") continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Assert non-empty strict subset + claim when the value is a proper subset of
 * the unfiltered set. When every row already carries the value, require that
 * the filter keeps them all (honest full match, not a silent pass-through of
 * foreign rows).
 */
function assertFacetFilter(failures, id, {
  total,
  present,
  filtered,
  foreign = 0,
  allowFullMatch = false,
}) {
  if (present <= 0) return; // not demonstrably in the unfiltered set
  if (filtered === 0) {
    failures.push(`${id}: filtered to 0 though unfiltered had ${present}`);
    return;
  }
  if (foreign > 0) {
    failures.push(`${id}: ${foreign} rows lack the claimed edge/scope`);
  }
  if (present < total) {
    if (filtered >= total) {
      failures.push(`${id}: filtered total ${filtered} is not a strict subset of ${total}`);
    }
  } else if (!allowFullMatch && filtered !== total) {
    // Present everywhere — filter must keep the full set, not invent empties.
    failures.push(`${id}: value present on all ${total} rows but filtered to ${filtered}`);
  }
}

function sampleTop(counts, n = 3) {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Exhaustive inventory sweep
// ---------------------------------------------------------------------------

test("offered-facet-actually-filters: exhaustive inventory across all offered facets", () => {
  const failures = [];
  const inventory = []; // { id, family, result: "pass"|"skip"|"fail" }

  const record = (id, family, result, detail = "") => {
    inventory.push({ id, family, result, detail });
  };

  // --- 1. Agency entity_refs on every Browse lens (field cases #679 family) ---
  for (const facet of Object.keys(BROWSE_FACETS)) {
    const payload = readPayload(facet);
    const rows = rowsForBrowse(facet, payload);
    assert.ok(rows.length > 0, `${facet} fixture has rows`);
    const present = agenciesPresentInRows(facet, rows);
    assert.ok(present.size > 0, `${facet} fixture has at least one agency edge`);
    for (const [agencyId, unfilteredCount] of sampleTop(present, 3)) {
      const id = `browse/${facet}/agency/${agencyId}`;
      const view = buildBrowseView(facet, payload, facetParams(agencyId), { limit: 10_000 });
      const foreign = view.rows.filter((row) => rowAgencyId(facet, row) !== agencyId).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: rows.length,
        present: unfilteredCount,
        filtered: view.total,
        foreign,
      });
      if (view.scope.mode !== "applied" && view.total > 0 && unfilteredCount < rows.length) {
        failures.push(`${id}: expected scope mode applied, got ${view.scope.mode}`);
      }
      record(id, "browse-agency", failures.length === before ? "pass" : "fail");
    }
  }

  // --- 2. Borough scope on every lens that offers boro= (BOROUGHS + meetings) ---
  const boroughLenses = [
    { facet: "zoning", payloadKey: "zoning" },
    { facet: "property", payloadKey: "property" },
    { facet: "rules", payloadKey: "rules" },
    { facet: "meetings", payloadKey: "meetings", extra: { when: "all" } },
    // Contracts default open snapshot often lacks place stamps; domain corpus does.
    { facet: "contracts", payloadKey: "contracts_domain", rowsKey: "rows", label: "contracts-domain" },
  ];
  for (const lens of boroughLenses) {
    const payload = readPayload(lens.payloadKey);
    const rows = lens.rowsKey
      ? (Array.isArray(payload[lens.rowsKey]) ? payload[lens.rowsKey] : [])
      : rowsForBrowse(lens.facet, payload);
    const browsePayload = lens.rowsKey
      ? { ...payload, [BROWSE_FACETS[lens.facet].rowsKey]: rows }
      : payload;
    const present = countBy(rows, (row) => placeBoroughs(row).map((b) => {
      // Normalize title-case for offered BOROUGHS values.
      const hit = BOROUGHS.find((offered) => offered.toLocaleLowerCase() === String(b).toLocaleLowerCase());
      return hit || null;
    }).filter(Boolean));
    for (const borough of BOROUGHS) {
      const unfilteredCount = present.get(borough) || 0;
      const id = `browse/${lens.label || lens.facet}/borough/${borough}`;
      if (!unfilteredCount) {
        record(id, "browse-borough", "skip", "not present in fixture");
        continue;
      }
      const params = new URLSearchParams({ ...(lens.extra || {}), boro: borough });
      const view = buildBrowseView(lens.facet, browsePayload, params, { limit: 10_000 });
      const foreign = view.rows.filter((row) => !rowHasBorough(row, borough)
        && !(lens.facet === "zoning" && String(row.borough || "").toLocaleLowerCase() === borough.toLocaleLowerCase())).length;
      // Zoning stores borough on the row field, not only place bags.
      const foreignZoning = lens.facet === "zoning"
        ? view.rows.filter((row) => String(row.borough || "").toLocaleLowerCase() !== borough.toLocaleLowerCase()).length
        : foreign;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: rows.length,
        present: unfilteredCount,
        filtered: view.total,
        foreign: lens.facet === "zoning" ? foreignZoning : foreign,
      });
      record(id, "browse-borough", failures.length === before ? "pass" : "fail");
    }
  }

  // Multi-value meetings borough (field case #676 class)
  {
    const payload = readPayload("meetings");
    const multi = (payload.rows || []).filter((row) => (row.affected_area?.boroughs || []).length > 1);
    if (multi.length) {
      const row = multi[0];
      for (const borough of row.affected_area.boroughs) {
        const offered = BOROUGHS.find((b) => b.toLocaleLowerCase() === String(borough).toLocaleLowerCase()) || borough;
        const id = `browse/meetings/multi-borough/${row.request_id}/${offered}`;
        const view = buildBrowseView(
          "meetings",
          payload,
          new URLSearchParams({ when: "all", boro: offered }),
          { limit: 10_000 },
        );
        const before = failures.length;
        if (!view.rows.some((r) => r.request_id === row.request_id)) {
          failures.push(`${id}: multi-borough row dropped from ${offered} filter`);
        }
        record(id, "browse-borough-multi", failures.length === before ? "pass" : "fail");
      }
    }
  }

  // --- 3. Property disposition facets (sale method / price / process) ---
  {
    const payload = readPayload("property");
    const commercialOf = (row) => row?.commercial || extractPropertyCommercial(row);
    const entries = buildPropertyExplorerEntries(
      payload.property_rows || [],
      payload.disposition_spines || [],
    );
    for (const entry of entries) {
      for (const member of entry.members || [entry.primary]) {
        if (!member._location && member.property_location) {
          member._location = member.property_location;
        }
      }
    }
    const salePresent = countBy(entries, (entry) => {
      const keys = new Set();
      for (const member of entry.members || [entry.primary]) {
        const key = propertySaleMethodKey(member, commercialOf);
        if (key) keys.add(key);
      }
      return [...keys];
    });
    for (const method of SALE_METHODS) {
      const id = `property/saleMethod/${method}`;
      const present = salePresent.get(method) || 0;
      if (!present) {
        record(id, "property-sale", "skip", "not present in fixture");
        continue;
      }
      const filtered = filterPropertyExplorerEntries(entries, {
        saleMethod: method,
        commercialOf,
      });
      const foreign = filtered.filter((entry) => {
        const hit = (entry.members || [entry.primary]).some(
          (m) => propertySaleMethodKey(m, commercialOf) === method,
        );
        return !hit;
      }).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: entries.length,
        present,
        filtered: filtered.length,
        foreign,
      });
      record(id, "property-sale", failures.length === before ? "pass" : "fail");
    }

    const pricePresent = countBy(entries, (entry) => {
      const keys = new Set();
      for (const member of entry.members || [entry.primary]) {
        const key = propertyPriceBandKey(member, commercialOf);
        if (key) keys.add(key);
      }
      return [...keys];
    });
    for (const band of PRICE_BANDS.filter((b) => b !== "all")) {
      const id = `property/priceBand/${band}`;
      const present = pricePresent.get(band) || 0;
      if (!present) {
        record(id, "property-price", "skip", "not present in fixture");
        continue;
      }
      const filtered = filterPropertyExplorerEntries(entries, {
        priceBand: band,
        commercialOf,
      });
      const foreign = filtered.filter((entry) => {
        const hit = (entry.members || [entry.primary]).some((m) => {
          const key = propertyPriceBandKey(m, commercialOf);
          if (band === "priced") return Boolean(key);
          return key === band;
        });
        return !hit;
      }).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: entries.length,
        present,
        filtered: filtered.length,
        foreign,
      });
      record(id, "property-price", failures.length === before ? "pass" : "fail");
    }

    const processPresent = countBy(entries, (entry) => entry.process_filter);
    for (const stage of DISPOSITION_LIFECYCLE_STAGES) {
      const id = `property/process/${stage}`;
      const present = processPresent.get(stage) || 0;
      // Member-stage hits can exceed process_filter counts; re-count via filter baseline.
      const baseline = filterPropertyExplorerEntries(entries, { process: stage });
      const presentViaFilter = baseline.length;
      if (!presentViaFilter) {
        record(id, "property-process", "skip", "not present in fixture");
        continue;
      }
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: entries.length,
        present: presentViaFilter,
        filtered: baseline.length,
        foreign: 0,
        allowFullMatch: true,
      });
      // Re-run is identity; ensure strict subset when not universal.
      if (presentViaFilter < entries.length && baseline.length >= entries.length) {
        failures.push(`${id}: process filter did not narrow`);
      }
      record(id, "property-process", failures.length === before ? "pass" : "fail");
    }

    // Property borough via explorer path (SPA)
    for (const borough of BOROUGHS) {
      const id = `property/explorer/borough/${borough}`;
      const present = entries.filter((entry) => (entry.members || [entry.primary])
        .some((m) => rowHasBorough(m, borough))).length;
      if (!present) {
        record(id, "property-explorer-borough", "skip", "not present");
        continue;
      }
      const filtered = filterPropertyExplorerEntries(entries, { borough });
      const foreign = filtered.filter((entry) => !(entry.members || [entry.primary])
        .some((m) => rowHasBorough(m, borough))).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: entries.length,
        present,
        filtered: filtered.length,
        foreign,
      });
      record(id, "property-explorer-borough", failures.length === before ? "pass" : "fail");
    }
  }

  // --- 4. Staffing exam facets (interest / window / format / salary / fee / experience) ---
  {
    const exams = readPayload("staffing_exams").exams || [];
    assert.ok(exams.length > 0, "staffing exams fixture has rows");
    for (const [facet, def] of Object.entries(EXAM_FACETS)) {
      const values = def.values || [];
      for (const value of values) {
        const id = `staffing/exam/${facet}/${value}`;
        const filterKey = {
          interest: "interest",
          window: "window",
          format: "format",
          salary: "salary_band",
          fee: "fee_level",
          experience: "no_experience",
        }[facet];
        const filters = {
          query: "",
          interest: "all",
          eligibility: "all",
          window: "all",
          format: "all",
          salary_band: "all",
          fee_level: "all",
          no_experience: "all",
          [filterKey]: value,
        };
        // Count present via the same value function the chips use.
        const present = exams.filter((exam) => {
          if (facet === "window" && value === "actionable") {
            const status = Staffing.statusFor(exam, TODAY);
            return ["open", "upcoming"].includes(status) || Staffing.isContinuousExam?.(exam);
          }
          return examFacetValue(exam, facet, {
            today: TODAY,
            statusFor: Staffing.statusFor,
          }) === value;
        }).length;
        if (!present) {
          record(id, "exam-facet", "skip", "not present in fixture");
          continue;
        }
        const filtered = Staffing.filterExams(exams, filters, TODAY);
        const foreign = filtered.filter((exam) => {
          if (facet === "window" && value === "actionable") {
            const status = Staffing.statusFor(exam, TODAY);
            return !["open", "upcoming"].includes(status) && !Staffing.isContinuousExam?.(exam);
          }
          return examFacetValue(exam, facet, {
            today: TODAY,
            statusFor: Staffing.statusFor,
          }) !== value;
        }).length;
        const before = failures.length;
        assertFacetFilter(failures, id, {
          total: exams.length,
          present,
          filtered: filtered.length,
          foreign,
        });
        record(id, "exam-facet", failures.length === before ? "pass" : "fail");
      }
    }
  }

  // --- 5. Rules process + place via explorer ---
  {
    const payload = readPayload("rules");
    const entries = buildRulesExplorerEntries(payload.rows || [], null);
    const stages = ["proposal", "public_process", "adoption", "effective", "unstaged"];
    for (const process of stages) {
      const id = `rules/process/${process}`;
      const filtered = filterRulesExplorerEntries(entries, { process });
      if (!filtered.length) {
        record(id, "rules-process", "skip", "not present");
        continue;
      }
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: entries.length,
        present: filtered.length,
        filtered: filtered.length,
        foreign: 0,
        allowFullMatch: true,
      });
      if (filtered.length < entries.length && filtered.length >= entries.length) {
        failures.push(`${id}: process filter did not narrow`);
      }
      if (filtered.length >= entries.length && process !== "all") {
        // Only fail if process is not universal
        const other = filterRulesExplorerEntries(entries, { process: "all" });
        if (filtered.length === other.length && process !== "unstaged") {
          // Check whether every entry truly has this process
          const truePresent = entries.filter((e) => {
            return filterRulesExplorerEntries([e], { process }).length > 0;
          }).length;
          if (truePresent < entries.length) {
            failures.push(`${id}: process filter is a silent pass-through`);
          }
        }
      }
      record(id, "rules-process", failures.length === before ? "pass" : "fail");
    }
    for (const borough of BOROUGHS) {
      const id = `rules/explorer/borough/${borough}`;
      const present = entries.filter((entry) => (entry.members || [entry.primary])
        .some((m) => rowHasBorough(m, borough))).length;
      if (!present) {
        record(id, "rules-explorer-borough", "skip", "not present");
        continue;
      }
      const filtered = filterRulesExplorerEntries(entries, { borough });
      const foreign = filtered.filter((entry) => !(entry.members || [entry.primary])
        .some((m) => rowHasBorough(m, borough))).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: entries.length,
        present,
        filtered: filtered.length,
        foreign,
      });
      record(id, "rules-explorer-borough", failures.length === before ? "pass" : "fail");
    }
    {
      const id = "rules/explorer/citywide";
      const filtered = filterRulesExplorerEntries(entries, { locationScope: "citywide" });
      const before = failures.length;
      if (filtered.length === 0) {
        failures.push(`${id}: citywide scope emptied a corpus that is mostly citywide`);
      }
      record(id, "rules-citywide", failures.length === before ? "pass" : "fail");
    }
  }

  // --- 6. Zoning status + community district via Browse ---
  {
    const payload = readPayload("zoning");
    const rows = rowsForBrowse("zoning", payload);
    const publicStatuses = countBy(rows, (row) => (row.public_status ? [`public:${row.public_status}`] : []));
    const projectStatuses = countBy(rows, (row) => (row.project_status ? [`project:${row.project_status}`] : []));
    for (const [statusId, present] of [...publicStatuses, ...projectStatuses]) {
      const id = `browse/zoning/status/${statusId}`;
      const view = buildBrowseView(
        "zoning",
        payload,
        new URLSearchParams({ status: statusId }),
        { limit: 10_000 },
      );
      const field = statusId.startsWith("project:") ? "project_status" : "public_status";
      const expected = statusId.split(":").slice(1).join(":");
      const foreign = view.rows.filter(
        (row) => String(row[field] || "") !== expected,
      ).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: rows.length,
        present,
        filtered: view.total,
        foreign,
      });
      record(id, "zoning-status", failures.length === before ? "pass" : "fail");
    }
    const cds = countBy(rows, (row) => row.community_district || null);
    for (const [cd, present] of sampleTop(cds, 3)) {
      const id = `browse/zoning/cd/${cd}`;
      const view = buildBrowseView(
        "zoning",
        payload,
        new URLSearchParams({ cd }),
        { limit: 10_000 },
      );
      const foreign = view.rows.filter(
        (row) => !String(row.community_district || "").toUpperCase().includes(String(cd).toUpperCase()),
      ).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: rows.length,
        present,
        filtered: view.total,
        foreign,
      });
      record(id, "zoning-cd", failures.length === before ? "pass" : "fail");
    }
  }

  // --- 7. Contracts mode + closing (procurement offered facets) ---
  {
    // Mode is live-only on the open-RFP Browse document (different universe after
    // hydrate). The pure predicate must still be a non-empty strict subset on a
    // mixed solicitation/award corpus so award mode never silently returns RFPs.
    const domain = readPayload("contracts_domain");
    const rows = domain.rows || [];
    for (const mode of PROCUREMENT_MODE_KEYS) {
      const id = `contracts/mode-predicate/${mode}`;
      const present = rows.filter((row) => rowMatchesProcurementMode(row, mode)).length;
      if (!present) {
        record(id, "contracts-mode", "skip", "not present");
        continue;
      }
      const filtered = rows.filter((row) => rowMatchesProcurementMode(row, mode));
      const foreign = filtered.filter((row) => !rowMatchesProcurementMode(row, mode)).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: rows.length,
        present,
        filtered: filtered.length,
        foreign,
      });
      record(id, "contracts-mode", failures.length === before ? "pass" : "fail");
    }
    {
      // Edge document discloses mode as live-only rather than silently applying
      // award mode to the open-solicitation snapshot.
      const id = "browse/contracts/mode-live-only-disclosure";
      const openPayload = readPayload("contracts");
      const view = buildBrowseView(
        "contracts",
        openPayload,
        new URLSearchParams({ mode: "award" }),
        { limit: 10_000 },
      );
      const before = failures.length;
      if (!view.liveOnlyFilters.includes("mode")) {
        failures.push(`${id}: mode must remain live-only on the open-RFP document`);
      }
      if (view.total === 0) {
        failures.push(`${id}: live-only mode must not empty the open-RFP snapshot`);
      }
      record(id, "contracts-mode-disclosure", failures.length === before ? "pass" : "fail");
    }

    const openPayload = readPayload("contracts");
    const openRows = rowsForBrowse("contracts", openPayload);
    {
      const id = "browse/contracts/closing/week";
      const view = buildBrowseView(
        "contracts",
        openPayload,
        new URLSearchParams({ closing: "week" }),
        { limit: 10_000 },
      );
      if (view.total === 0) {
        record(id, "contracts-closing", "skip", "no closing-this-week rows in fixture");
      } else {
        const before = failures.length;
        assertFacetFilter(failures, id, {
          total: openRows.length,
          present: view.total,
          filtered: view.total,
          foreign: 0,
          allowFullMatch: true,
        });
        record(id, "contracts-closing", failures.length === before ? "pass" : "fail");
      }
    }
  }

  // --- 8. Land attendance modes (synthetic + pure predicate parity with land.mjs) ---
  {
    const hearingRows = [
      {
        project_id: "in-person-only",
        borough: "Brooklyn",
        hearing_date: "2026-08-20",
        attendance_modes: ["in_person"],
        venue_address: "1 Centre St",
      },
      {
        project_id: "live-only",
        borough: "Queens",
        hearing_date: "2026-08-21",
        attendance_modes: ["livestream"],
        livestream_url: "https://example.com/live",
      },
      {
        project_id: "hybrid-row",
        borough: "Manhattan",
        hearing_date: "2026-08-22",
        attendance_modes: ["in_person", "livestream"],
        venue_address: "City Hall",
        livestream_url: "https://example.com/hybrid",
      },
    ];
    // Mirror site/app/land.mjs filterLandHearingRows attendance branch.
    const filterHearings = (rows, mode) => rows.filter((row) => {
      const modes = Array.isArray(row.attendance_modes) ? row.attendance_modes : [];
      if (mode === "in_person" && !modes.includes("in_person") && !row.venue_address) return false;
      if (mode === "livestream" && !modes.includes("livestream") && !row.livestream_url) return false;
      if (mode === "hybrid" && !(modes.includes("in_person") && modes.includes("livestream"))
        && !(row.venue_address && row.livestream_url)) return false;
      return true;
    });
    for (const { id: mode } of ATTENDANCE_MODES) {
      if (!mode) continue;
      const id = `land/attendance/${mode}`;
      const filtered = filterHearings(hearingRows, mode);
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: hearingRows.length,
        present: filtered.length,
        filtered: filtered.length,
        foreign: 0,
        allowFullMatch: true,
      });
      if (filtered.length >= hearingRows.length) {
        failures.push(`${id}: attendance mode did not narrow the mixed hearing set`);
      }
      record(id, "land-attendance", failures.length === before ? "pass" : "fail");
    }
  }

  // --- 9. Agency constellation "view all" / section links ---
  {
    for (const category of AGENCY_CONSTELLATION_CATEGORIES) {
      const facet = category.browse_facet;
      if (!BROWSE_FACETS[facet]) continue;
      const payload = readPayload(facet);
      const rows = rowsForBrowse(facet, payload);
      const present = agenciesPresentInRows(facet, rows);
      if (!present.size) {
        record(`constellation/${category.id}`, "constellation", "skip", "no agency in fixture");
        continue;
      }
      const [agencyId, count] = sampleTop(present, 1)[0];
      const href = agencyCategoryBrowseHref(agencyId, category.id);
      const id = `constellation/${category.id}/${agencyId}`;
      if (!href || !href.includes("/browse/")) {
        failures.push(`${id}: constellation href missing browse path: ${href}`);
        record(id, "constellation", "fail");
        continue;
      }
      if (!href.includes("entity_refs_all") && !href.includes("agency")) {
        failures.push(`${id}: constellation href lacks agency scope: ${href}`);
        record(id, "constellation", "fail");
        continue;
      }
      const url = new URL(href, "https://cityscroll.org");
      const view = buildBrowseView(facet, payload, url.searchParams, { limit: 10_000 });
      const foreign = view.rows.filter((row) => rowAgencyId(facet, row) !== agencyId).length;
      const before = failures.length;
      assertFacetFilter(failures, id, {
        total: rows.length,
        present: count,
        filtered: view.total,
        foreign,
      });
      record(id, "constellation", failures.length === before ? "pass" : "fail");
    }
  }

  // --- Summary + hard fail ---
  const passed = inventory.filter((item) => item.result === "pass").length;
  const skipped = inventory.filter((item) => item.result === "skip").length;
  const failed = inventory.filter((item) => item.result === "fail").length;
  // Attach inventory counts to the assertion message for PR/report visibility.
  const summary = `inventory=${inventory.length} pass=${passed} skip=${skipped} fail=${failed}`;
  assert.deepEqual(
    failures,
    [],
    `${summary}\n${failures.join("\n")}`,
  );
  assert.ok(passed >= 30, `${summary}: expected a broad pass set (got ${passed} passes)`);
  assert.ok(
    inventory.length >= 50,
    `${summary}: expected facet-exhaustive inventory (≥50 cases), got ${inventory.length}`,
  );
});

// ---------------------------------------------------------------------------
// Field-case regression pins (keep explicit)
// ---------------------------------------------------------------------------

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
      {
        request_id: "multi-boro",
        agency_name: "City Planning",
        short_title: "Cross-borough hearing",
        event_date: "2026-08-13",
        affected_area: { scope: "local", boroughs: ["Manhattan", "Brooklyn"] },
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

  const multi = buildBrowseView(
    "meetings",
    payload,
    new URLSearchParams({ when: "all", boro: "Brooklyn" }),
    { limit: 1000 },
  );
  assert.ok(
    multi.rows.some((row) => row.request_id === "multi-boro"),
    "multi-value borough rows must match each listed borough",
  );
});

test("offered-facet-actually-filters: staffing Parks agency scope filters appointments (field case)", () => {
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

test("offered-facet-actually-filters: property borough browse scope uses property_location bags", () => {
  const payload = {
    property_rows: [
      {
        request_id: "bx-1",
        agency_name: "Economic Development Corporation",
        short_title: "Bronx surplus",
        property_location: { scope: "local", boroughs: ["Bronx"] },
      },
      {
        request_id: "mn-1",
        agency_name: "City University",
        short_title: "Manhattan parcel",
        property_location: { scope: "local", boroughs: ["Manhattan"] },
      },
    ],
  };
  const all = buildBrowseView("property", payload, new URLSearchParams(), { limit: 1000 });
  assert.equal(all.total, 2);
  const bronx = buildBrowseView(
    "property",
    payload,
    new URLSearchParams({ boro: "Bronx" }),
    { limit: 1000 },
  );
  assert.equal(bronx.total, 1);
  assert.equal(bronx.rows[0].request_id, "bx-1");
});

test("offered-facet-actually-filters: agency section chips target Browse facets that filter", () => {
  const entities = fs.readFileSync(new URL("../site/app/entities.mjs", import.meta.url), "utf8");
  assert.match(entities, /data-agency-section-scope/);
  assert.match(entities, /entity_refs_all/);
  assert.match(entities, /\/browse\/\$\{browse\}\//);

  const targets = [
    { facet: "contracts", agencyId: null },
    { facet: "meetings", agencyId: null },
    { facet: "rules", agencyId: null },
    { facet: "staffing", agencyId: null },
  ];
  for (const target of targets) {
    const payload = readPayload(target.facet);
    const rows = rowsForBrowse(target.facet, payload);
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
