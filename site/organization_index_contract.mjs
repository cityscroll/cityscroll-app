// Organization index contract: the pure, browser- and Worker-safe part shared by the builder, the
// search module and the record assembler. No Node built-ins here.

/** Closed list of index sources, in the fixed order used for display and hashing. */
export const SOURCES = Object.freeze([
  { id: "ocp_recent_contract_awards", code: "ocp", kind: "city_award", label: "Recent Contract Awards (City Record award notices, NYC Open Data qyyg-4tf5)", url: "https://data.cityofnewyork.us/d/qyyg-4tf5", engine_artifact: "site/data/ocp_awards_warehouse_lookup.json", has_amounts: true },
  { id: "checkbook_registered_contracts", code: "cbr", kind: "city_award", label: "Checkbook NYC registered contracts", url: "https://www.checkbooknyc.com/", engine_artifact: "site/data/analytics_registered_contracts/shard-*.json", has_amounts: true },
  { id: "passport_contracts", code: "ppt", kind: "city_award", label: "PASSPort Public contracts", url: "https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public", engine_artifact: "site/data/procurement_spine_sources.json rows.passport_contracts", has_amounts: true },
  { id: "checkbook_prime_vendor_contracts", code: "cbv", kind: "city_award", label: "Checkbook NYC contracts by prime vendor (with M/WBE category)", url: "https://www.checkbooknyc.com/", engine_artifact: "site/data/procurement_spine_sources.json rows.checkbook_contracts", has_amounts: false },
  { id: "checkbook_nycha_contracts", code: "nyh", kind: "city_award", label: "Checkbook NYC NYCHA contracts", url: "https://www.checkbooknyc.com/", engine_artifact: "site/data/procurement_spine_sources.json rows.checkbook_nycha_contracts", has_amounts: true },
  { id: "checkbook_spending", code: "cbs", kind: "city_payment", label: "Checkbook NYC spending (payees)", url: "https://www.checkbooknyc.com/", engine_artifact: "site/data/procurement_spine_sources.json rows.checkbook_spending", has_amounts: true },
  { id: "doing_business_entities", code: "dbe", kind: "city_register", label: "Doing Business Search - Entities (NYC Open Data 72mk-a8z7)", url: "https://data.cityofnewyork.us/d/72mk-a8z7", engine_artifact: "site/data/doing_business_warehouse_lookup.json", has_amounts: false },
  { id: "sbs_certified_businesses", code: "sbs", kind: "directory", label: "SBS Certified Business List (NYC Open Data ci93-uc8s)", url: "https://data.cityofnewyork.us/d/ci93-uc8s", engine_artifact: "site/data/sbs_certified_businesses.json", has_amounts: false },
  { id: "irs_eo_bmf_ny", code: "irs", kind: "register", label: "IRS Exempt Organizations Business Master File, New York", url: "https://www.irs.gov/pub/irs-soi/eo_ny.csv", engine_artifact: "site/data/irs_eo_bmf_ny/manifest.json", has_amounts: false },
  { id: "nys_dol_contractor_registry", code: "dol", kind: "register", label: "NYS Department of Labor Contractor Registry (data.ny.gov i4jv-zkey)", url: "https://data.ny.gov/d/i4jv-zkey", engine_artifact: "site/data/nys_dol_contractor_registry/manifest.json", has_amounts: false },
  { id: "nyc_sca_prequalified_firms", code: "sca", kind: "register", label: "NYC School Construction Authority Prequalified Firms (NYC Open Data szkz-syh6)", url: "https://data.cityofnewyork.us/d/szkz-syh6", engine_artifact: "site/data/nyc_sca_prequalified_firms/manifest.json", has_amounts: false },
]);
export const SOURCE_IDS = Object.freeze(SOURCES.map((s) => s.id));
export const CITY_AWARD_SOURCES = Object.freeze(SOURCES.filter((s) => s.kind === "city_award").map((s) => s.id));
export const SOURCE_BY_CODE = Object.freeze(Object.fromEntries(SOURCES.map((s) => [s.code, s])));
export const SOURCE_BY_ID = Object.freeze(Object.fromEntries(SOURCES.map((s) => [s.id, s])));

