/**
 * Property disposition facet pivots — join-backed scope links.
 *
 * Sale method, price band, disposition process stage, and When (temporal) are
 * shareable typed scope edges, not cosmetic restyles of client predicates.
 *
 * Obtainable-key doctrine (fail closed):
 * - sale method: only known SALE_METHODS enum values
 * - price band: only explicit numeric prices; unknown/unpriced stay outside bands
 * - process stage: hearing → auction_or_rfp → award_or_conveyance; unstaged residual
 * - temporal: soon/upcoming/past require a source event date; undated stays outside
 *
 * Pure and leaf-light: no DOM, no fetch, no parent-module imports (so Property app
 * cold-path inline reconstruction can flatten this helper alone).
 */

export const PROPERTY_DISPOSITION_FACETS_SCHEMA = "cityscroll.property_disposition_facets.v1";

import {
  intersectScopes,
  routeHashFromScope,
  scopeFromLensState,
  scopeFromRouteHash,
} from "./scope_v0.mjs";

/** Canonical sale-method keys (parity with property_commercial.SALE_METHODS). */
export const SALE_METHODS = Object.freeze([
  "online_auction",
  "public_auction",
  "sealed_bid",
  "rfp",
  "lease_auction",
]);

/** Product price-band keys (parity with property_commercial.PRICE_BANDS). */
export const PRICE_BANDS = Object.freeze([
  "all",
  "priced",
  "under_10k",
  "10k_100k",
  "100k_plus",
]);

/** Lifecycle process stages in hearing → auction/RFP → award order (not residual). */
export const DISPOSITION_LIFECYCLE_STAGES = Object.freeze([
  "hearing",
  "auction_or_rfp",
  "award_or_conveyance",
]);

/** Process-stage filter chips (ops ontology). */
export const PROP_PROCESS_STAGE_BUCKETS = Object.freeze([
  ["all", "stage_all"],
  ["hearing", "disposition_stage_hearing"],
  ["auction_or_rfp", "disposition_stage_auction_or_rfp"],
  ["award_or_conveyance", "disposition_stage_award_or_conveyance"],
  ["unstaged", "disposition_stage_unstaged"],
]);

/** Temporal (When) buckets. */
export const PROPERTY_TEMPORAL_STAGES = Object.freeze([
  ["all", "stage_all"],
  ["proposed", "stage_proposed"],
  ["soon", "stage_soon"],
  ["upcoming", "stage_upcoming"],
  ["past", "stage_past"],
]);

