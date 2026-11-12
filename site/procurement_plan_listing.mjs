// Agency procurement-plan listing over the committed planning payload.
//
// Pure reader over cityscroll.procurement_planning.manifest.v1 and its
// cityscroll.procurement_planning.shard.v1 "plans" shards. It lists what an
// agency says it plans to buy, as PLANS, each traceable to its workbook, sheet
// and row. It never reads the capital_projects or bridge_edges collections,
// never joins a plan to a notice or solicitation, never infers a PIN, a budget
// or a participation goal, and never turns a missing value into a zero: every
// absent field stays null and is named in the row's not_published list.
//
// Built-ins only. The loader verifies shard hashes with WebCrypto, so the same
// module runs in Node 20+ and in a browser or Worker.

export const PLAN_LISTING_SCHEMA = "cityscroll.procurement_plan_listing.v1";
export const PLANNING_MANIFEST_SCHEMA = "cityscroll.procurement_planning.manifest.v1";
export const PLANNING_SHARD_SCHEMA = "cityscroll.procurement_planning.shard.v1";
export const PLANNING_MANIFEST_PATH = "site/data/procurement_planning_payload.json";
export const PLAN_SOURCES = Object.freeze({ ll1: "mocs_ll1", ll63: "mocs_ll63" });
const SOURCE_SHORT = Object.freeze({ mocs_ll1: "ll1", mocs_ll63: "ll63" });

// Every real plan row in the FY2027 collection carries a MOCS plan id of this
// shape (FY27NACS1, FY27RNACS2, FY27NDPR686). The only rows that do not are the
// drop-down list table each Local Law 1 sheet keeps at its foot (rows 10584 to
// 10625: "Exclusions", "Will Not Be Renewed/Extended", "$200K or Below"), which
// the baseline parser ingests because column B holds text there. Those rows are
// withheld from listing and counted, never silently dropped.
export const PLAN_ID_PATTERN = /^FY\d{2}[A-Z]/;
export const WITHHELD_WORKBOOK_LIST_ROW = "workbook_list_row";

export const LISTING_LIMITS = Object.freeze({ default_limit: 25, max_limit: 100 });
export const SORTS = Object.freeze(["source_order", "amount_desc", "quarter_asc", "term_start_asc"]);
export const QUARTER_VALUES = Object.freeze([1, 2, 3, 4]);
export const NOT_PUBLISHED = "not_published";

// Fields reported in not_published when null. vendor is only a column of the
// Local Law 63 renewal sheets, so its absence elsewhere is not a gap.
export const NOT_PUBLISHED_FIELDS = Object.freeze([
  "description",
  "procurement_method",
  "industry",
  "quarter",
  "term_start",
  "term_end",
  "estimated_amount",
  "procurement_probability",
]);

// The closed set of keys a listed row may carry. Anything else (a goal, a
// percentage, a matched notice or solicitation id) cannot leave this module.
export const ROW_KEYS = Object.freeze([
  "kind",
  "source",
  "source_label",
  "source_record_id",
  "plan_id",
  "agency_code",
  "agency_id",
  "agency_published",
  "agency_key",
  "description",
  "procurement_method",
  "industry",
  "fiscal_year",
  "quarter",
  "term_start",
  "term_end",
  "estimated_amount",
  "procurement_probability",
  "vendor_published",
  "published_identifiers",
  "quality_flags",
  "source_url",
  "source_sheet",
  "source_row",
  "shard",
  "not_published",
]);

// Reader-facing wording contract (English). The same keys land in site/i18n.js
// and in each site/i18n/lang/<lang>.js; consumers pass their own t().
export const PLAN_READER_STRINGS = Object.freeze({
  plan_reader_kind_label: "Agency procurement plan",
  plan_reader_not_solicitation: "This is a plan the agency published. The agency may change it, delay it, or leave it without opening responses.",
  plan_reader_source_ll1: "Local Law 1 plan (anticipated contracting actions)",
  plan_reader_source_ll63: "Local Law 63 plan (standard and professional services)",
  plan_reader_quarter: "Solicitation planned for quarter {quarter} of fiscal year {fiscal_year}",
  plan_reader_quarter_missing: "Planned quarter not published",
  plan_reader_fiscal_year_span: "New York City fiscal year {fiscal_year} runs from July 1, {start_year} to June 30, {fiscal_year}.",
  plan_reader_amount: "Agency estimate: {amount}",
  plan_reader_amount_missing: "Estimated amount not published as a number",
  plan_reader_probability: "Agency's stated likelihood: {value}",
  plan_reader_probability_missing: "Likelihood not published",
  plan_reader_provenance: "From {file}, sheet {sheet}, row {row}",
  plan_reader_flag_published_term_end_before_start: "The published end date is earlier than the published start date.",
});

