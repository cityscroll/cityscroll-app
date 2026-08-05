/**
 * DCAS fleet-auction inventory from NYC Open Data (ynic-uz5i).
 *
 * These are goods-surplus records, not real-property dispositions. They may
 * share the Property lens's auction-prep surface, but they must never enter
 * parcel chains, BBL joins, map counts, or parcel exports.
 */

export const DCAS_VEHICLE_AUCTION_SCHEMA = "cityscroll.dcas_vehicle_auctions.v1";
export const DCAS_VEHICLE_AUCTION_DATASET = "ynic-uz5i";
export const DCAS_VEHICLE_AUCTION_MAX_ROWS = 500;
// The publisher describes this feed as weekly. One missed weekly publication is
// still usable with an explicit as-of label; after that, do not call the rows live.
export const DCAS_VEHICLE_AUCTION_MAX_STALE_DAYS = 8;
export const DCAS_VEHICLE_AUCTION_PROVENANCE_NOTICE_ID = "20251106024";
export const DCAS_VEHICLE_AUCTION_BASIS = Object.freeze({
  domain: "goods_surplus",
  asset_class: "goods",
  commercial_category: "vehicle",
  real_property: false,
  include_in_parcel_chains: false,
  include_in_map_counts: false,
  include_in_parcel_exports: false,
});

function isoDay(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match || !Number.isFinite(Date.parse(`${match[1]}T00:00:00Z`))) return null;
  return match[1];
}

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function safeYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}

function safeAmount(value) {
  if (value == null || value === "") return null;
  const amount = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function safeUrl(value) {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeDcasVehicleAuction(row = {}) {
  const closeDate = isoDay(row.auction_close_date);
  const make = clean(row.make);
  const model = clean(row.model);
  const vin = clean(row.vin);
  if (!closeDate || (!make && !model && !vin)) return null;
  const normalized = {
    close_date: closeDate,
    year: safeYear(row.year),
    make,
    model,
    vin,
    basis: "goods_surplus",
    commercial_category: "vehicle",
    real_property: false,
    timed_events: [{
      kind: "auction_end",
      date: closeDate,
      start: closeDate,
      end: closeDate,
      source: "dcas_vehicle_auction",
    }],
  };
  const description = clean(row.description || row.vehicle_description || row.item_description);
  const lotUrl = safeUrl(row.lot_url || row.auction_url || row.item_url || row.govdeals_url);
  const currentBid = safeAmount(row.current_bid ?? row.current_bid_amount ?? row.high_bid);
  const startingPrice = safeAmount(row.starting_price ?? row.starting_bid ?? row.minimum_bid);
  if (description) normalized.description = description;
  if (lotUrl) normalized.lot_url = lotUrl;
  if (currentBid != null) normalized.current_bid = currentBid;
  if (startingPrice != null) normalized.starting_price = startingPrice;
  return normalized;
}

export function groupDcasVehicleAuctionRows(rows = []) {
  const unique = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeDcasVehicleAuction(raw);
    if (!row) continue;
    const key = `${row.close_date}|${row.vin || ""}|${row.year || ""}|${row.make || ""}|${row.model || ""}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  const groups = new Map();
  for (const row of unique.values()) {
    if (!groups.has(row.close_date)) groups.set(row.close_date, []);
    groups.get(row.close_date).push(row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([closeDate, vehicles]) => ({
      close_date: closeDate,
      count: vehicles.length,
      vehicles: vehicles.sort((a, b) => (
        String(a.make || "").localeCompare(String(b.make || ""))
        || String(a.model || "").localeCompare(String(b.model || ""))
        || String(a.vin || "").localeCompare(String(b.vin || ""))
      )),
    }));
}

export function buildDcasVehicleAuctionSnapshot(rows, options = {}) {
  const asOf = isoDay(options.asOf) || new Date().toISOString().slice(0, 10);
  const observedAt = options.observedAt || new Date().toISOString();
  const batches = groupDcasVehicleAuctionRows(rows);
  const open = batches.filter((batch) => batch.close_date >= asOf);
  const recent = batches.filter((batch) => batch.close_date < asOf);
  return {
    schema: DCAS_VEHICLE_AUCTION_SCHEMA,
    schema_version: 1,
    delivery_tier: "inline-at-build",
    source: {
      id: "dcas-vehicle-auction-list",
      name: "DCAS Vehicle Auction List",
      owner: "NYC Department of Citywide Administrative Services",
      dataset: DCAS_VEHICLE_AUCTION_DATASET,
      landing_page: `https://data.cityofnewyork.us/d/${DCAS_VEHICLE_AUCTION_DATASET}`,
      official_guide: "https://www.nyc.gov/site/dcas/business/vehicle-auction.page",
      marketplace: "https://www.govdeals.com/en/nyc-dcas-fleet",
      provenance_notice_id: DCAS_VEHICLE_AUCTION_PROVENANCE_NOTICE_ID,
      provenance_notice_url: `https://a856-cityrecord.nyc.gov/RequestDetail/${DCAS_VEHICLE_AUCTION_PROVENANCE_NOTICE_ID}`,
    },
    taxonomy: { ...DCAS_VEHICLE_AUCTION_BASIS },
    vintage: {
      observed_at: observedAt,
      source_updated_at: options.sourceUpdatedAt || null,
      as_of: asOf,
    },
    query: options.query || null,
    checkpoint: {
      checkpointed: true,
      pages: Number(options.pages) || 1,
      bounded_limit: Number(options.limit) || DCAS_VEHICLE_AUCTION_MAX_ROWS,
      truncated: options.truncated === true,
    },
    counts: {
      source_total: Number(options.sourceTotal) || null,
      bounded_rows: batches.reduce((sum, batch) => sum + batch.count, 0),
      batches: batches.length,
      open_rows: open.reduce((sum, batch) => sum + batch.count, 0),
      open_batches: open.length,
      recent_rows: recent.reduce((sum, batch) => sum + batch.count, 0),
    },
    batches,
  };
}

