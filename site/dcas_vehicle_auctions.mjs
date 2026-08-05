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

export function normalizeDcasVehicleAuction(row = {}) {
  const closeDate = isoDay(row.auction_close_date);
  const make = clean(row.make);
  const model = clean(row.model);
  const vin = clean(row.vin);
  if (!closeDate || (!make && !model && !vin)) return null;
  return {
    close_date: closeDate,
    year: safeYear(row.year),
    make,
    model,
    vin,
    basis: "goods_surplus",
    commercial_category: "vehicle",
    real_property: false,
  };
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
