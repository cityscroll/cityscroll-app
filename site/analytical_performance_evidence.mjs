import {
  ANALYTICAL_PROJECTION_SCHEMA,
  readerDimensionValue,
} from "./analytical_projection_contract.mjs";

export const PERFORMANCE_EVIDENCE_ANALYTICAL_PROJECTION_URL = "data/analytics_performance_evidence.json";

export const PERFORMANCE_EVIDENCE_STATES = Object.freeze({
  TERMS: "has-accessible-performance-terms",
  EVALUATION: "has-evaluation-doc",
  NONE: "no-located-evidence",
});

export const PERFORMANCE_EVIDENCE_KINDS = Object.freeze({
  TERMS: "performance_terms",
  EVALUATION: "evaluation_doc",
});

export const PERFORMANCE_EVIDENCE_SOURCE_COVERAGE = Object.freeze([
  Object.freeze({
    source_id: "checkbook-contracts",
    label: "Checkbook registered contracts",
    role: "financial visibility",
    performance_evidence: false,
  }),
  Object.freeze({
    source_id: "city-record-awards",
    label: "City Record award notices",
    role: "public award-notice evidence",
    performance_evidence: true,
  }),
  Object.freeze({
    source_id: "passport-public",
    label: "PASSPort Public",
    role: "public procurement evidence",
    performance_evidence: true,
  }),
]);

const SOURCE_IDS = new Set(PERFORMANCE_EVIDENCE_SOURCE_COVERAGE.map((source) => source.source_id));
const FORBIDDEN_OUTPUT_KEYS = new Set([
  "outcome", "outcomes", "result", "results", "performance_score", "score",
  "vendor_blame", "blame", "success", "failure", "evaluation_result",
]);

function clean(value, max = 500) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function exactContractId(value) {
  return clean(value, 160);
}

function sourcePassage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceId = clean(value.source_id, 100);
  const documentId = clean(value.document_id, 180);
  const url = clean(value.url, 2000);
  const locator = clean(value.locator, 240);
  const excerpt = clean(value.excerpt, 600);
  if (!sourceId || !SOURCE_IDS.has(sourceId) || !documentId || !url || !locator || !excerpt) return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { source_id: sourceId, document_id: documentId, url, locator, excerpt };
}

export function normalizePerformanceEvidenceItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const kind = clean(item.kind, 60);
  if (![PERFORMANCE_EVIDENCE_KINDS.TERMS, PERFORMANCE_EVIDENCE_KINDS.EVALUATION].includes(kind)) return null;
  const passage = sourcePassage(item.source_passage || item.passage);
  if (!passage) return null;
  return {
    kind,
    label: clean(item.label, 180) || (kind === PERFORMANCE_EVIDENCE_KINDS.EVALUATION ? "Public evaluation document" : "Public performance terms"),
    source_passage: passage,
  };
}

export function normalizePerformanceEvidenceRow(row) {
  const contractId = exactContractId(row?.prime_contract_id || row?.contract_id || row?.id);
  if (!contractId) return null;
  const evidence = (Array.isArray(row?.evidence_items) ? row.evidence_items : Array.isArray(row?.evidence) ? row.evidence : [])
    .map(normalizePerformanceEvidenceItem)
    .filter(Boolean);
  const state = evidence.some((item) => item.kind === PERFORMANCE_EVIDENCE_KINDS.EVALUATION)
    ? PERFORMANCE_EVIDENCE_STATES.EVALUATION
    : evidence.some((item) => item.kind === PERFORMANCE_EVIDENCE_KINDS.TERMS)
      ? PERFORMANCE_EVIDENCE_STATES.TERMS
      : PERFORMANCE_EVIDENCE_STATES.NONE;
  return {
    prime_contract_id: contractId,
    evidence_state: state,
    evidence_items: evidence,
    unresolved: state === PERFORMANCE_EVIDENCE_STATES.NONE,
  };
}

