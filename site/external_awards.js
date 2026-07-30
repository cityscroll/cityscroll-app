// Cross-source award entity resolution. This file contains only pure mapping/ranking logic so
// the static client can use it as a classic script and Node can characterize it without a DOM.
// Official source rows remain separate from City Record rows; the UI names their provenance.
//
// AWARD_SOURCE_REGISTRY is the single source of truth for the whole feature: it drives (1) which
// agencies the site sweeps for awards published outside the City Record, (2) the join precision
// used to resolve them, and (3) the coverage claim the empty state makes. Coverage lives in data,
// not scattered conditionals. Every entry was verified against the live source on 2026-07-16 —
// each "abo"/"checkbook-nycha" entry returns a real award record for that authority, and each
// "absent" entry was confirmed to have no open, batch-downloadable dataset publishing its awards.
// The worker keeps a hand-synced copy in worker/src/lib/external_award.mjs (the static site and
// the Worker can't share one import across that boundary); test/external_awards_registry.test.mjs
// fails on any divergence.
//
//   kind "checkbook-nycha" — exact join by PIN against Checkbook NYC's Contracts_NYCHA domain.
//   kind "abo"             — fuzzy join (vendor + date + amount) against a NYS Authorities Budget
//                            Office procurement dataset on data.ny.gov, keyed by authority_name.
//   kind "absent"          — verified: no open dataset publishes this agency's awards.
var AWARD_SOURCE_REGISTRY = {
  // ---- Exact-key: Checkbook NYC Contracts_NYCHA, joined by PIN ----
  "Housing Authority": { kind: "checkbook-nycha", precision: "exact" },

  // ---- ABO "Local Authorities" (8w5p-k45m) ----
  "School Construction Authority": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City School Construction Authority", precision: "fuzzy" },
  "NYC Health + Hospitals": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Health and Hospitals Corporation", precision: "fuzzy" },
  "Health and Hospitals Corporation": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Health and Hospitals Corporation", precision: "fuzzy" },
  "Public Housing Preservation Trust": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Public Housing Preservation Trust", precision: "fuzzy" },
  "Educational Construction Fund": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Educational Construction Fund", precision: "fuzzy" },
  "Water Board": { kind: "abo", dataset: "8w5p-k45m", authority: "New York City Water Board", precision: "fuzzy" },

  // ---- ABO "Local Development Corporations" (d84c-dk28) ----
  "Economic Development Corporation": { kind: "abo", dataset: "d84c-dk28", authority: "New York City Economic Development Corporation", precision: "fuzzy" },
  "Brooklyn Navy Yard Development Corp.": { kind: "abo", dataset: "d84c-dk28", authority: "Brooklyn Navy Yard Development Corporation", precision: "fuzzy" },
  "Brooklyn Bridge Park": { kind: "abo", dataset: "d84c-dk28", authority: "Brooklyn Bridge Park Corporation", precision: "fuzzy" },
  "Trust for Governors Island": { kind: "abo", dataset: "d84c-dk28", authority: "Governors Island Corporation", precision: "fuzzy" },
  "Mayor's Fund to Advance New York City": { kind: "abo", dataset: "d84c-dk28", authority: "The Mayor's Fund to Advance New York City", precision: "fuzzy" },

  // ---- ABO "State Authorities" (ehig-g5x3) ----
  "Hudson River Park Trust": { kind: "abo", dataset: "ehig-g5x3", authority: "Hudson River Park Trust", precision: "fuzzy" },
  "Metropolitan Transportation Authority": { kind: "abo", dataset: "ehig-g5x3", authority: "Metropolitan Transportation Authority", precision: "fuzzy" },

  // ---- Verified-absent (checked 2026-07-16): no open dataset publishes these agencies' awards.
  // Reasons live in the source registry notes, not in the UI — the empty state says one honest
  // line for all of them. Kept enumerated (not merely "unknown") so the claim is a verified
  // absence, not an untested guess.
  "Triborough Bridge and Tunnel Authority": { kind: "absent" }, // MTA constituent; only the aggregate MTA filing, no per-constituent field
  "Port Authority of New York and New Jersey": { kind: "absent" }, // bi-state compact; not in NYS ABO; award pages are HTML only
  "Public Library - Queens": { kind: "absent" }, // independent not-for-profit; no procurement open dataset
  "New York City Fire Pension Fund": { kind: "absent" }, // pension; investment-manager selection, not PAL procurement
  "Board of Education Retirement System": { kind: "absent" }, // pension
  "Borough Of Manhattan Community College": { kind: "absent" }, // CUNY; no ABO/open dataset (DASNY/SUCF cover SUNY, not CUNY campuses)
  "NYC & Company": { kind: "absent" }, // not-for-profit tourism marketing corporation; not in NYS ABO
  "Staten Island Rapid Transit Operating Authority": { kind: "absent" }, // MTA constituent; aggregate only
  "Office of The Actuary": { kind: "absent" }, // city office; no dedicated award dataset
  "Tax Commission": { kind: "absent" }, // city charter body
  "City University Of NY Central Office": { kind: "absent" }, // CUNY
  "Public Administrator - Kings County": { kind: "absent" }, // court-affiliated; no open dataset
  "Public Administrator - Queens County": { kind: "absent" },
  "Commission on Racial Equity": { kind: "absent" }, // charter body; no open dataset
  "Kingsborough Community College": { kind: "absent" }, // CUNY
  "Technology Development Corporation": { kind: "absent" }, // listed in d84c-dk28 but zero rows carry an award_date — not joinable
};