export function enT(key, vars = {}) {
  const template = PLAN_READER_STRINGS[key];
  if (template == null) return key;
  return template.replace(/\{([a-z_]+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

export function formatUsd(amount) {
  const whole = Math.round(Number(amount) * 100) / 100;
  const [int, frac] = whole.toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === "00" ? `$${grouped}` : `$${grouped}.${frac}`;
}

/** Publisher agency code: the workbook file-name prefix MOCS assigns (ACS_LL1_FY27.xlsx -> ACS). */
export function agencyCodeFromUrl(url) {
  const file = String(url || "").split("?")[0].split("/").pop() || "";
  const code = file.split("_")[0];
  return code && code !== file ? code.toUpperCase() : null;
}

export function isWorkbookListRow(row) {
  return typeof row?.plan_id === "string" && row.plan_id !== "" && !PLAN_ID_PATTERN.test(row.plan_id);
}

const refusal = (reason, detail = null) => ({ schema: PLAN_LISTING_SCHEMA, status: "refused", reason, detail });

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseJson(bytes) {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

const isString = (v) => typeof v === "string";
const isNullableString = (v) => v === null || typeof v === "string";

function rowShapeError(row) {
  if (!row || typeof row !== "object") return "row is not an object";
  if (!Object.hasOwn(SOURCE_SHORT, row.source)) return `unexpected row source ${String(row.source)}`;
  for (const key of ["source_record_id", "source_url", "source_sheet", "agency_key"]) {
    if (!isString(row[key]) || !row[key]) return `${key} missing`;
  }
  if (!Number.isInteger(row.source_row) || row.source_row < 1) return "source_row missing";
  if (!Number.isInteger(row.fiscal_year)) return "fiscal_year missing";
  for (const key of ["plan_id", "description", "procurement_method", "industry", "term_start", "term_end", "agency"]) {
    if (!isNullableString(row[key])) return `${key} has the wrong type`;
  }
  if (row.quarter !== null && !QUARTER_VALUES.includes(row.quarter)) return "quarter out of range";
  if (row.budget !== null) {
    if (typeof row.budget !== "object" || typeof row.budget.amount !== "number" || row.budget.currency !== "USD" || row.budget.basis !== "estimated_amount") {
      return "budget is not a published estimated amount";
    }
  }
  if (!Array.isArray(row.published_identifiers) || !Array.isArray(row.quality_flags)) return "identifier or flag list missing";
  if (Object.hasOwn(row, "procurement_probability") && !isNullableString(row.procurement_probability)) return "procurement_probability has the wrong type";
  return null;
}

/**
 * Load and verify the committed plan population.
 *
 * readBytes(repoRelativePath) returns a Uint8Array/Buffer, or null when absent.
 * A missing or malformed manifest or shard is a refusal, never an empty success.
 */
export async function loadPlanPopulation(readBytes, { manifestPath = PLANNING_MANIFEST_PATH } = {}) {
  let manifestBytes;
  try { manifestBytes = await readBytes(manifestPath); } catch (error) { return refusal("payload_unreadable", String(error?.message || error)); }
  if (manifestBytes == null) return refusal("payload_missing", manifestPath);
  const parsed = parseJson(manifestBytes);
  if (!parsed.ok) return refusal("payload_malformed", parsed.error);
  const manifest = parsed.value;
  if (manifest?.schema !== PLANNING_MANIFEST_SCHEMA) return refusal("payload_malformed", `schema ${String(manifest?.schema)}`);
  const plans = manifest?.collections?.plans;
  if (!plans || !Number.isInteger(plans.rows) || !Array.isArray(plans.shards) || !Number.isInteger(manifest.fiscal_year)) {
    return refusal("payload_malformed", "plans collection missing");
  }
  const rows = [];
  for (const [index, shard] of plans.shards.entries()) {
    if (!isString(shard?.path) || !/^[0-9a-f]{64}$/.test(String(shard?.sha256)) || !Number.isInteger(shard?.rows)) {
      return refusal("payload_malformed", `shard ${index} descriptor`);
    }
    let bytes;
    try { bytes = await readBytes(shard.path); } catch (error) { return refusal("shard_unreadable", `${shard.path}: ${String(error?.message || error)}`); }
    if (bytes == null) return refusal("shard_missing", shard.path);
    if (await sha256Hex(bytes) !== shard.sha256) return refusal("shard_hash_mismatch", shard.path);
    const body = parseJson(bytes);
    if (!body.ok) return refusal("payload_malformed", `${shard.path}: ${body.error}`);
    const data = body.value;
    if (data?.schema !== PLANNING_SHARD_SCHEMA || data?.collection !== "plans" || data?.index !== index || !Array.isArray(data?.rows)) {
      return refusal("payload_malformed", `${shard.path}: shard header`);
    }
    if (data.rows.length !== shard.rows) return refusal("row_count_mismatch", shard.path);
    for (const [rowIndex, row] of data.rows.entries()) {
      const error = rowShapeError(row);
      if (error) return refusal("payload_malformed", `${shard.path} row ${rowIndex}: ${error}`);
      rows.push({ row, shard: shard.path, shard_index: index, row_index: rowIndex });
    }
  }
  if (rows.length !== plans.rows) return refusal("row_count_mismatch", `manifest ${plans.rows}, shards ${rows.length}`);
  const keys = new Set();
  for (const entry of rows) {
    const key = provenanceKey(entry.row);
    if (keys.has(key)) return refusal("payload_malformed", `duplicate provenance ${key}`);
    keys.add(key);
  }
  return {
    schema: PLAN_LISTING_SCHEMA,
    status: "ok",
    fiscal_year: manifest.fiscal_year,
    generated_at: manifest.generated_at ?? null,
    version: (await sha256Hex(manifestBytes)).slice(0, 16),
    manifest_path: manifestPath,
    rows,
  };
}

/** (source_url, source_sheet, source_row) is unique across the population; source_record_id is not. */
export function provenanceKey(row) {
  return `${row.source_url}\u0000${row.source_sheet}\u0000${String(row.source_row).padStart(7, "0")}`;
}

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function tieBreak(a, b) {
  return compareText(a.row.source_url, b.row.source_url)
    || compareText(a.row.source_sheet, b.row.source_sheet)
    || a.row.source_row - b.row.source_row;
}

function nullsLast(a, b, cmp) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return cmp(a, b);
}

const COMPARATORS = {
  source_order: (a, b) => compareText(agencyCodeFromUrl(a.row.source_url) || "", agencyCodeFromUrl(b.row.source_url) || "")
    || compareText(a.row.source, b.row.source) || tieBreak(a, b),
  amount_desc: (a, b) => nullsLast(a.row.budget?.amount, b.row.budget?.amount, (x, y) => y - x) || tieBreak(a, b),
  quarter_asc: (a, b) => nullsLast(a.row.quarter, b.row.quarter, (x, y) => x - y) || tieBreak(a, b),
  term_start_asc: (a, b) => nullsLast(a.row.term_start, b.row.term_start, compareText) || tieBreak(a, b),
};

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeQuery(query = {}) {
  const errors = [];
  const q = {};
  const selectors = ["agency_id", "agency_code", "agency_key"].filter((k) => query[k] != null);
  if (selectors.length > 1) errors.push("choose one of agency_id, agency_code, agency_key");
  for (const k of selectors) {
    if (!isString(query[k]) || !query[k].trim()) errors.push(`${k} must be a non-empty string`);
    else q[k] = k === "agency_code" ? query[k].trim().toUpperCase() : query[k].trim();
  }
  q.source = query.source ?? "both";
  if (!["both", "ll1", "ll63"].includes(q.source)) errors.push("source must be both, ll1 or ll63");
  if (query.industry != null) {
    if (!isString(query.industry) || !query.industry) errors.push("industry must be a published industry label or not_published");
    else q.industry = query.industry;
  }
  if (query.quarter != null) {
    if (query.quarter !== NOT_PUBLISHED && !QUARTER_VALUES.includes(query.quarter)) errors.push("quarter must be 1, 2, 3, 4 or not_published");
    else q.quarter = query.quarter;
  }
  for (const k of ["amount_min", "amount_max"]) {
    if (query[k] != null) {
      if (typeof query[k] !== "number" || !Number.isFinite(query[k]) || query[k] < 0) errors.push(`${k} must be a non-negative number`);
      else q[k] = query[k];
    }
  }
  if (q.amount_min != null && q.amount_max != null && q.amount_min > q.amount_max) errors.push("amount_min exceeds amount_max");
  q.sort = query.sort ?? "source_order";
  if (!SORTS.includes(q.sort)) errors.push(`sort must be one of ${SORTS.join(", ")}`);
  q.limit = query.limit ?? LISTING_LIMITS.default_limit;
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > LISTING_LIMITS.max_limit) errors.push(`limit must be 1..${LISTING_LIMITS.max_limit}`);
  return { q, errors };
}

function queryDigest(q) {
  const { limit, ...rest } = q;
  return fnv1a(JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]])));
}