function uniqueContracts(rows) {
  const unique = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = exactContractId(row?.prime_contract_id || row?.contract_id || row?.id);
    if (id && !unique.has(id)) unique.set(id, row);
  }
  return [...unique.values()];
}

function evidenceRowsByContract(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizePerformanceEvidenceRow(row);
    if (normalized && !byId.has(normalized.prime_contract_id)) byId.set(normalized.prime_contract_id, normalized);
  }
  return byId;
}

export function projectPerformanceEvidenceCoverage(contractRows, evidenceRows = [], metadata = {}) {
  const evidenceByContract = evidenceRowsByContract(evidenceRows);
  const rows = uniqueContracts(contractRows).map((contract) => {
    const contractId = exactContractId(contract?.prime_contract_id || contract?.contract_id || contract?.id);
    const evidence = evidenceByContract.get(contractId) || {
      evidence_state: PERFORMANCE_EVIDENCE_STATES.NONE,
      evidence_items: [],
      unresolved: true,
    };
    return {
      prime_contract_id: contractId,
      agency: contract?.agency || null,
      prime_vendor: contract?.prime_vendor || contract?.vendor || null,
      registration_fiscal_year: Number.isInteger(Number(contract?.registration_fiscal_year))
        ? Number(contract.registration_fiscal_year) : null,
      contract_amount_band: contract?.contract_amount_band || null,
      current_registered_amount: Number.isFinite(Number(contract?.current_registered_amount))
        ? Number(contract.current_registered_amount) : null,
      evidence_state: evidence.evidence_state,
      evidence_items: evidence.evidence_items,
      unresolved: evidence.unresolved,
      financial_fact: "registered_contract",
    };
  });
  return {
    schema: "cityscroll.analytics_performance_evidence.v1",
    projection_contract: ANALYTICAL_PROJECTION_SCHEMA,
    fact: "public_performance_evidence_coverage",
    generated_at: metadata.generated_at || null,
    snapshot_date: metadata.snapshot_date || null,
    population_definition: "Registered contracts joined to accepted public performance-evidence passages; no located passage remains explicitly unresolved.",
    source_coverage: metadata.source_coverage || PERFORMANCE_EVIDENCE_SOURCE_COVERAGE,
    absence_scope: "No located evidence means no qualifying passage was found in the declared CityScroll public sources. It does not establish that evidence does not exist, that a vendor failed, or that a service outcome occurred.",
    coordination_boundary: "Consumes accepted PASSPort evidence rows when supplied; does not duplicate PASSPort acquisition or infer evidence from financial connectivity.",
    rows,
  };
}

function stateStats(rows) {
  const stats = Object.fromEntries(Object.values(PERFORMANCE_EVIDENCE_STATES).map((state) => [state, {
    evidence_state: state,
    contract_count: 0,
    registered_value: 0,
    contract_ids: [],
  }]));
  for (const row of Array.isArray(rows) ? rows : []) {
    const state = Object.hasOwn(stats, row?.evidence_state) ? row.evidence_state : PERFORMANCE_EVIDENCE_STATES.NONE;
    const bucket = stats[state];
    bucket.contract_count += 1;
    bucket.registered_value += Number(row?.current_registered_amount) || 0;
    bucket.contract_ids.push(row.prime_contract_id);
  }
  return stats;
}

export function performanceEvidenceCoverageSummary(rows) {
  const list = uniqueContracts(rows);
  const states = stateStats(list);
  const located = list.length - states[PERFORMANCE_EVIDENCE_STATES.NONE].contract_count;
  return {
    total_contract_count: list.length,
    total_registered_value: list.reduce((sum, row) => sum + (Number(row?.current_registered_amount) || 0), 0),
    located_contract_count: located,
    unresolved_contract_count: states[PERFORMANCE_EVIDENCE_STATES.NONE].contract_count,
    unresolved: states[PERFORMANCE_EVIDENCE_STATES.NONE].contract_count > 0,
    states,
  };
}

