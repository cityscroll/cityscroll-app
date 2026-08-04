import { fillContractActionLocationSelects, rowMatchesContractActionFilter } from "./contract_action_location.mjs";

const DATA_URL = "data/contract_action_address_locations.json";
let payloadPromise = null;
function loadPayload() {
  return payloadPromise ||= fetch(DATA_URL).then((response) => response.ok ? response.json() : null).catch(() => null);
}

export async function initializeMoneyLocationFilters({ t }) {
  const payload = await loadPayload();
  fillContractActionLocationSelects(payload, { councilLabel: (value) => t("council_district_short", { n: value }) });
}

export function moneyLocationFilterFromControls() {
  let basis = document.querySelector("#moneylocationbasis")?.value || "";
  const borough = document.querySelector("#moneyboro")?.value || "";
  const communityDistrict = document.querySelector("#moneycd")?.value || "";
  const councilDistrict = document.querySelector("#moneycouncil")?.value || "";
  if (!basis && (borough || communityDistrict || councilDistrict)) {
    basis = "contract_action_address";
    document.querySelector("#moneylocationbasis").value = basis;
  }
  return {
    layer: basis ? "contract_action_address" : "",
    basis: basis === "contract_action_address" ? "" : basis,
    borough, communityDistrict, councilDistrict,
  };
}

export function moneyLocationFilterSummaryHTML(filter, { t, esc }) {
  if (filter.layer !== "contract_action_address") return "";
  const key = { submission_address: "money_location_basis_submission", pre_bid_venue: "money_location_basis_prebid", document_pickup: "money_location_basis_pickup" }[filter.basis];
  const labels = [key ? t(key) : t("money_location_basis_response"), filter.borough, filter.communityDistrict, filter.councilDistrict ? t("council_district_short", { n: filter.councilDistrict }) : ""].filter(Boolean);
  return `<div class="nlunderstood money-location-filter-summary" role="status">${t("money_location_filter_interpretation")} ${labels.map((label) => `<span class="qchip"><b>${esc(label)}</b></span>`).join(" ")}</div>`;
}

function selectedLocation(row, filter) {
  return (row.locations || []).find((item) =>
    (!filter.basis || item.basis === filter.basis) &&
    (!filter.borough || item.borough === filter.borough) &&
    (!filter.communityDistrict || item.community_district === filter.communityDistrict) &&
    (!filter.councilDistrict || String(item.council_district) === String(filter.councilDistrict))
  ) || row.locations?.[0] || null;
}

export async function paintMoneyActionLocationResults(filter, deps) {
  const payload = await loadPayload();
  await initializeMoneyLocationFilters(deps);
  const matches = (payload?.rows || []).filter((row) => rowMatchesContractActionFilter(row, {
    basis: filter.basis || null,
    borough: filter.borough || null,
    community_district: filter.communityDistrict || null,
    council_district: filter.councilDistrict || null,
  }));
  const query = String(deps.query || "").trim().toLowerCase();
  const rows = matches.filter((row) => (!deps.agency || row.agency_name === deps.agency) && (!query || [row.short_title, row.agency_name, row.pin].some((value) => String(value || "").toLowerCase().includes(query))))
    .map((row) => ({ ...row, _action_location_match: selectedLocation(row, filter) }));
  const place = filter.communityDistrict || (filter.councilDistrict ? deps.t("council_district_short", { n: filter.councilDistrict }) : filter.borough);
  document.querySelector("#reshead").textContent = place ? deps.t("money_response_location_heading_place", { place }) : deps.t("money_response_location_heading");
  deps.paintMoneyRows(rows, { autoSelect: true, narrowed: false });
}

export function moneyActionLocationChipHTML(row, { t, esc }) {
  const location = row._action_location_match;
  if (!location) return "";
  const place = [location.borough, location.community_district, location.council_district ? t("council_district_short", { n: location.council_district }) : null].filter(Boolean).join(" · ");
  return `<div class="mwbe-chiprow money-location-basis" data-money-location-basis="${esc(location.basis || "")}"><span class="tag place">${esc(location.basis_label || t("money_location_basis_response"))}</span><span class="tag">${esc(place)}</span></div>`;
}

export async function hydrateMoneyActionLocationRow(row, { soda, select }) {
  try {
    const rows = await soda({ "$select": select, "$where": `request_id='${String(row.request_id || "").replace(/'/g, "''")}'`, "$limit": "1" });
    return rows[0] ? { ...rows[0], _action_location_match: row._action_location_match } : row;
  } catch (_error) {
    return row;
  }
}