export const INDEX_SCHEMA = "cityscroll.organization_index.v1";
export const ENTRY_SHARD_SCHEMA = "cityscroll.organization_index.entries.v1";
export const ID_SHARD_SCHEMA = "cityscroll.organization_index.ids.v1";
export const STEMS_SCHEMA = "cityscroll.organization_index.stems.v1";
export const MANIFEST_PATH = "data/organization_index.json";
export const DIR = "data/organization_index";
export const STEMS_PATH = "data/organization_index/stems.json";
export const DEFAULT_LIMITS = Object.freeze({
  entry_shard_max_bytes: 256 * 1024,
  id_buckets: 64,
  max_name_variants: 10,
  max_transaction_refs: 5,
  min_delete_token_length: 4,
});
/** Sources whose record id is an identifier a person can type (every id kept in the entry). */
export const IDENTIFIER_SOURCES = Object.freeze({
  sbs_certified_businesses: "sbs",
  irs_eo_bmf_ny: "ein",
  nys_dol_contractor_registry: "dol",
  nyc_sca_prequalified_firms: "sca",
});
export const IDENTIFIER_KINDS = Object.freeze(Object.values(IDENTIFIER_SOURCES));

/** Same FNV-1a 32-bit hash the engine uses for vendor-profile buckets (worker/src/vendor_profile.mjs:50). */
export function fnv1a(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const keyBucket = (key, buckets) => (fnv1a(key) % buckets).toString(16).padStart(2, "0");

/** Stem tokens: split on anything that is not a letter or digit. */
export function stemTokens(stem) {
  return String(stem).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Expanded entry used by search and the record assembler. */
export function decodeEntry(raw, ordinal = null) {
  const sources = {};
  const ids = {};
  for (const [code, b] of Object.entries(raw.x)) {
    const src = SOURCE_BY_CODE[code];
    if (!src) throw new Error(`unknown source code ${code}`);
    const kind = IDENTIFIER_SOURCES[src.id];
    if (kind) ids[kind] = b.i || [];
    sources[src.id] = {
      records: b.r,
      via: raw.w ? [] : (b.v || ["name"]),
      amount_total: src.has_amounts ? (b.a ?? null) : null,
      last_date: b.l ?? null,
      ref_count: b.c ?? (b.i ? b.i.length : 0),
      refs: b.i || [],
      zips: b.z || [],
      ...(b.p ? { sbs_programmes: b.p } : {}),
      ...(b.m ? { mwbe_categories: b.m } : {}),
    };
  }
  const names = raw.w ? [] : [...(raw.n || []).map(([name, count]) => ({ name, count, via: "name" })), ...(raw.d || []).map(([name, count]) => ({ name, count, via: "dba" }))];
  const source_ids = SOURCE_IDS.filter((id) => sources[id]);
  const display_name = raw.w ? null : (raw.n?.[0]?.[0] || raw.d?.[0]?.[0] || null);
  return {
    ordinal,
    stem: raw.s,
    display_name,
    name_withheld: raw.w === 1,
    names,
    names_total: raw.N ?? names.length,
    source_ids,
    sources,
    ids,
    facets: {
      has_city_awards: CITY_AWARD_SOURCES.some((id) => sources[id]),
      sbs_certified: Boolean(sources.sbs_certified_businesses),
      sbs_programmes: sources.sbs_certified_businesses?.sbs_programmes || [],
      nonprofit_in_irs: Boolean(sources.irs_eo_bmf_ny),
    },
  };
}

/** Bit per source in SOURCES order; lets search rank by source coverage without loading entries. */
export function sourceMask(rawEntry) {
  let m = 0;
  SOURCES.forEach((s, i) => { if (rawEntry.x[s.code]) m |= 1 << i; });
  return m;
}
export const maskSources = (mask) => SOURCES.filter((_, i) => mask & (1 << i)).map((s) => s.id);