/** Agencies the index links to engine ids, plus engine ids known to have no plan rows. */
function resolveAgency(q, index) {
  const agencies = Array.isArray(index?.agencies) ? index.agencies : [];
  if (q.agency_id) {
    const codes = agencies.filter((a) => a.agency_id === q.agency_id).map((a) => a.agency_code);
    if (codes.length) return { known: true, selector: { agency_id: q.agency_id }, codes };
    if ((index?.known_agencies_without_rows || []).includes(q.agency_id)) return { known: true, selector: { agency_id: q.agency_id }, codes: [] };
    return { known: false, selector: { agency_id: q.agency_id } };
  }
  if (q.agency_code) {
    const hit = agencies.find((a) => a.agency_code === q.agency_code);
    return hit ? { known: true, selector: { agency_code: q.agency_code }, codes: [hit.agency_code] } : { known: false, selector: { agency_code: q.agency_code } };
  }
  if (q.agency_key) {
    const hit = agencies.filter((a) => (a.agency_keys || []).includes(q.agency_key));
    return hit.length ? { known: true, selector: { agency_key: q.agency_key }, codes: hit.map((a) => a.agency_code), key: q.agency_key } : { known: false, selector: { agency_key: q.agency_key } };
  }
  return { known: true, selector: null, codes: null };
}

