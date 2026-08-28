import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { analyticalDrillThroughHref } from "./analytical_projection.mjs";
import {
  paymentTransactionDrillThroughHref,
} from "./analytical_payment_projection.mjs";

export const AGENCY_FISCAL_CONTEXT_SCHEMA = "cityscroll.agency_fiscal_context.v1";
export const AGENCY_FISCAL_CONTEXT_METHOD = "agency_fiscal_context_exact_id_join_v1";
export const AGENCY_FISCAL_CONTEXT_URL = "data/agency_fiscal_context.json";
export const IBO_FISCAL_HISTORY_SOURCE = Object.freeze({
  publisher: "New York City Independent Budget Office",
  source_page_url: "https://ns2.ibo.nyc.ny.us/fiscalhistory.html",
  publisher_vintage: "FY2022",
  fiscal_year_convention: "NYC fiscal year is named for the calendar year in which it ends; each column is the fiscal year ending June 30.",
  expenditure_workbook: "AgencyExpenditures.xlsx",
  staffing_workbook: "FullTimePositions.xlsx",
});

const EXPENDITURE_MEASURES = Object.freeze({
  total_department_expenditures: "ibo_actual_expenditures",
  personal_services: "ibo_personal_services",
  other_than_personal_services: "ibo_other_than_personal_services",
});

const UNKNOWN = "Unknown";

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sortedYears(values) {
  return [...new Set(values.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

function addMeasure(target, key, row) {
  const value = finite(row?.value_in_usd ?? row?.value);
  if (value == null) return;
  target[key] = value;
  target[`${key}_provenance`] = {
    source_system: "ibo-fiscal-history",
    source_workbook: clean(row.source_workbook),
    source_sheet: clean(row.source_sheet),
    source_vintage: clean(row.source_vintage) || IBO_FISCAL_HISTORY_SOURCE.publisher_vintage,
    source_cell: clean(row.source_cell),
    publisher_measure: clean(row.publisher_measure),
    unit: clean(row.unit),
    unit_label: clean(row.unit_label),
    conversion: row.value_in_usd != null ? "explicit factor 1,000 from USD_thousands" : null,
  };
}

function fiscalHistoryByAgency(rows) {
  const byAgency = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const agencyId = clean(row?.canonical_agency_id);
    const fiscalYear = Number(row?.fiscal_year);
    if (!agencyId || !Number.isInteger(fiscalYear)) continue;
    if (!byAgency.has(agencyId)) {
      byAgency.set(agencyId, {
        agency_id: agencyId,
        agency_name: clean(row.canonical_agency_name) || clean(row.source_agency_name) || agencyId,
        years: new Map(),
        source_labels: new Set(),
      });
    }
    const agency = byAgency.get(agencyId);
    agency.source_labels.add(clean(row.source_agency_name));
    if (!agency.years.has(fiscalYear)) agency.years.set(fiscalYear, { fiscal_year: fiscalYear });
    const year = agency.years.get(fiscalYear);
    const workbook = clean(row.source_workbook_id);
    if (workbook === "ibo_agency_expenditures") {
      const key = EXPENDITURE_MEASURES[clean(row.measure)];
      if (key) addMeasure(year, key, row);
    } else if (workbook === "ibo_full_time_positions" && clean(row.measure) === "full_time_positions") {
      const value = finite(row.value);
      if (value != null) {
        year.ibo_staffing = value;
        year.ibo_staffing_provenance = {
          source_system: "ibo-fiscal-history",
          source_workbook: clean(row.source_workbook),
          source_sheet: clean(row.source_sheet),
          source_vintage: clean(row.source_vintage) || IBO_FISCAL_HISTORY_SOURCE.publisher_vintage,
          source_cell: clean(row.source_cell),
          publisher_measure: clean(row.publisher_measure),
          unit: clean(row.unit),
          unit_label: clean(row.unit_label),
          definition: "Actual full-time positions reported as of June 30 for each year.",
        };
      }
    }
  }
  return byAgency;
}

function identityForRow(row) {
  const raw = row?.agency_id || row?.canonical_agency_id || row?.agency;
  const identity = resolveAgencyIdentity(raw);
  return identity?.matched && identity.canonical_id
    ? identity
    : null;
}

function procurementByAgency(rows) {
  const byAgency = new Map();
  const names = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const identity = identityForRow(row);
    const fiscalYear = Number(row?.registration_fiscal_year);
    const contractId = clean(row?.prime_contract_id || row?.contract_id || row?.id);
    if (!identity || !Number.isInteger(fiscalYear) || !contractId) continue;
    const sourceName = clean(row?.agency);
    if (sourceName) {
      if (!names.has(identity.canonical_id)) names.set(identity.canonical_id, new Set());
      names.get(identity.canonical_id).add(sourceName);
    }
    if (!byAgency.has(identity.canonical_id)) byAgency.set(identity.canonical_id, new Map());
    const years = byAgency.get(identity.canonical_id);
    if (!years.has(fiscalYear)) years.set(fiscalYear, {
      fiscal_year: fiscalYear,
      ids: new Set(),
      current_registered_value: 0,
      original_registered_value: 0,
    });
    const year = years.get(fiscalYear);
    if (year.ids.has(contractId)) continue;
    year.ids.add(contractId);
    year.current_registered_value += finite(row.current_registered_amount) || 0;
    year.original_registered_value += finite(row.original_registered_amount) || 0;
  }
  return { byAgency, names };
}

function paymentsByAgency(rows) {
  const byAgency = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const identity = identityForRow(row);
    const fiscalYear = Number(row?.fiscal_year);
    if (!identity || !Number.isInteger(fiscalYear)) continue;
    if (!byAgency.has(identity.canonical_id)) byAgency.set(identity.canonical_id, new Map());
    const years = byAgency.get(identity.canonical_id);
    if (!years.has(fiscalYear)) years.set(fiscalYear, {
      fiscal_year: fiscalYear,
      transaction_count: 0,
      actual_payment_amount: 0,
      contract_count: 0,
    });
    const year = years.get(fiscalYear);
    year.transaction_count += Number(row.transaction_count || row.unique_transaction_count || 0);
    year.actual_payment_amount += finite(row.actual_payment_amount) || 0;
    year.contract_count += Number(row.contract_count || 0);
  }
  for (const years of byAgency.values()) {
    for (const year of years.values()) {
      year.actual_payment_amount = Math.round(year.actual_payment_amount * 100) / 100;
    }
  }
  return byAgency;
}