const TEMPORAL_KEYS = new Set(PROPERTY_TEMPORAL_STAGES.map(([id]) => id));
const PROCESS_KEYS = new Set(PROP_PROCESS_STAGE_BUCKETS.map(([id]) => id));
const PROCESS_LABEL = Object.freeze(Object.fromEntries(PROP_PROCESS_STAGE_BUCKETS));
const SALE_METHOD_LABEL = Object.freeze({
  online_auction: "sale_method_online_auction",
  public_auction: "sale_method_public_auction",
  sealed_bid: "sale_method_sealed_bid",
  rfp: "sale_method_rfp",
  lease_auction: "sale_method_lease_auction",
});
const PRICE_BAND_LABEL = Object.freeze({
  all: "price_band_all",
  priced: "price_band_priced",
  under_10k: "price_band_under_10k",
  "10k_100k": "price_band_10k_100k",
  "100k_plus": "price_band_100k_plus",
});

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function isoDay(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function normalizeSaleMethodKey(raw) {
  if (raw == null || raw === "" || raw === "all") return "all";
  const key = String(raw).trim().toLowerCase().replace(/-/g, "_");
  return SALE_METHODS.includes(key) ? key : "all";
}

export function normalizePriceBandKey(raw) {
  if (raw == null || raw === "" || raw === "all") return "all";
  const key = String(raw).trim().toLowerCase().replace(/-/g, "_");
  return PRICE_BANDS.includes(key) ? key : "all";
}

/**
 * Map amount to a price-band chip key (null amount → unpriced).
 * Product thresholds: $10k and $100k cutovers.
 * @param {number|null|undefined} amount
 */
export function priceBandForAmount(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  const n = Number(amount);
  if (n < 10000) return "under_10k";
  if (n < 100000) return "10k_100k";
  return "100k_plus";
}

/**
 * Primary labeled price amount (null when unpriced).
 * @param {object|null|undefined} commercial
 * @returns {number|null}
 */
export function commercialPriceAmount(commercial) {
  if (!commercial) return null;
  const primary = commercial.primary_price || commercial.glance?.price || null;
  if (primary && Number.isFinite(Number(primary.amount))) return Number(primary.amount);
  const facts = Array.isArray(commercial.price_facts) ? commercial.price_facts : [];
  for (const fact of facts) {
    if (fact && Number.isFinite(Number(fact.amount))) return Number(fact.amount);
  }
  return null;
}

/**
 * Days from today to a source event/close date.
 * @param {string|null|undefined} dateValue
 * @param {string|Date} [today]
 * @returns {number|null}
 */
export function propertyDaysLeft(dateValue, today = new Date()) {
  const day = isoDay(dateValue);
  if (!day) return null;
  const end = new Date(`${day}T12:00:00`);
  if (!Number.isFinite(end.getTime())) return null;
  const start = today instanceof Date ? today : new Date(`${isoDay(today) || today}T12:00:00`);
  if (!Number.isFinite(start.getTime())) return null;
  return Math.round((end - start) / 86400000);
}

/**
 * Fail-closed temporal key. Missing dates return null (outside temporal bands).
 * @param {object} row
 * @param {{ today?: string|Date }} [opts]
 */
export function propertyTemporalKey(row, opts = {}) {
  const dl = propertyDaysLeft(row?.event_date, opts.today);
  if (dl !== null && dl >= 0) return dl <= 30 ? "soon" : "upcoming";
  if (dl !== null && dl < 0) return "past";
  const type = clean(row?.type_of_notice_description) || "";
  if (/hearing/i.test(type)) return "proposed";
  return null;
}

export function normalizePropertyTemporal(raw) {
  if (raw == null || raw === "" || raw === "all") return "all";
  const key = String(raw).trim().toLowerCase().replace(/-/g, "_");
  return TEMPORAL_KEYS.has(key) ? key : "all";
}

export function normalizePropertyProcess(raw) {
  if (raw == null || raw === "" || raw === "all") return "all";
  const key = String(raw).trim().toLowerCase().replace(/-/g, "_");
  return PROCESS_KEYS.has(key) ? key : "all";
}

export function propertySaleMethodKey(row, commercialOf) {
  const commercial = typeof commercialOf === "function"
    ? commercialOf(row)
    : (row?.commercial || null);
  const method = commercial?.sale_method?.method || commercial?.glance?.sale_method || null;
  if (!method) return null;
  const key = normalizeSaleMethodKey(method);
  return key === "all" ? null : key;
}

export function propertyPriceBandKey(row, commercialOf) {
  const commercial = typeof commercialOf === "function"
    ? commercialOf(row)
    : (row?.commercial || null);
  return priceBandForAmount(commercialPriceAmount(commercial));
}

export function propertyEntryProcessKey(entry) {
  if (!entry) return "unstaged";
  if (entry.process_filter) {
    const key = normalizePropertyProcess(entry.process_filter);
    return key === "all" ? "unstaged" : key;
  }
  const stage = clean(entry.primary?.disposition_stage);
  if (stage && DISPOSITION_LIFECYCLE_STAGES.includes(stage)) return stage;
  return "unstaged";
}

/**
 * Shareable Property lens hash. Param names match the property route grammar.
 * @param {object} [baseState]
 * @param {object} [patch]
 */
export function propertyDispositionScopeHref(baseState = {}, patch = {}) {
  const base = baseState && typeof baseState === "object" ? baseState : {};
  const next = patch && typeof patch === "object" ? patch : {};
  const currentHash = base.currentHash || base.hash || "";
  const current = String(currentHash).startsWith("#property")
    ? scopeFromRouteHash(currentHash)
    : scopeFromLensState("property", base);

  // A facet pivot replaces only its own axis, then intersects the replacement
  // with the parsed scope. This is the shared composable-graph operation: all
  // unrelated place, topic, agency, and opaque entity constraints survive.
  const cleared = {
    ...current,
    facets: {
      ...current.facets,
      values: { ...(current.facets?.values || {}) },
    },
  };
  const axis = next.saleMethod !== undefined || next.method !== undefined
    ? "saleMethod"
    : next.priceBand !== undefined || next.price !== undefined
      ? "priceBand"
      : next.process !== undefined
        ? "process"
        : next.stage !== undefined || next.temporal !== undefined
          ? "stage"
          : null;
  if (axis) delete cleared.facets.values[axis];

  const constraint = scopeFromLensState("property", next);
  const composed = intersectScopes(cleared, constraint);
  return routeHashFromScope(composed, { surface: "property" });
}

function entryRows(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.members) && entry.members.length) return entry.members;
  return entry.primary ? [entry.primary] : [];
}