// Human labels + data.ny.gov page for each ABO dataset (provenance display + source links).
var ABO_DATASET_URL = "https://data.ny.gov/resource/";

function awardSourceFor(agency) {
  return AWARD_SOURCE_REGISTRY[String(agency || "").trim()] || null;
}

// "exact" | "fuzzy" | "absent" | "unknown" — the empty-state / coverage decision, from data.
function awardCoverage(agency) {
  var e = awardSourceFor(agency);
  if (!e) return "unknown";
  if (e.kind === "absent") return "absent";
  return e.precision === "exact" ? "exact" : "fuzzy";
}

// Back-compat shim: the ABO {dataset, authority} shape the agency-profile query still speaks.
// Returns null for the exact (NYCHA/Checkbook) and absent kinds, same as before the registry.
function authorityAwardSource(agency) {
  var e = awardSourceFor(agency);
  return e && e.kind === "abo" ? { dataset: e.dataset, authority: e.authority } : null;
}

function externalAwardMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  var n = Number(String(value || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizeAuthorityAward(row) {
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

function normalizeRecentAuthorityAwards(rows, asOfDate) {
  var cutoff = String(asOfDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) return [];
  return (rows || []).filter(function (row) {
    var awardDate = String(row && row.award_date || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(awardDate) && awardDate <= cutoff;
  }).map(normalizeAuthorityAward);
}

function rankNychaAwardCandidates(notice, rows) {
  var pin = String(notice && notice.pin || "").trim();
  var noticeAt = Date.parse(notice && notice.start_date || "");
  if (!pin || !Number.isFinite(noticeAt)) return [];
  var seen = new Set();
  return (rows || []).filter(function (row) {
    if (row.recordType !== "Agreement" || String(row.pin || "").trim() !== pin || !row.id || seen.has(row.id)) return false;
    var contractAt = Date.parse(row.approved || row.start || "");
    if (!Number.isFinite(contractAt) || contractAt <= noticeAt) return false;
    seen.add(row.id);
    return true;
  }).sort(function (a, b) {
    return String(a.approved || a.start || "").localeCompare(String(b.approved || b.start || ""));
  });
}

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = {
    AWARD_SOURCE_REGISTRY: AWARD_SOURCE_REGISTRY,
    ABO_DATASET_URL: ABO_DATASET_URL,
    awardSourceFor: awardSourceFor,
    awardCoverage: awardCoverage,
    authorityAwardSource: authorityAwardSource,
    externalAwardMoney: externalAwardMoney,
    normalizeAuthorityAward: normalizeAuthorityAward,
    normalizeRecentAuthorityAwards: normalizeRecentAuthorityAwards,
    rankNychaAwardCandidates: rankNychaAwardCandidates,
  };
}