function rankingRows(values, { fiscalYear = null, snapshotDate = null, metric, label }) {
  const rows = [...values.entries()]
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([agency_id, value]) => ({ agency_id, value: Number(value) }))
    .sort((left, right) => right.value - left.value || left.agency_id.localeCompare(right.agency_id));
  return {
    metric,
    label,
    fiscal_year: fiscalYear,
    snapshot_date: snapshotDate,
    agency_count: rows.length,
    rows: rows.map((row, index) => ({ ...row, rank: index + 1 })),
  };
}

function latestYear(byAgency, selector) {
  const years = [];
  for (const yearMap of byAgency.values()) {
    for (const [year, row] of yearMap.entries()) if (selector(row) != null) years.push(year);
  }
  return years.length ? Math.max(...years) : null;
}

function valuesAtYear(byAgency, year, selector) {
  const values = new Map();
  if (year == null) return values;
  for (const [agencyId, yearMap] of byAgency.entries()) {
    const value = selector(yearMap.get(year));
    if (value != null) values.set(agencyId, value);
  }
  return values;
}

function currentRegisteredValues(byAgency) {
  const values = new Map();
  for (const [agencyId, yearMap] of byAgency.entries()) {
    const value = [...yearMap.values()].reduce((sum, row) => sum + (finite(row.current_registered_value) || 0), 0);
    if (value > 0) values.set(agencyId, value);
  }
  return values;
}

function makeRankingIndex(snapshot) {
  return new Map((snapshot?.rows || []).map((row) => [row.agency_id, {
    rank: row.rank,
    agency_count: snapshot.agency_count,
    value: row.value,
    fiscal_year: snapshot.fiscal_year,
    snapshot_date: snapshot.snapshot_date,
  }]));
}

function contextStatus(fiscal) {
  return fiscal?.years?.size ? "matched" : "unknown";
}