export function filterPerformanceEvidenceCoverage(rows, filters = {}) {
  const state = filters.evidence_state || filters.performance_evidence_state;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (state && row.evidence_state !== state) return false;
    if (filters.agency && readerDimensionValue(row.agency) !== String(filters.agency)) return false;
    if (filters.prime_vendor && readerDimensionValue(row.prime_vendor) !== String(filters.prime_vendor)) return false;
    if (filters.registration_fiscal_year != null && filters.registration_fiscal_year !== ""
      && Number(row.registration_fiscal_year) !== Number(filters.registration_fiscal_year)) return false;
    if (filters.contract_amount_band && row.contract_amount_band !== filters.contract_amount_band) return false;
    const amount = Number(row.current_registered_amount);
    if (filters.min_amount != null && filters.min_amount !== "" && (!Number.isFinite(amount) || amount < Number(filters.min_amount))) return false;
    if (filters.max_amount != null && filters.max_amount !== "" && (!Number.isFinite(amount) || amount > Number(filters.max_amount))) return false;
    return true;
  });
}

export function groupPerformanceEvidenceCoverage(rows, { groupBy = "agency" } = {}) {
  const groups = new Map();
  for (const row of uniqueContracts(rows)) {
    const field = groupBy === "vendor" ? "prime_vendor"
      : groupBy === "registration_fiscal_year" ? "registration_fiscal_year"
        : groupBy === "amount_band" ? "contract_amount_band" : "agency";
    const rawLabel = row?.[field];
    const label = field === "registration_fiscal_year" && Number.isInteger(Number(rawLabel)) ? `FY${rawLabel}` : readerDimensionValue(rawLabel);
    if (!groups.has(label)) groups.set(label, { label, contract_ids: [], states: {} });
    const group = groups.get(label);
    group.contract_ids.push(row.prime_contract_id);
    const state = row.evidence_state;
    const bucket = group.states[state] ||= { evidence_state: state, contract_count: 0, registered_value: 0, contract_ids: [] };
    bucket.contract_count += 1;
    bucket.registered_value += Number(row.current_registered_amount) || 0;
    bucket.contract_ids.push(row.prime_contract_id);
  }
  const result = [...groups.values()].map((group) => ({
    ...group,
    contract_count: group.contract_ids.length,
    total_registered_value: Object.values(group.states).reduce((sum, state) => sum + state.registered_value, 0),
  }));
  result.sort((left, right) => right.total_registered_value - left.total_registered_value || left.label.localeCompare(right.label));
  return { groups: result, rows: uniqueContracts(rows) };
}

export function performanceEvidenceDrillThroughHref({ agency, prime_vendor, registration_fiscal_year, contract_amount_band, min_amount, max_amount, evidence_state } = {}) {
  const params = new URLSearchParams({ mode: "award" });
  if (agency && agency !== "Unknown / not published") params.set("ap_agency", agency);
  if (prime_vendor && prime_vendor !== "Unknown / not published") params.set("ap_vendor", prime_vendor);
  if (registration_fiscal_year != null && registration_fiscal_year !== "") params.set("ap_fy", String(registration_fiscal_year).replace(/^FY/, ""));
  if (contract_amount_band) params.set("ap_amount_band", contract_amount_band);
  if (min_amount != null && min_amount !== "") params.set("ap_min", String(min_amount));
  if (max_amount != null && max_amount !== "") params.set("ap_max", String(max_amount));
  if (evidence_state) params.set("ap_evidence_state", evidence_state);
  return `/browse/contracts/?${params.toString()}`;
}

export function assertNoPerformanceOverclaim(value) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_OUTPUT_KEYS.has(key)) throw new Error(`performance evidence projection contains forbidden field: ${key}`);
      visit(child);
    }
  };
  visit(value);
  return value;
}

export function performanceEvidenceSourcePassageHref(item) {
  return item?.source_passage?.url || null;
}
