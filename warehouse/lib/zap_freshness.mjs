/**
 * WH-05 / land freshness honesty — canaries, prefer-warehouse gate, live drift,
 * and bulk-CSV-vs-SODA lag detection for WH-02 ops.
 *
 * Pure helpers only. Network callers live in build tools.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, WAREHOUSE_DIR } from "./catalog.mjs";
import { ZAP_ALL_COLS, ZAP_SELL_FACING_STATUSES } from "./zap_lookup.mjs";

/** Field-case land projects that must stay in the sell-facing lookup + keyword index. */
export const LAND_ZAP_FRESHNESS_CANARIES = Object.freeze([
  Object.freeze({
    project_id: "2025Q0331",
    label: "44-17 Greenpoint Avenue Rezoning",
  }),
  Object.freeze({
    project_id: "2026K0123",
    label: "1550 Bedford Avenue Rezoning",
  }),
]);

/** Prefer-warehouse only when the DuckDB/export frontier is this fresh. */
export const LAND_WAREHOUSE_MILESTONE_LAG_DAYS = 14;

/** Align with land-upcoming-hearings publish freshness expectation (~36h). */
export const LAND_LOOKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;

/**
 * Fail closed when live sell-facing IDs missing from the committed lookup exceed
 * this absolute count (scout measured 32 missing while the universe was stale).
 */
export const LAND_SELL_FACING_MISSING_ID_THRESHOLD = 5;

/** Bulk CSV milestone frontier may lag live SODA by at most this many days. */
export const ZAP_BULK_MILESTONE_LAG_DAYS = 14;

export const ZAP_SODA_DATASET = "hgx4-8ukb";
export const ZAP_BBL_SODA_DATASET = "2iga-a6mk";
export const SODA_RESOURCE_BASE = "https://data.cityofnewyork.us/resource";

export const ZAP_PROJECTS_BULK_RECEIPT = join(
  WAREHOUSE_DIR,
  "receipts",
  "proof",
  "zap-projects_bulk_latest.json",
);
export const ZAP_BBL_BULK_RECEIPT = join(
  WAREHOUSE_DIR,
  "receipts",
  "proof",
  "zap-bbl_bulk_latest.json",
);

export function projectIdSet(rows) {
  const out = new Set();
  for (const row of rows || []) {
    const id = String(row?.project_id || "").trim();
    if (id) out.add(id);
  }
  return out;
}

export function maxCurrentMilestoneDate(rows) {
  let max = null;
  for (const row of rows || []) {
    const raw = String(row?.current_milestone_date || "").trim();
    if (!raw) continue;
    const day = raw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!max || day > max) max = day;
  }
  return max;
}