export function buildAgencyFiscalContext({
  fiscalRows = [],
  registeredRows = [],
  paymentRows = [],
  iboReceipt = {},
  contractProjection = {},
  paymentProjection = {},
  generatedAt = null,
} = {}) {
  const fiscal = fiscalHistoryByAgency(fiscalRows);
  const registeredResult = procurementByAgency(registeredRows);
  const registered = registeredResult.byAgency;
  const registeredNames = registeredResult.names;
  const payments = paymentsByAgency(paymentRows);
  const fiscalYearMaps = new Map([...fiscal].map(([id, agency]) => [id, agency.years]));
  const fiscalYear = latestYear(fiscalYearMaps, (row) => row?.ibo_actual_expenditures);
  const staffingFiscalYear = latestYear(fiscalYearMaps, (row) => row?.ibo_staffing);
  const paymentFiscalYear = latestYear(payments, (row) => row?.actual_payment_amount);
  const fiscalSnapshots = [
    rankingRows(valuesAtYear(fiscalYearMaps, fiscalYear, (row) => row?.ibo_actual_expenditures), {
      fiscalYear, metric: "ibo_actual_expenditures", label: "IBO actual expenditures",
    }),
    rankingRows(valuesAtYear(fiscalYearMaps, staffingFiscalYear, (row) => row?.ibo_staffing), {
      fiscalYear: staffingFiscalYear, metric: "ibo_staffing", label: "IBO staffing measure",
    }),
  ];
  const registeredSnapshot = rankingRows(currentRegisteredValues(registered), {
    snapshotDate: contractProjection.snapshot_date || null,
    metric: "registered_current_value", label: "CityScroll current registered contract value",
  });
  const paymentSnapshot = rankingRows(
    valuesAtYear(payments, paymentFiscalYear, (row) => row?.actual_payment_amount),
    { fiscalYear: paymentFiscalYear, snapshotDate: paymentProjection.snapshot_date || null, metric: "actual_payments", label: "Actual payments" },
  );
  const rankingSnapshots = [...fiscalSnapshots, registeredSnapshot, paymentSnapshot]
    .filter((snapshot) => snapshot.rows.length);
  const rankingIndexes = new Map(rankingSnapshots.map((snapshot) => [snapshot.metric, makeRankingIndex(snapshot)]));

  const agencyIds = new Set([...fiscal.keys(), ...registered.keys(), ...payments.keys()]);
  const byAgency = {};
  let exactJoinCount = 0;
  let unknownFiscalCount = 0;
  for (const agencyId of [...agencyIds].sort()) {
    const fiscalAgency = fiscal.get(agencyId);
    const registeredYears = registered.get(agencyId) || new Map();
    const paymentYears = payments.get(agencyId) || new Map();
    const identity = resolveAgencyIdentity(agencyId);
    const fiscalStatus = contextStatus(fiscalAgency);
    if (fiscalStatus === "matched") exactJoinCount += 1;
    else unknownFiscalCount += 1;
    const years = sortedYears([
      ...(fiscalAgency?.years.keys() || []),
      ...registeredYears.keys(),
      ...paymentYears.keys(),
    ]).map((year) => {
      const fiscalRow = fiscalAgency?.years.get(year) || {};
      const registeredRow = registeredYears.get(year) || {};
      const paymentRow = paymentYears.get(year) || {};
      return {
        fiscal_year: year,
        ibo_actual_expenditures: fiscalRow.ibo_actual_expenditures ?? null,
        ibo_personal_services: fiscalRow.ibo_personal_services ?? null,
        ibo_other_than_personal_services: fiscalRow.ibo_other_than_personal_services ?? null,
        ibo_staffing: fiscalRow.ibo_staffing ?? null,
        current_registered_value: registeredRow.ids ? registeredRow.current_registered_value : null,
        original_registered_value: registeredRow.ids ? registeredRow.original_registered_value : null,
        registered_contract_count: registeredRow.ids ? registeredRow.ids.size : null,
        actual_payment_amount: paymentYears.has(year) ? paymentRow.actual_payment_amount : null,
        payment_transaction_count: paymentYears.has(year) ? paymentRow.transaction_count : null,
        payment_contract_count: paymentYears.has(year) ? paymentRow.contract_count : null,
        measure_provenance: {
          ibo_actual_expenditures: fiscalRow.ibo_actual_expenditures_provenance || null,
          ibo_personal_services: fiscalRow.ibo_personal_services_provenance || null,
          ibo_other_than_personal_services: fiscalRow.ibo_other_than_personal_services_provenance || null,
          ibo_staffing: fiscalRow.ibo_staffing_provenance || null,
        },
      };
    });
    const rankings = {};
    for (const snapshot of rankingSnapshots) {
      const rank = rankingIndexes.get(snapshot.metric)?.get(agencyId);
      if (rank) rankings[snapshot.metric] = rank;
    }
    byAgency[agencyId] = {
      schema: AGENCY_FISCAL_CONTEXT_SCHEMA,
      agency_id: agencyId,
      agency_name: fiscalAgency?.agency_name || identity.canonical_name,
      procurement_agency_name: [...(registeredNames.get(agencyId) || [])].sort()[0] || null,
      status: fiscalStatus,
      fiscal_history: fiscalStatus === "matched" ? {
        years: [...(fiscalAgency?.years.keys() || [])].sort((a, b) => a - b),
        source_labels: [...(fiscalAgency?.source_labels || [])].filter(Boolean).sort(),
      } : null,
      years,
      rankings,
      provenance: {
        join_method: AGENCY_FISCAL_CONTEXT_METHOD,
        agency_identity_id: agencyId,
        identity_resolver: "site/agency_identity.mjs",
        fiscal_history_status: fiscalStatus,
        fiscal_source: IBO_FISCAL_HISTORY_SOURCE,
        fiscal_receipt_schema: iboReceipt.schema || null,
        registered_contract_source: {
          projection_schema: contractProjection.schema || null,
          snapshot_date: contractProjection.snapshot_date || null,
          population_definition: contractProjection.population_definition || null,
        },
        payment_source: {
          projection_schema: paymentProjection.schema || null,
          snapshot_date: paymentProjection.snapshot_date || null,
          population_definition: paymentProjection.population_definition || null,
        },
        overlapping_fiscal_years: years
          .filter((row) => row.ibo_actual_expenditures != null && row.current_registered_value != null)
          .map((row) => row.fiscal_year),
        registered_contract_years: years.filter((row) => row.registered_contract_count != null).map((row) => row.fiscal_year),
        payment_years: years.filter((row) => row.payment_transaction_count != null).map((row) => row.fiscal_year),
      },
    };
  }
  const fiscalYears = sortedYears(fiscalRows.map((row) => row?.fiscal_year));
  const registeredYears = sortedYears(registeredRows.map((row) => row?.registration_fiscal_year));
  const paymentYears = sortedYears(paymentRows.map((row) => row?.fiscal_year));
  return {
    schema: AGENCY_FISCAL_CONTEXT_SCHEMA,
    method: AGENCY_FISCAL_CONTEXT_METHOD,
    generated_at: generatedAt,
    sources: {
      fiscal_history: {
        ...IBO_FISCAL_HISTORY_SOURCE,
        receipt_schema: iboReceipt.schema || null,
        retrieval_timestamp: iboReceipt.retrieval_timestamp || null,
      },
      registered_contracts: {
        schema: contractProjection.schema || null,
        snapshot_date: contractProjection.snapshot_date || null,
        population_definition: contractProjection.population_definition || null,
      },
      payments: {
        schema: paymentProjection.schema || null,
        snapshot_date: paymentProjection.snapshot_date || null,
        population_definition: paymentProjection.population_definition || null,
      },
    },
    ranking_snapshots: rankingSnapshots,
    coverage: {
      agency_count: agencyIds.size,
      exact_fiscal_join_count: exactJoinCount,
      unknown_fiscal_context_count: unknownFiscalCount,
      fiscal_history_years: fiscalYears,
      registered_contract_years: registeredYears,
      payment_years: paymentYears,
      overlapping_fiscal_years: fiscalYears.filter((year) => registeredYears.includes(year)),
    },
    by_agency: byAgency,
  };
}

