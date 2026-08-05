#!/usr/bin/env node
/**
 * Bounded, checkpointed DCAS Vehicle Auction List collector.
 *
 * This job reads only NYC Open Data (ynic-uz5i). It deliberately does not
 * scrape GovDeals: the marketplace User Agreement prohibits automated access
 * and data mining. The public product links out to the official channels.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DCAS_VEHICLE_AUCTION_MAX_ROWS,
  buildDcasVehicleAuctionSnapshot,
  detectDcasVehicleAuctionSnapshot,
} from "../../site/dcas_vehicle_auctions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET = "ynic-uz5i";
const DOMAIN = "https://data.cityofnewyork.us";
const DEFAULT_OUT = join(ROOT, "site/data/dcas_vehicle_auctions.json");
const DEFAULT_CHECKPOINT = join(ROOT, "warehouse/raw/dcas-vehicle-auctions/checkpoint.json");
const DEFAULT_RECEIPT = join(ROOT, "warehouse/receipts/proof/dcas_vehicle_auctions_latest.json");
const USER_AGENT = "CityScroll dcas-vehicle-auctions/1.0 (+https://cityscroll.org; official open-data precompute)";
const DEFAULT_LIMIT = DCAS_VEHICLE_AUCTION_MAX_ROWS;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_WINDOW_DAYS = 90;

function parseArgs(argv) {
  const args = {
    check: false,
    asOf: new Date().toISOString().slice(0, 10),
    limit: DEFAULT_LIMIT,
    pageSize: DEFAULT_PAGE_SIZE,
    windowDays: DEFAULT_WINDOW_DAYS,
    delayMs: 200,
    out: DEFAULT_OUT,
    checkpoint: DEFAULT_CHECKPOINT,
    receipt: DEFAULT_RECEIPT,
    publicReceipt: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--as-of") args.asOf = String(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--page-size") args.pageSize = Number(argv[++i]);
    else if (arg === "--window-days") args.windowDays = Number(argv[++i]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (arg === "--out") args.out = resolve(argv[++i]);
    else if (arg === "--checkpoint") args.checkpoint = resolve(argv[++i]);
    else if (arg === "--receipt") args.receipt = resolve(argv[++i]);
    else if (arg === "--public-receipt") args.publicReceipt = resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.asOf)) throw new Error("--as-of must be YYYY-MM-DD");
  if (!(args.limit >= 1 && args.limit <= DCAS_VEHICLE_AUCTION_MAX_ROWS)) {
    throw new Error(`--limit must be 1..${DCAS_VEHICLE_AUCTION_MAX_ROWS}`);
  }
  if (!(args.pageSize >= 1 && args.pageSize <= 100)) throw new Error("--page-size must be 1..100");
  if (!(args.windowDays >= 1 && args.windowDays <= 365)) throw new Error("--window-days must be 1..365");
  if (!(args.delayMs >= 0 && args.delayMs <= 5000)) throw new Error("--delay-ms must be 0..5000");
  if (!args.publicReceipt) {
    args.publicReceipt = join(
      ROOT,
      `site/data/property_sources/verification_receipts/dcas_surplus_frontier_${args.asOf}.json`,
    );
  }
  return args;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function dayOffset(day, delta) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function sourceUpdatedAt(metadata) {
  const seconds = Number(metadata?.rowsUpdatedAt || metadata?.publicationDate);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

async function fetchJson(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

export function dcasVehicleAuctionQuery({ asOf, windowDays, limit }) {
  const windowStart = dayOffset(asOf, -windowDays);
  return {
    window_start: windowStart,
    as_of: asOf,
    select: "auction_close_date,year,make,model,vin",
    where: `auction_close_date >= '${windowStart}T00:00:00.000'`,
    order: "auction_close_date DESC,make,model,vin",
    limit,
  };
}

function sodaUrl(query, { offset, pageSize }) {
  const params = new URLSearchParams({
    "$select": query.select,
    "$where": query.where,
    "$order": query.order,
    "$limit": String(pageSize),
    "$offset": String(offset),
  });
  return `${DOMAIN}/resource/${DATASET}.json?${params}`;
}

async function collectPages(args, query) {
  const queryKey = JSON.stringify(query);
  let checkpoint = readJson(args.checkpoint, null);
  if (!checkpoint || checkpoint.query_key !== queryKey) {
    checkpoint = {
      schema: "cityscroll.dcas_vehicle_auctions.checkpoint.v1",
      query_key: queryKey,
      query,
      completed: false,
      pages: [],
      rows: [],
    };
    writeJson(args.checkpoint, checkpoint);
  }
  if (checkpoint.completed) {
    return { rows: checkpoint.rows || [], pages: checkpoint.pages || [], checkpointHit: true };
  }
  while (checkpoint.rows.length < args.limit) {
    const offset = checkpoint.rows.length;
    const pageSize = Math.min(args.pageSize, args.limit - offset);
    const url = sodaUrl(query, { offset, pageSize });
    const page = await fetchJson(url);
    if (!Array.isArray(page)) throw new Error("DCAS vehicle auction endpoint did not return an array");
    checkpoint.rows.push(...page);
    checkpoint.pages.push({
      offset,
      row_count: page.length,
      fetched_at: new Date().toISOString(),
    });
    checkpoint.completed = page.length < pageSize || checkpoint.rows.length >= args.limit;
    checkpoint.updated_at = new Date().toISOString();
    writeJson(args.checkpoint, checkpoint);
    if (checkpoint.completed) break;
    if (args.delayMs) await wait(args.delayMs);
  }
  return { rows: checkpoint.rows, pages: checkpoint.pages, checkpointHit: false };
}

function buildFrontierReceipt(snapshot, metadata, collection) {
  const latest = snapshot.batches?.[0] || null;
  return {
    schema: "cityscroll.dcas_surplus_frontier_receipt.v1",
    observed_at: snapshot.vintage.observed_at,
    measured_vs_estimated: {
      dataset_counts: "measured",
      source_mechanics: "measured",
      nonfleet_listing_coverage: "unknown_not_estimated",
    },
    taxonomy: {
      domain: "goods_surplus",
      distinct_from: "real_property_disposition",
      product_rule: "Fleet rows may appear in auction-prep, but never enter parcel chains, BBL joins, map counts, or parcel exports.",
    },
    official_source: {
      id: "dcas-vehicle-auction-list",
      dataset: DATASET,
      landing_page: `${DOMAIN}/d/${DATASET}`,
      publisher: "NYC Department of Citywide Administrative Services",
      cadence: metadata?.metadata?.custom_fields?.Update?.["Update Frequency"] || "Weekly",
      total_rows: snapshot.counts.source_total,
      bounded_rows: snapshot.counts.bounded_rows,
      latest_close_date: latest?.close_date || null,
      latest_batch_rows: latest?.count || 0,
      open_rows_as_of: snapshot.counts.open_rows,
      as_of: snapshot.vintage.as_of,
      fields: ["auction_close_date", "year", "make", "model", "vin"],
      missing_listing_fields: ["auction_id", "lot_url", "current_bid", "pickup_location", "condition"],
    },
    govdeals_gate: {
      seller_page: "https://www.govdeals.com/en/nyc-dcas",
      user_agreement: "https://www.govdeals.com/en/content/site-terms",
      clause: "2. Restrictions on Use of Services",
      short_excerpt: "use spiders, crawlers, robots or any other similar means to access our Site",
      effect: "No GovDeals page collector or data-mining adapter is permitted without written authorization.",
      public_api: "not_public",
      api_evidence: "https://sam.lqdt1.com/",
      api_short_excerpt: "for use by Registered GovDeals Clients only",
      partnership_path: "DCAS, as the seller, can request an authorized export or client API feed from GovDeals.",
      robots_note: "A crawl-delay or sitemap does not override the User Agreement restriction.",
    },
    nonfleet_general_goods: {
      status: "wishlist_partnership_blocked",
      official_pointer: "https://www.nyc.gov/site/dcas/business/surplus-sales.page",
      reason: "DCAS publishes categories and marketplace pointers, but no verified NYC-hosted item-level feed for non-fleet surplus goods was found.",
    },
    collector: {
      checkpointed: true,
      checkpoint_hit: collection.checkpointHit,
      pages: collection.pages.length,
      bounded_limit: snapshot.checkpoint.bounded_limit,
      truncated: snapshot.checkpoint.truncated,
      source: "NYC Open Data only",
    },
    detector: detectDcasVehicleAuctionSnapshot(snapshot),
  };
}

function runCheck(args) {
  const snapshot = readJson(args.out);
  const receipt = readJson(args.receipt);
  if (!snapshot) throw new Error(`missing ${args.out}`);
  if (!receipt) throw new Error(`missing ${args.receipt}`);
  const detection = detectDcasVehicleAuctionSnapshot(snapshot);
  if (!detection.ok) throw new Error(`DCAS vehicle auction detector failed: ${detection.findings.join(", ")}`);
  if (receipt.govdeals_gate?.effect == null) throw new Error("receipt missing GovDeals terms gate");
  if (receipt.nonfleet_general_goods?.status !== "wishlist_partnership_blocked") {
    throw new Error("receipt missing non-fleet wishlist verdict");
  }
  console.log(`ok dcas_vehicle_auctions rows=${snapshot.counts.bounded_rows} open=${snapshot.counts.open_rows} detector=pass`);
}

export async function runDcasVehicleAuctionCollector(args) {
  const query = dcasVehicleAuctionQuery(args);
  const [metadata, totalRows] = await Promise.all([
    fetchJson(`${DOMAIN}/api/views/${DATASET}`),
    fetchJson(`${DOMAIN}/resource/${DATASET}.json?$select=count(*)`),
  ]);
  const collection = await collectPages(args, query);
  const sourceTotal = Number(totalRows?.[0]?.count) || null;
  const truncated = collection.rows.length >= args.limit;
  const snapshot = buildDcasVehicleAuctionSnapshot(collection.rows, {
    asOf: args.asOf,
    observedAt: new Date().toISOString(),
    sourceUpdatedAt: sourceUpdatedAt(metadata),
    sourceTotal,
    query,
    pages: collection.pages.length,
    limit: args.limit,
    truncated,
  });
  const receipt = buildFrontierReceipt(snapshot, metadata, collection);
  writeJson(args.out, snapshot);
  writeJson(args.receipt, receipt);
  writeJson(args.publicReceipt, receipt);
  return { snapshot, receipt };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node warehouse/scripts/dcas_vehicle_auctions.mjs --as-of YYYY-MM-DD
  node warehouse/scripts/dcas_vehicle_auctions.mjs --check`);
    return;
  }
  if (args.check) return runCheck(args);
  const { snapshot } = await runDcasVehicleAuctionCollector(args);
  console.log(`wrote ${args.out} (${snapshot.counts.bounded_rows} rows; ${snapshot.counts.open_rows} open)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
