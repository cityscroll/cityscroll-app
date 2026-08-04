import { commercialMatchesFilters, extractPropertyCommercial, normalizeAssetFilter } from "./property_commercial.mjs";
import { classifyDispositionStage } from "./property_disposition_stage.mjs";
import { parseBbl, propertyLocationFromRow, propertyMatchesLocation } from "./property_location.mjs";

const SOURCE_BASE = "https://a856-cityrecord.nyc.gov/RequestDetail/";
const iso = (value) => String(value || "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || "";

export function propertyTemporalStage(row, today = new Date().toISOString().slice(0, 10)) {
  const event = iso(row?.event_date);
  if (event) {
    const days = Math.round((Date.parse(`${event}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
    if (Number.isFinite(days) && days >= 0) return days <= 30 ? "soon" : "upcoming";
  }
  if (/hearing/i.test(String(row?.type_of_notice_description || ""))) return "proposed";
  return "past";
}

export function propertyRowMatchesSavedSearch(row, filter = {}, today) {
  if (!propertyMatchesLocation(row, filter)) return false;
  const process = filter.process || "all";
  const stage = row?.disposition_stage || classifyDispositionStage(row);
  if (process !== "all" && (process === "unstaged" ? stage !== null : stage !== process)) return false;
  if (filter.stage && filter.stage !== "all" && propertyTemporalStage(row, today) !== filter.stage) return false;
  const asset = normalizeAssetFilter(filter.asset);
  const saleMethod = filter.saleMethod || "all";
  const priceBand = filter.priceBand || "all";
  if (asset !== "all" || saleMethod !== "all" || priceBand !== "all") {
    const commercial = row?.commercial || extractPropertyCommercial(row);
    if (!commercialMatchesFilters(commercial, { asset, saleMethod, priceBand, commercialOnly: true })) return false;
  }
  return true;
}

function flattenEntries(entries) {
  return (entries || []).flatMap((entry) => entry?.kind === "cluster" ? (entry.members || []) : [entry]).filter(Boolean);
}

function entryParcels(entry) {
  const row = entry.primary || entry;
  const location = row.property_location || row._location || propertyLocationFromRow(row);
  const parcels = new Map();
  const bbls = [entry.bbl, ...(location.bbls || [])].filter(Boolean);
  for (const bbl of bbls) {
    const parsed = parseBbl(String(bbl).replace(/\D/g, ""));
    if (parsed) parcels.set(`${parsed.block}/${parsed.lot}`, { bbl: parsed.bbl, block: parsed.block, lot: parsed.lot });
  }
  for (const taxLot of location.tax_lots || []) {
    for (const lot of taxLot?.lots || []) {
      const block = String(taxLot.block || ""), lotText = String(lot || ""), key = `${block}/${lotText}`;
      if (!parcels.has(key)) parcels.set(key, { bbl: "", block, lot: lotText });
    }
  }
  if (!parcels.size) parcels.set("unknown", { bbl: "", block: "", lot: "" });
  return { row, location, parcels: [...parcels.values()] };
}

/** One row per auction/sale-stage parcel currently represented in the saved-search list view. */
export function propertyAuctionExportRows(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of flattenEntries(entries)) {
    const { row, location, parcels } = entryParcels(entry);
    const stage = entry.process_stage || row.disposition_stage || classifyDispositionStage(row);
    if (stage !== "auction_or_rfp" && stage !== "award_or_conveyance") continue;
    for (const { bbl, block, lot } of parcels) {
      const identity = bbl || (block && lot ? `${block}/${lot}` : `notice:${row.request_id || out.length}`);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const commercial = row.commercial || null;
      out.push({
        address: location.addresses?.[0]?.label || "", block, lot, bbl, stage,
        posted: iso(row.start_date), event_date: iso(row.event_date),
        close_date: iso(commercial?.close_date),
        source_link: row.request_id ? `${SOURCE_BASE}${encodeURIComponent(row.request_id)}` : "",
      });
    }
  }
  return out;
}