export function countPropertySaleMethods(entries, commercialOf) {
  const counts = { all: 0 };
  for (const method of SALE_METHODS) counts[method] = 0;
  for (const entry of entries || []) {
    counts.all += 1;
    const keys = new Set();
    for (const row of entryRows(entry)) {
      const key = propertySaleMethodKey(row, commercialOf);
      if (key) keys.add(key);
    }
    for (const key of keys) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function countPropertyPriceBands(entries, commercialOf) {
  const counts = { all: 0, priced: 0, under_10k: 0, "10k_100k": 0, "100k_plus": 0, unpriced: 0 };
  for (const entry of entries || []) {
    counts.all += 1;
    let priced = false;
    const bands = new Set();
    for (const row of entryRows(entry)) {
      const band = propertyPriceBandKey(row, commercialOf);
      if (band) {
        priced = true;
        bands.add(band);
      }
    }
    if (!priced) {
      counts.unpriced += 1;
      continue;
    }
    counts.priced += 1;
    for (const band of bands) counts[band] = (counts[band] || 0) + 1;
  }
  return counts;
}

export function countPropertyTemporalStages(entries, opts = {}) {
  const temporalOf = typeof opts.temporalOf === "function"
    ? opts.temporalOf
    : (row) => propertyTemporalKey(row, { today: opts.today });
  const counts = { all: 0, undated: 0 };
  for (const [id] of PROPERTY_TEMPORAL_STAGES) {
    if (id !== "all") counts[id] = 0;
  }
  for (const entry of entries || []) {
    counts.all += 1;
    const keys = new Set();
    for (const row of entryRows(entry)) {
      const key = temporalOf(row);
      if (key && TEMPORAL_KEYS.has(key) && key !== "all") keys.add(key);
    }
    if (!keys.size) {
      counts.undated += 1;
      continue;
    }
    for (const key of keys) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function propertySaleMethodControlModel(counts = {}, selected = "all", baseState = {}) {
  const current = normalizeSaleMethodKey(selected);
  const item = (id, label_key) => ({
    id,
    label_key,
    count: Number(counts[id]) || 0,
    pressed: current === id,
    href: propertyDispositionScopeHref(baseState, { saleMethod: id }),
    // Retain the short data key for local binding; the typed edge is the public contract.
    data_attr: "m",
    scope_edge: `property.sale_method.${id}`,
  });
  const methods = SALE_METHODS
    .filter((id) => (Number(counts[id]) || 0) > 0)
    .map((id) => item(id, SALE_METHOD_LABEL[id] || "sale_method_unknown"));
  return { all: item("all", "sale_method_all"), methods };
}

export function propertyPriceBandControlModel(counts = {}, selected = "all", baseState = {}) {
  const current = normalizePriceBandKey(selected);
  const item = (id, label_key) => ({
    id,
    label_key,
    count: Number(counts[id]) || 0,
    pressed: current === id,
    href: propertyDispositionScopeHref(baseState, { priceBand: id }),
    // Retain the short data key for local binding; the typed edge is the public contract.
    data_attr: "p",
    scope_edge: `property.price_band.${id}`,
  });
  const bands = PRICE_BANDS
    .filter((id) => id !== "all")
    .map((id) => item(id, PRICE_BAND_LABEL[id] || "price_band_all"));
  return {
    all: item("all", "price_band_all"),
    bands,
    unpriced_count: Number(counts.unpriced) || 0,
  };
}

export function propertyProcessControlModel(counts = {}, selected = "all", baseState = {}) {
  const current = normalizePropertyProcess(selected);
  const item = (id) => ({
    id,
    label_key: PROCESS_LABEL[id] || "stage_all",
    count: Number(counts[id]) || 0,
    pressed: current === id,
    href: propertyDispositionScopeHref(baseState, { process: id }),
    // Retain the short data key for local binding; the typed edge is the public contract.
    data_attr: "p",
    scope_edge: `property.disposition_stage.${id}`,
  });
  return {
    all: item("all"),
    lifecycle: DISPOSITION_LIFECYCLE_STAGES.map(item),
    unstaged: (Number(counts.unstaged) || 0) > 0 ? item("unstaged") : null,
  };
}

export function propertyTemporalControlModel(counts = {}, selected = "all", baseState = {}) {
  const current = normalizePropertyTemporal(selected);
  const item = (id, label_key) => ({
    id,
    label_key,
    count: Number(counts[id]) || 0,
    pressed: current === id,
    href: propertyDispositionScopeHref(baseState, { stage: id }),
    // Retain the short data key for local binding; the typed edge is the public contract.
    data_attr: "s",
    scope_edge: `property.when.${id}`,
  });
  const stages = PROPERTY_TEMPORAL_STAGES
    .filter(([id]) => id !== "all")
    .filter(([id]) => (Number(counts[id]) || 0) > 0)
    .map(([id, label_key]) => item(id, label_key));
  return {
    all: item("all", "stage_all"),
    stages,
    undated_count: Number(counts.undated) || 0,
  };
}

export function propertyFacetChipItems(model, kind) {
  if (!model) return [];
  if (kind === "saleMethod") return [model.all, ...(model.methods || [])];
  if (kind === "priceBand") return [model.all, ...(model.bands || [])];
  if (kind === "process") {
    return [model.all, ...(model.lifecycle || []), ...(model.unstaged ? [model.unstaged] : [])];
  }
  if (kind === "temporal") return [model.all, ...(model.stages || [])];
  return [];
}