export function projectRow(entry, index) {
  const row = entry.row;
  const agencyCode = agencyCodeFromUrl(row.source_url);
  const link = (index?.agencies || []).find((a) => a.agency_code === agencyCode);
  const source = SOURCE_SHORT[row.source];
  const out = {
    kind: "plan",
    source,
    source_label: PLAN_READER_STRINGS[source === "ll1" ? "plan_reader_source_ll1" : "plan_reader_source_ll63"],
    source_record_id: row.source_record_id,
    plan_id: row.plan_id ?? null,
    agency_code: agencyCode,
    agency_id: link?.agency_id ?? null,
    agency_published: row.agency ?? null,
    agency_key: row.agency_key,
    description: row.description ?? null,
    procurement_method: row.procurement_method ?? null,
    industry: row.industry ?? null,
    fiscal_year: row.fiscal_year,
    quarter: row.quarter ?? null,
    term_start: row.term_start ?? null,
    term_end: row.term_end ?? null,
    estimated_amount: row.budget ? { amount: row.budget.amount, currency: "USD", basis: "estimated_amount" } : null,
    procurement_probability: row.procurement_probability ?? null,
    vendor_published: row.vendor ?? null,
    published_identifiers: [...row.published_identifiers],
    quality_flags: [...row.quality_flags],
    source_url: row.source_url,
    source_sheet: row.source_sheet,
    source_row: row.source_row,
    shard: entry.shard,
  };
  out.not_published = NOT_PUBLISHED_FIELDS.filter((field) => out[field] == null);
  return out;
}

/**
 * List plans. population comes from loadPlanPopulation; index is the parsed
 * cityscroll.procurement_plan_index.v1 artifact (agency codes, engine links,
 * engine agencies known to have no rows).
 */