/**
 * Surface selection: all open batches, or one latest closed batch when no rows
 * are currently open. Closed inventory remains context, never an active bid.
 */
export function selectDcasVehicleAuctionSurface(snapshot, options = {}) {
  const today = isoDay(options.today) || new Date().toISOString().slice(0, 10);
  const batches = Array.isArray(snapshot?.batches) ? snapshot.batches : [];
  const open = batches.filter((batch) => isoDay(batch.close_date) >= today);
  if (open.length) {
    return {
      status: "open",
      batches: [...open].sort((a, b) => a.close_date.localeCompare(b.close_date)),
      count: open.reduce((sum, batch) => sum + Number(batch.count || 0), 0),
      latest_close_date: null,
    };
  }
  const latest = batches
    .filter((batch) => isoDay(batch.close_date) && batch.close_date < today)
    .sort((a, b) => b.close_date.localeCompare(a.close_date))[0] || null;
  return {
    status: latest ? "closed" : "empty",
    batches: latest ? [latest] : [],
    count: latest ? Number(latest.count || 0) : 0,
    latest_close_date: latest?.close_date || null,
  };
}

function dayDistance(start, end) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86400000)) : null;
}

/**
 * The feed is weekly, but a committed artifact can outlive a successful build.
 * Keep this check beside the pure source contract so every delivery surface can
 * distinguish "latest known" from "current" without guessing.
 */
export function dcasVehicleAuctionFreshness(snapshot, options = {}) {
  const today = isoDay(options.today) || new Date().toISOString().slice(0, 10);
  const observed = isoDay(snapshot?.vintage?.source_updated_at)
    || isoDay(snapshot?.vintage?.observed_at)
    || isoDay(snapshot?.vintage?.as_of);
  const maxStaleDays = Number.isFinite(Number(options.maxStaleDays))
    ? Number(options.maxStaleDays)
    : DCAS_VEHICLE_AUCTION_MAX_STALE_DAYS;
  const ageDays = observed ? dayDistance(observed, today) : null;
  return {
    status: observed && ageDays != null && ageDays <= maxStaleDays ? "fresh" : "stale",
    observed_date: observed,
    age_days: ageDays,
    max_stale_days: maxStaleDays,
  };
}

export function detectDcasVehicleAuctionSnapshot(snapshot) {
  const findings = [];
  if (snapshot?.schema !== DCAS_VEHICLE_AUCTION_SCHEMA) findings.push("schema");
  if (snapshot?.source?.dataset !== DCAS_VEHICLE_AUCTION_DATASET) findings.push("source_dataset");
  if (snapshot?.taxonomy?.domain !== "goods_surplus") findings.push("taxonomy_domain");
  if (snapshot?.taxonomy?.real_property !== false) findings.push("taxonomy_real_property");
  for (const field of ["include_in_parcel_chains", "include_in_map_counts", "include_in_parcel_exports"]) {
    if (snapshot?.taxonomy?.[field] !== false) findings.push(`taxonomy_${field}`);
  }
  if (Number(snapshot?.checkpoint?.bounded_limit) > DCAS_VEHICLE_AUCTION_MAX_ROWS) {
    findings.push("unbounded_limit");
  }
  for (const batch of snapshot?.batches || []) {
    if (!isoDay(batch.close_date)) findings.push("batch_close_date");
    for (const vehicle of batch.vehicles || []) {
      if (vehicle?.basis !== "goods_surplus" || vehicle?.real_property !== false) {
        findings.push("vehicle_basis");
      }
      if (vehicle?.bbl || vehicle?.property_location) findings.push("parcel_field_leak");
    }
  }
  return { ok: findings.length === 0, findings: [...new Set(findings)] };
}
