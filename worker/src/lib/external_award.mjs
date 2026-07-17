// Worker-side copy of the award-source registry + pure resolution logic (crol-list).
//
// Hand-synced with the static site's external_awards.js — the Worker and the static site can't
// share one import across that boundary, the same dual-implementation convention this codebase
// already uses for lib/prior_cycle.mjs and lib/lineage.mjs. Any registry change must land in BOTH
// files; test/external_awards_registry.test.mjs cross-checks them and fails on divergence.
//
// See external_awards.js's header for what each kind means and how every entry was verified.

export const AWARD_SOURCE_REGISTRY = {
  "Housing Authority": { kind: "checkbook-nycha", precision: "exact" },

  "School Construction Authority": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City School Construction Authority", precision: "fuzzy" },
  "NYC Health + Hospitals": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Health and Hospitals Corporation", precision: "fuzzy" },
  "Health and Hospitals Corporation": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Health and Hospitals Corporation", precision: "fuzzy" },
  "Public Housing Preservation Trust": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Public Housing Preservation Trust", precision: "fuzzy" },
  "Educational Construction Fund": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Educational Construction Fund", precision: "fuzzy" },
  "Water Board": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Water Board", precision: "fuzzy" },

  "Economic Development Corporation": { kind: "abo", dataset: "d84c-dk28", authority: "New York City Economic Development Corporation", precision: "fuzzy" },
  "Brooklyn Navy Yard Development Corp.": { kind: "abo", dataset: "d84c-dk28", authority: "Brooklyn Navy Yard Development Corporation", precision: "fuzzy" },
  "Brooklyn Bridge Park": { kind: "abo", dataset: "d84c-dk28", authority: "Brooklyn Bridge Park Corporation", precision: "fuzzy" },
  "Trust for Governors Island": { kind: "abo", dataset: "d84c-dk28", authority: "Governors Island Corporation", precision: "fuzzy" },
  "Mayor's Fund to Advance New York City": { kind: "abo", dataset: "d84c-dk28", authority: "The Mayor's Fund to Advance New York City", precision: "fuzzy" },

  "Hudson River Park Trust": { kind: "abo", dataset: "ehig-g5x3", authority: "Hudson River Park Trust", precision: "fuzzy" },
  "Metropolitan Transportation Authority": { kind: "abo", dataset: "ehig-g5x3", authority: "Metropolitan Transportation Authority", precision: "fuzzy" },

  "Triborough Bridge and Tunnel Authority": { kind: "absent" },
  "Port Authority of New York and New Jersey": { kind: "absent" },
  "Public Library - Queens": { kind: "absent" },
  "New York City Fire Pension Fund": { kind: "absent" },
  "Board of Education Retirement System": { kind: "absent" },
  "Borough Of Manhattan Community College": { kind: "absent" },
  "NYC & Company": { kind: "absent" },
  "Staten Island Rapid Transit Operating Authority": { kind: "absent" },
  "Office of The Actuary": { kind: "absent" },
  "Tax Commission": { kind: "absent" },
  "City University Of NY Central Office": { kind: "absent" },
  "Public Administrator - Kings County": { kind: "absent" },
  "Public Administrator - Queens County": { kind: "absent" },
  "Commission on Racial Equity": { kind: "absent" },
  "Kingsborough Community College": { kind: "absent" },
  "Technology Development Corporation": { kind: "absent" },
};

export function awardSourceFor(agency) {
  return AWARD_SOURCE_REGISTRY[String(agency || "").trim()] || null;
}

export function awardCoverage(agency) {
  const e = awardSourceFor(agency);
  if (!e) return "unknown";
  if (e.kind === "absent") return "absent";
  return e.precision === "exact" ? "exact" : "fuzzy";
}

// Distinct ABO sources (dataset + authority), deduped across aliases — what the weekly cron pulls.
export function aboSources() {
  const byKey = new Map();
  for (const entry of Object.values(AWARD_SOURCE_REGISTRY)) {
    if (entry.kind !== "abo") continue;
    const key = `${entry.dataset}:${entry.authority}`;
    if (!byKey.has(key)) byKey.set(key, { dataset: entry.dataset, authority: entry.authority });
  }
  return [...byKey.values()];
}

// The KV key an ABO source's cached award set is stored under (award:<dataset>:<authority>).
export function awardKvKey(entry) {
  return `award:${entry.dataset}:${entry.authority}`;
}

export function externalAwardMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(String(value || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function normalizeAuthorityAward(row) {
  return {
    authority: row.authority_name || "",
    vendor: row.vendor_name || "",
    description: row.procurement_description || "",
    process: row.award_process || "",
    date: row.award_date || "",
    amount: externalAwardMoney(row.contract_amount),
    source: "nys-abo",
  };
}

export function normalizeRecentAuthorityAwards(rows, asOfDate) {
  const cutoff = String(asOfDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) return [];
  return (rows || []).filter((row) => {
    const awardDate = String((row && row.award_date) || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(awardDate) && awardDate <= cutoff;
  }).map(normalizeAuthorityAward);
}

export function rankNychaAwardCandidates(notice, rows) {
  const pin = String((notice && notice.pin) || "").trim();
  const noticeAt = Date.parse((notice && notice.start_date) || "");
  if (!pin || !Number.isFinite(noticeAt)) return [];
  const seen = new Set();
  return (rows || []).filter((row) => {
    if (row.recordType !== "Agreement" || String(row.pin || "").trim() !== pin || !row.id || seen.has(row.id)) return false;
    const contractAt = Date.parse(row.approved || row.start || "");
    if (!Number.isFinite(contractAt) || contractAt <= noticeAt) return false;
    seen.add(row.id);
    return true;
  }).sort((a, b) => String(a.approved || a.start || "").localeCompare(String(b.approved || b.start || "")));
}