export function fiscalContextForAgency(payload, agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.matched || !identity.canonical_id) return null;
  return payload?.by_agency?.[identity.canonical_id] || null;
}

const currency = (value) => Number.isFinite(Number(value))
  ? `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  : UNKNOWN;
const integer = (value) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })
  : UNKNOWN;
const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function contextValue(value, kind, href = null) {
  const text = kind === "currency" ? currency(value) : integer(value);
  if (value == null) return `<span class="agency-fiscal-context-unknown" data-fiscal-coverage="unknown">${UNKNOWN}</span>`;
  return href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
}

function yearsLabel(years) {
  if (!years.length) return UNKNOWN;
  return years.length === 1 ? `FY${years[0]}` : `FY${years[0]}–FY${years[years.length - 1]}`;
}

export function renderAgencyFiscalContextSection(context) {
  if (!context) return "";
  const allRows = Array.isArray(context.years) ? context.years : [];
  const recentIboYears = new Set((context.fiscal_history?.years || []).slice(-10));
  const rows = allRows.filter((row) => recentIboYears.has(row.fiscal_year)
    || row.registered_contract_count != null
    || row.payment_transaction_count != null);
  const agency = context.procurement_agency_name || context.agency_name || context.agency_id || "this agency";
  const unknownNotice = context.status !== "matched"
    ? `<p class="agency-fiscal-context-status" data-fiscal-context-status="unknown"><strong>Fiscal context: Unknown.</strong> No exact IBO agency identifier matched a fiscal-history record for this agency.</p>`
    : `<p class="agency-fiscal-context-status" data-fiscal-context-status="matched">IBO fiscal history: ${esc(yearsLabel(context.fiscal_history?.years || []))}; publisher vintage FY2022. The table keeps fiscal scale, staffing, registered contract value, and payments as separate measures.</p>`;
  const table = rows.length ? `<div class="agency-fiscal-context-table-wrap"><table class="agency-fiscal-context-table"><caption>Agency fiscal context by fiscal year</caption><thead><tr><th scope="col">FY</th><th scope="col">IBO actual expenditures</th><th scope="col">IBO Personal Services</th><th scope="col">IBO Other Than Personal Services</th><th scope="col">IBO staffing</th><th scope="col">Current registered contract value</th><th scope="col">Registered contracts</th><th scope="col">Actual payments</th></tr></thead><tbody>${rows.map((row) => {
    const contractHref = row.registered_contract_count != null
      ? analyticalDrillThroughHref({ agency, registration_fiscal_year: row.fiscal_year }) : null;
    const paymentHref = row.payment_transaction_count != null
      ? paymentTransactionDrillThroughHref({ agency, fiscal_year: row.fiscal_year }) : null;
    return `<tr><th scope="row">FY${esc(row.fiscal_year)}</th><td>${contextValue(row.ibo_actual_expenditures, "currency")}</td><td>${contextValue(row.ibo_personal_services, "currency")}</td><td>${contextValue(row.ibo_other_than_personal_services, "currency")}</td><td>${contextValue(row.ibo_staffing, "integer")}</td><td>${contextValue(row.current_registered_value, "currency", contractHref)}</td><td>${contextValue(row.registered_contract_count, "integer", contractHref)}</td><td>${contextValue(row.actual_payment_amount, "currency", paymentHref)}</td></tr>`;
  }).join("")}</tbody></table></div><p class="agency-fiscal-context-status">Showing the latest ten IBO fiscal years plus every current procurement/payment year; the full IBO history remains in the materialized source.</p>` : `<p class="agency-fiscal-context-status" data-fiscal-context-status="unknown">No fiscal-year observations are available for this agency.</p>`;
  const provenance = `<div class="agency-fiscal-context-provenance"><h3>Sources and measure definitions</h3><ul><li><a href="${esc(IBO_FISCAL_HISTORY_SOURCE.source_page_url)}">IBO New York City Fiscal History</a>: actual department expenditures in publisher $000s, shown here in USD; staffing is actual full-time positions reported as of June 30. Publisher vintage FY2022.</li><li>CityScroll registered-contract measures use the AP-03 population snapshot and mean registered contract value, not actual spending.</li><li>Actual payments use the separate AP-08 Checkbook Spending population and are shown only as the AP-09 payment fact.</li></ul><p>These sources use different accounting and population scopes. Current snapshots have IBO fiscal years ${esc(yearsLabel(context.fiscal_history?.years || []))} and procurement/payment years ${esc(yearsLabel([...new Set([...(context.provenance?.registered_contract_years || []), ...(context.provenance?.payment_years || [])].sort((a, b) => a - b))]))}; a blank measure is labeled Unknown because the publisher does not report a value for that year. No outsourcing or efficiency score is calculated.</p></div>`;
  const rankingEntries = [
    ["ibo_actual_expenditures", "IBO actual expenditures"],
    ["ibo_staffing", "IBO staffing measure"],
    ["registered_current_value", "Current registered contract value"],
    ["actual_payments", "Actual payments"],
  ].filter(([key]) => context.rankings?.[key]);
  const rankings = rankingEntries.length ? `<div class="agency-fiscal-context-rankings"><h3>Separate agency rankings</h3><table><caption>Rankings are independent reference points, not a composite score</caption><thead><tr><th scope="col">Measure</th><th scope="col">Reference</th><th scope="col">Rank</th></tr></thead><tbody>${rankingEntries.map(([key, label]) => { const rank = context.rankings[key]; const reference = rank.fiscal_year ? `FY${rank.fiscal_year}` : (rank.snapshot_date ? `as of ${rank.snapshot_date}` : "reference point"); return `<tr><th scope="row">${esc(label)}</th><td>${esc(reference)}</td><td>${esc(`#${rank.rank} of ${rank.agency_count}`)}</td></tr>`; }).join("")}</tbody></table><p>Rank differences are descriptive leads for research; they do not establish causation or vendor reliance.</p></div>` : "";
  return `<section class="node-section node-card civic-object-section agency-fiscal-context" id="agency-fiscal-context" aria-labelledby="agency-fiscal-context-heading" data-agency-constellation-category="fiscal-context" data-fiscal-context-status="${esc(context.status)}"><h2 id="agency-fiscal-context-heading">Agency fiscal context</h2>${unknownNotice}${table}${rankings}${provenance}</section>`;
}