export function listPlans(population, query = {}, { index = null } = {}) {
  if (population?.status !== "ok" || !Array.isArray(population?.rows)) {
    return refusal("population_unavailable", population?.reason ?? null);
  }
  const { q, errors } = normalizeQuery(query);
  if (errors.length) return { schema: PLAN_LISTING_SCHEMA, status: "invalid_query", errors };
  const agency = resolveAgency(q, index);
  if (!agency.known) return { schema: PLAN_LISTING_SCHEMA, status: "unknown_agency", selector: agency.selector };

  const sourceFilter = q.source === "both" ? null : PLAN_SOURCES[q.source];
  const scoped = population.rows.filter((entry) => {
    if (sourceFilter && entry.row.source !== sourceFilter) return false;
    if (agency.codes && !agency.codes.includes(agencyCodeFromUrl(entry.row.source_url))) return false;
    if (agency.key && entry.row.agency_key !== agency.key) return false;
    return true;
  });
  const withheld = scoped.filter((entry) => isWorkbookListRow(entry.row));
  const listable = scoped.filter((entry) => !isWorkbookListRow(entry.row));
  const missing = { industry: 0, quarter: 0, estimated_amount: 0 };
  const matches = listable.filter((entry) => {
    const row = entry.row;
    if (q.industry != null) {
      if (q.industry === NOT_PUBLISHED) { if (row.industry != null) return false; }
      else if (row.industry == null) { missing.industry += 1; return false; }
      else if (row.industry !== q.industry) return false;
    }
    if (q.quarter != null) {
      if (q.quarter === NOT_PUBLISHED) { if (row.quarter != null) return false; }
      else if (row.quarter == null) { missing.quarter += 1; return false; }
      else if (row.quarter !== q.quarter) return false;
    }
    if (q.amount_min != null || q.amount_max != null) {
      const amount = row.budget?.amount;
      if (amount == null) { missing.estimated_amount += 1; return false; }
      if (q.amount_min != null && amount < q.amount_min) return false;
      if (q.amount_max != null && amount > q.amount_max) return false;
    }
    return true;
  });
  matches.sort(COMPARATORS[q.sort]);

  const digest = queryDigest(q);
  let offset = 0;
  if (query.cursor != null) {
    const match = /^([0-9a-f]{16})\.([0-9a-f]{8})\.(\d+)$/.exec(String(query.cursor));
    if (!match || match[1] !== population.version || match[2] !== digest || Number(match[3]) > matches.length) {
      return { schema: PLAN_LISTING_SCHEMA, status: "invalid_query", errors: ["cursor does not belong to this population and query"] };
    }
    offset = Number(match[3]);
  }
  const page = matches.slice(offset, offset + q.limit).map((entry) => projectRow(entry, index));
  const next = offset + q.limit < matches.length ? `${population.version}.${digest}.${offset + q.limit}` : null;
  const flagCounts = {};
  for (const entry of matches) for (const flag of entry.row.quality_flags) flagCounts[flag] = (flagCounts[flag] || 0) + 1;
  return {
    schema: PLAN_LISTING_SCHEMA,
    status: "ok",
    population_version: population.version,
    fiscal_year: population.fiscal_year,
    query: q,
    agency: agency.selector ? { ...agency.selector, known: true, agency_codes: agency.codes || [] } : null,
    empty_reason: scoped.length === 0 && agency.selector ? "no_plan_workbook_in_collection" : null,
    total: matches.length,
    offset,
    returned: page.length,
    next_cursor: next,
    withheld: { [WITHHELD_WORKBOOK_LIST_ROW]: withheld.length },
    excluded_for_missing_value: missing,
    quality_flags: flagCounts,
    rows: page,
  };
}

/** Render one listed row with the wording contract. t defaults to the English table. */
export function renderPlanRow(row, { t = enT, formatMoney = formatUsd } = {}) {
  const fiscalYear = row.fiscal_year;
  const file = String(row.source_url).split("/").pop();
  return {
    kind_label: t("plan_reader_kind_label"),
    not_solicitation: t("plan_reader_not_solicitation"),
    source: t(row.source === "ll1" ? "plan_reader_source_ll1" : "plan_reader_source_ll63"),
    quarter: row.quarter != null
      ? t("plan_reader_quarter", { quarter: row.quarter, fiscal_year: fiscalYear })
      : t("plan_reader_quarter_missing"),
    fiscal_year_span: t("plan_reader_fiscal_year_span", { fiscal_year: fiscalYear, start_year: fiscalYear - 1 }),
    amount: row.estimated_amount
      ? t("plan_reader_amount", { amount: formatMoney(row.estimated_amount.amount) })
      : t("plan_reader_amount_missing"),
    probability: row.procurement_probability != null
      ? t("plan_reader_probability", { value: row.procurement_probability })
      : t("plan_reader_probability_missing"),
    provenance: t("plan_reader_provenance", { file, sheet: row.source_sheet, row: row.source_row }),
    quality: row.quality_flags.map((flag) => {
      const key = `plan_reader_flag_${flag}`;
      return Object.hasOwn(PLAN_READER_STRINGS, key) ? t(key) : flag;
    }),
  };
}
