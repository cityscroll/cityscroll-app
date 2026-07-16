// Cross-source award entity resolution. This file contains only pure mapping/ranking logic so
// the static client can use it as a classic script and Node can characterize it without a DOM.
// Official source rows remain separate from City Record rows; the UI names their provenance.

var AUTHORITY_AWARD_SOURCES = {
  "School Construction Authority": { dataset: "8w5p-k45m", authority: "New York City School Construction Authority" },
  "NYC Health + Hospitals": { dataset: "8w5p-k45m", authority: "New York City Health and Hospitals Corporation" },
  "Health and Hospitals Corporation": { dataset: "8w5p-k45m", authority: "New York City Health and Hospitals Corporation" },
  "Public Housing Preservation Trust": { dataset: "8w5p-k45m", authority: "New York City Public Housing Preservation Trust" },
  "Educational Construction Fund": { dataset: "8w5p-k45m", authority: "New York City Educational Construction Fund" },
  "Economic Development Corporation": { dataset: "d84c-dk28", authority: "New York City Economic Development Corporation" },
  "Brooklyn Navy Yard Development Corp.": { dataset: "d84c-dk28", authority: "Brooklyn Navy Yard Development Corporation" },
  "Brooklyn Bridge Park": { dataset: "d84c-dk28", authority: "Brooklyn Bridge Park Corporation" },
  "Trust for Governors Island": { dataset: "d84c-dk28", authority: "Governors Island Corporation" },
  "Mayor's Fund to Advance New York City": { dataset: "d84c-dk28", authority: "The Mayor's Fund to Advance New York City" },
};

function authorityAwardSource(agency) {
  var source = AUTHORITY_AWARD_SOURCES[String(agency || "").trim()];
  return source ? { dataset: source.dataset, authority: source.authority } : null;
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
    AUTHORITY_AWARD_SOURCES: AUTHORITY_AWARD_SOURCES,
    authorityAwardSource: authorityAwardSource,
    externalAwardMoney: externalAwardMoney,
    normalizeAuthorityAward: normalizeAuthorityAward,
    normalizeRecentAuthorityAwards: normalizeRecentAuthorityAwards,
    rankNychaAwardCandidates: rankNychaAwardCandidates,
  };
}