export function calendarDaysBetween(earlierDay, laterDay) {
  const a = String(earlierDay || "").slice(0, 10);
  const b = String(laterDay || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Prefer warehouse land default only when the export frontier is honest.
 * Stale milestone max (CSV lag) or missing rows → fall through to live SODA.
 */
export function assessLandWarehouseFreshness({
  rows = [],
  now = new Date(),
  maxMilestoneLagDays = LAND_WAREHOUSE_MILESTONE_LAG_DAYS,
  bulkMilestoneMax = null,
} = {}) {
  const reasons = [];
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return {
      fresh: false,
      reasons: ["warehouse_export_empty"],
      max_milestone_date: null,
      lag_days: null,
    };
  }
  const exportMax = maxCurrentMilestoneDate(list);
  const frontier = [exportMax, bulkMilestoneMax]
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const today = new Date(now).toISOString().slice(0, 10);
  const lagDays = frontier ? calendarDaysBetween(frontier, today) : null;
  if (frontier == null) {
    reasons.push("warehouse_milestone_frontier_unknown");
  } else if (lagDays != null && lagDays > maxMilestoneLagDays) {
    reasons.push(
      `warehouse_milestone_lag_${lagDays}d_exceeds_${maxMilestoneLagDays}d`,
    );
  }
  return {
    fresh: reasons.length === 0,
    reasons,
    max_milestone_date: frontier,
    export_max_milestone_date: exportMax,
    bulk_milestone_max: bulkMilestoneMax || null,
    lag_days: lagDays,
    as_of: today,
  };
}

export function missingLandCanaries(rowsOrDoc) {
  const rows = Array.isArray(rowsOrDoc)
    ? rowsOrDoc
    : Array.isArray(rowsOrDoc?.rows)
      ? rowsOrDoc.rows
      : [];
  const ids = projectIdSet(rows);
  return LAND_ZAP_FRESHNESS_CANARIES.filter((c) => !ids.has(c.project_id));
}

export function assertLandCanariesPresent(rowsOrDoc, { context = "land lookup" } = {}) {
  const missing = missingLandCanaries(rowsOrDoc);
  if (!missing.length) return { ok: true, missing: [] };
  const detail = missing
    .map((c) => `${c.project_id} (${c.label})`)
    .join("; ");
  const err = new Error(
    `${context} missing land freshness canaries: ${detail}. ` +
      "Rebuild with node tools/build_zap_warehouse_lookup.mjs --from-soda",
  );
  err.code = "LAND_ZAP_CANARY_MISSING";
  err.missing = missing;
  throw err;
}

export function sellFacingIdDelta(liveIds, committedIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  const committed =
    committedIds instanceof Set ? committedIds : new Set(committedIds || []);
  const missing = [...live].filter((id) => !committed.has(id)).sort();
  const extra = [...committed].filter((id) => !live.has(id)).sort();
  return {
    live_count: live.size,
    committed_count: committed.size,
    missing_from_committed: missing,
    missing_count: missing.length,
    extra_in_committed: extra,
    extra_count: extra.length,
  };
}

export function assessSellFacingDrift(delta, {
  missingThreshold = LAND_SELL_FACING_MISSING_ID_THRESHOLD,
} = {}) {
  const reasons = [];
  if ((delta?.missing_count || 0) > missingThreshold) {
    reasons.push(
      `live_sell_facing_missing_${delta.missing_count}_exceeds_${missingThreshold}`,
    );
  }
  const canaryMiss = LAND_ZAP_FRESHNESS_CANARIES.filter((c) =>
    (delta?.missing_from_committed || []).includes(c.project_id),
  );
  if (canaryMiss.length) {
    reasons.push(
      `canaries_missing_from_committed:${canaryMiss.map((c) => c.project_id).join(",")}`,
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    delta,
    canaries_missing: canaryMiss,
    threshold: missingThreshold,
  };
}

/**
 * Detect the measured stale-CSV-vs-fresh-API condition (May-26 CSV / April
 * milestone frontier while live SODA already carries June–July milestones).
 */
export function assessZapBulkCsvFreshness({
  bulkLastModified = null,
  bulkMilestoneMax = null,
  liveMilestoneMax = null,
  now = new Date(),
  maxMilestoneLagDays = ZAP_BULK_MILESTONE_LAG_DAYS,
} = {}) {
  const reasons = [];
  const today = new Date(now).toISOString().slice(0, 10);
  const liveLag =
    liveMilestoneMax && bulkMilestoneMax
      ? calendarDaysBetween(bulkMilestoneMax, liveMilestoneMax)
      : null;
  const ageLag = bulkMilestoneMax
    ? calendarDaysBetween(bulkMilestoneMax, today)
    : null;

  if (bulkMilestoneMax == null) {
    reasons.push("bulk_milestone_frontier_unknown");
  }
  if (liveMilestoneMax == null) {
    reasons.push("live_milestone_frontier_unknown");
  }
  if (liveLag != null && liveLag > maxMilestoneLagDays) {
    reasons.push(
      `bulk_vs_live_milestone_lag_${liveLag}d_exceeds_${maxMilestoneLagDays}d`,
    );
  } else if (
    liveMilestoneMax == null &&
    ageLag != null &&
    ageLag > maxMilestoneLagDays
  ) {
    reasons.push(
      `bulk_milestone_age_${ageLag}d_exceeds_${maxMilestoneLagDays}d`,
    );
  }

  return {
    stale: reasons.length > 0,
    reasons,
    bulk_last_modified: bulkLastModified || null,
    bulk_milestone_max: bulkMilestoneMax || null,
    live_milestone_max: liveMilestoneMax || null,
    bulk_vs_live_lag_days: liveLag,
    bulk_age_lag_days: ageLag,
    max_milestone_lag_days: maxMilestoneLagDays,
    rematerialize:
      "warehouse/.venv/bin/python warehouse/scripts/ingest.py " +
      "--dataset zap-projects --bulk --ack-large --write-sample 25",
  };
}

export function readZapProjectsBulkReceipt(path = ZAP_PROJECTS_BULK_RECEIPT) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function bulkReceiptMilestoneMax(receipt) {
  return (
    receipt?.raw?.snapshot_profile?.milestone_date_max ||
    receipt?.raw?.snapshot_profile?.date_fields?.current_milestone_date?.max ||
    null
  );
}

export function bulkReceiptLastModified(receipt) {
  return receipt?.raw?.last_modified || null;
}

export function sodaSellFacingWhere(statuses = ZAP_SELL_FACING_STATUSES) {
  const list = statuses.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(", ");
  return `public_status in(${list})`;
}

export function sodaSellFacingSelect(cols = ZAP_ALL_COLS) {
  return cols.join(",");
}

export function sodaSellFacingUrl({
  dataset = ZAP_SODA_DATASET,
  limit = 1000,
  offset = 0,
  cols = ZAP_ALL_COLS,
} = {}) {
  const params = new URLSearchParams({
    $select: sodaSellFacingSelect(cols),
    $where: sodaSellFacingWhere(),
    $order: "current_milestone_date DESC",
    $limit: String(limit),
    $offset: String(offset),
  });
  return `${SODA_RESOURCE_BASE}/${dataset}.json?${params}`;
}

export function sodaLiveMilestoneMaxUrl({
  dataset = ZAP_SODA_DATASET,
} = {}) {
  const params = new URLSearchParams({
    $select: "max(current_milestone_date) as max_milestone",
    $where: "current_milestone_date IS NOT NULL",
    $limit: "1",
  });
  return `${SODA_RESOURCE_BASE}/${dataset}.json?${params}`;
}

export function normalizeSodaMilestoneDay(value) {
  const day = String(value || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Repo-relative helper for tests/docs. */
export function landZapFreshnessPaths() {
  return {
    root: REPO_ROOT,
    lookup_site: "site/data/zap_projects_warehouse_lookup.json",
    lookup_worker: "worker/src/data/zap_projects_warehouse_lookup.json",
    keyword_index: "worker/src/data/keyword_search_index.json",
    land_default: "site/data/land_default_ulurp.json",
    upcoming_hearings: "site/data/land_upcoming_hearings.json",
    bulk_receipt: "warehouse/receipts/proof/zap-projects_bulk_latest.json",
  };
}
