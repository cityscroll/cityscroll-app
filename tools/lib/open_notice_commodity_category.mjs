// City commodity category for each open City Record solicitation.
//
// The notice itself carries no commodity category. This joins its PIN to a PASSPort
// Public RFx with the existing PIN-to-EPIN rule, then resolves that RFx row's main
// commodity to a City L3 category with the existing exact-label matcher. Notices the
// join cannot cover stay in the list and say category not published, with the reason.
// Nothing is guessed, and a failed RFx read is reported instead of omitted.

import { joinPinToEpin, buildEpinIndex, normId } from "../../worker/src/lib/passport_join.mjs";
import {
  passportCommodityCategoryIndex,
  passportRfxCommodityCategory,
} from "../../worker/src/lib/passport_commodity_category.mjs";
import { RFX_DATA_URL, parseRfxDump } from "../../worker/src/lib/passport_parse.mjs";
import { PASSPORT_FETCH_HEADERS, classifyPassportDumpBody } from "../../worker/src/passport.mjs";
import { buildPassportRfxCommoditySlice, rfxRowsFromCommoditySlice } from "./passport_rfx_commodity_slice.mjs";

export const OPEN_NOTICE_COMMODITY_SOURCE = "passport_public_rfx";
export const OPEN_NOTICE_COMMODITY_COVERAGE_SCHEMA = "cityscroll.open_notice_commodity_category_coverage.v1";
export const OPEN_NOTICE_COMMODITY_JOIN_RULE = [
  "A City Record PIN is joined to a PASSPort Public RFx EPIN by exact alphanumeric match,",
  "one trailing letter-and-digits suffix stripped, the PIN as a prefix of the EPIN, or the",
  "EPIN as a prefix of the PIN. The RFx main commodity is an L3 category only when its label",
  "matches a City commodity category exactly after normalizing case and spacing. No PIN, no",
  "join, two RFx rows for the same EPIN that disagree, or a label that is not an L3 category",
  "is published as category not published, with the reason. Nothing is guessed.",
].join(" ");

const JOIN_METHODS = Object.freeze([
  "exact",
  "pin_strip_suffix",
  "pin_prefix_of_epin",
  "epin_prefix_of_pin",
]);
const REASONS = Object.freeze([
  "joined_l3",
  "no_pin",
  "pin_not_joined",
  "joined_unmatched",
  "joined_no_label",
  "ambiguous_epin",
  "category_index_unavailable",
  "rfx_unavailable",
  "rfx_empty",
]);

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function categorySignature(resolved) {
  if (resolved?.status === "matched") return `matched:${resolved.code}`;
  if (resolved?.status === "unmatched") return `unmatched:${resolved.raw_label}`;
  return resolved?.status || "unavailable";
}

function coverageEntry(state, reason, asOf) {
  return {
    state,
    reason,
    source: OPEN_NOTICE_COMMODITY_SOURCE,
    as_of: asOf,
  };
}

function detail(base, extra) {
  return extra ? { ...base, ...extra } : base;
}

/**
 * Attach a commodity category, or an explicit gap, to each open notice.
 *
 * @param {object[]} notices projected open-solicitation rows
 * `read` says where the RFx rows came from: the live dump, or the committed slice when the live
 * dump refused this host. A slice read makes a notice first published on or after the slice's
 * day `rfx_unavailable` rather than `pin_not_joined`, since PASSPort was not read for it.
 *
 * @param {{ rfxRows?: object[]|null, unavailableReason?: string|null, asOf: string, observedAt?: string, read?: object|null }} input
 */
export function attachOpenNoticeCommodityCategories(notices, {
  rfxRows = null,
  unavailableReason = null,
  asOf,
  observedAt = null,
  read = null,
} = {}) {
  if (!Array.isArray(notices)) throw new Error("open notice categories: notices must be an array");
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error("open notice categories: as_of must be a calendar day");
  }

  const byReason = emptyCounts(REASONS);
  const byJoinMethod = emptyCounts(JOIN_METHODS);
  let index = null;
  let catalogVersion = null;
  let indexUnavailable = false;
  if (!unavailableReason && Array.isArray(rfxRows) && rfxRows.length > 0) {
    try {
      index = passportCommodityCategoryIndex();
      catalogVersion = index.version || null;
    } catch {
      indexUnavailable = true;
    }
  }

  const byEpin = new Map();
  if (index) {
    for (const row of rfxRows) {
      const key = normId(row?.epin_norm || row?.epin);
      if (!key) continue;
      if (!byEpin.has(key)) byEpin.set(key, []);
      byEpin.get(key).push(row);
    }
  }
  const epinIndex = index ? buildEpinIndex([...byEpin.keys()]) : null;

  const published = notices.map((notice) => {
    const outcome = classifyNotice(notice, {
      asOf,
      unavailableReason,
      rfxRows,
      index,
      indexUnavailable,
      byEpin,
      epinIndex,
      sliceDay: read?.mode === "committed_slice" ? read.as_of : null,
    });
    byReason[outcome.reason] += 1;
    if (outcome.joinMethod) byJoinMethod[outcome.joinMethod] += 1;
    return {
      ...notice,
      main_commodity_category: outcome.category,
      coverage: { category: coverageEntry(outcome.state, outcome.reason, asOf) },
    };
  });

  const available = byReason.joined_l3;
  const measured = !unavailableReason && !indexUnavailable && Array.isArray(rfxRows) && rfxRows.length > 0;
  const coverage = {
    schema: OPEN_NOTICE_COMMODITY_COVERAGE_SCHEMA,
    state: measured ? "measured" : "unavailable",
    unavailable_reason: measured ? null : (unavailableReason || (indexUnavailable ? "category_index_unavailable" : "rfx_empty")),
    join_rule: OPEN_NOTICE_COMMODITY_JOIN_RULE,
    source: OPEN_NOTICE_COMMODITY_SOURCE,
    source_url: RFX_DATA_URL,
    as_of: asOf,
    observed_at: observedAt,
    catalog_version: catalogVersion,
    open_notices: published.length,
    available,
    missing: published.length - available,
    by_reason: byReason,
    by_join_method: byJoinMethod,
    rfx_rows: Array.isArray(rfxRows) ? rfxRows.length : 0,
    rfx_epins: byEpin.size,
    ...(read ? { rfx_read: read } : {}),
  };
  return { notices: published, coverage };
}

function classifyNotice(notice, ctx) {
  const { asOf } = ctx;
  if (ctx.unavailableReason || !Array.isArray(ctx.rfxRows)) {
    return gap("rfx_unavailable", asOf);
  }
  if (ctx.rfxRows.length === 0) return gap("rfx_empty", asOf);
  if (ctx.indexUnavailable || !ctx.index) return gap("category_index_unavailable", asOf);

  const pin = typeof notice?.pin === "string" ? notice.pin.trim() : "";
  if (!pin) return gap("no_pin", asOf);
  const join = joinPinToEpin(pin, ctx.epinIndex);
  const group = join ? ctx.byEpin.get(join.epin) || [] : [];
  if (!group.length) return gap(postdatesSlice(notice, ctx.sliceDay) ? "rfx_unavailable" : "pin_not_joined", asOf);

  const resolved = group.map((row) => passportRfxCommodityCategory(row, ctx.index));
  const signatures = new Set(resolved.map(categorySignature));
  const publisherEpin = group[0].epin || join.epin;
  const joinRecord = { method: join.method, epin: publisherEpin };
  if (signatures.size !== 1) {
    return {
      state: "missing",
      reason: "ambiguous_epin",
      joinMethod: null,
      category: detail(
        {
          status: "not_published",
          state: "missing",
          reason: "ambiguous_epin",
          source: OPEN_NOTICE_COMMODITY_SOURCE,
          as_of: asOf,
          join: joinRecord,
        },
        { candidate_labels: distinctLabels(resolved).slice(0, 5) },
      ),
    };
  }

  const category = resolved[0];
  if (category.status === "matched") {
    return {
      state: "available",
      reason: "joined_l3",
      joinMethod: join.method,
      category: {
        status: "matched",
        code: category.code,
        label: category.label,
        level: category.level,
        parents: category.parents,
        catalog_version: category.catalog_version,
        state: "available",
        reason: "joined_l3",
        source: OPEN_NOTICE_COMMODITY_SOURCE,
        as_of: asOf,
        join: joinRecord,
      },
    };
  }
  if (category.status === "unmatched") {
    return {
      state: "missing",
      reason: "joined_unmatched",
      joinMethod: null,
      category: {
        status: "unmatched",
        state: "missing",
        reason: "joined_unmatched",
        raw_label: category.raw_label,
        source: OPEN_NOTICE_COMMODITY_SOURCE,
        as_of: asOf,
        join: joinRecord,
      },
    };
  }
  if (category.status === "no_label") return joinedGap("joined_no_label", asOf, joinRecord, { status: "no_label" });
  return joinedGap("category_index_unavailable", asOf, joinRecord, { status: "unavailable" });
}

function postdatesSlice(notice, sliceDay) {
  if (!sliceDay) return false;
  const day = typeof notice?.start_date === "string" ? notice.start_date.slice(0, 10) : "";
  return !/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= sliceDay;
}

function gap(reason, asOf) {
  return {
    state: "missing",
    reason,
    joinMethod: null,
    category: {
      status: "not_published",
      state: "missing",
      reason,
      source: OPEN_NOTICE_COMMODITY_SOURCE,
      as_of: asOf,
    },
  };
}

function joinedGap(reason, asOf, joinRecord, { status }) {
  return {
    state: "missing",
    reason,
    joinMethod: null,
    category: {
      status,
      state: "missing",
      reason,
      source: OPEN_NOTICE_COMMODITY_SOURCE,
      as_of: asOf,
      join: joinRecord,
    },
  };
}

function distinctLabels(resolved) {
  const labels = [];
  for (const row of resolved) {
    const label = row.status === "matched" ? row.label : row.raw_label || row.status;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Download and parse the public PASSPort RFx dump. Throws a short reason on failure. */
export async function fetchPassportPublicRfxRows(fetchImpl = fetch, { timeoutMs = 20_000 } = {}) {
  const observedAt = new Date().toISOString();
  const response = await fetchImpl(RFX_DATA_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: PASSPORT_FETCH_HEADERS,
  });
  if (!response?.ok) throw new Error(`rfx-http-${response?.status ?? "none"}`);
  const text = await response.text();
  const reason = classifyPassportDumpBody(text, "rfx");
  if (reason) throw new Error(reason);
  const rows = parseRfxDump(text);
  if (!rows.length) throw new Error("rfx-parsed-zero-rows");
  return { rows, observedAt };
}

/**
 * The RFx rows for the open-solicitation category join. A live read returns the rows and a fresh
 * slice for the caller to commit. A refused or failed live read falls back to the committed slice
 * and says so; with no usable slice the failure is returned as `unavailable`, as before.
 */
export async function readOpenNoticeCommodity({
  fetchImpl = fetch,
  now = new Date(),
  fetchRows = (impl) => fetchPassportPublicRfxRows(impl),
  loadSlice,
} = {}) {
  let liveFailure;
  try {
    const fetched = await fetchRows(fetchImpl);
    const slice = buildPassportRfxCommoditySlice(fetched.rows, { observedAt: fetched.observedAt });
    return {
      rfxRows: fetched.rows,
      observedAt: fetched.observedAt,
      read: { mode: "live", observed_at: slice.observed_at, as_of: slice.as_of },
      slice,
    };
  } catch (error) {
    liveFailure = String(error?.message || error).slice(0, 180);
  }
  try {
    const slice = await loadSlice();
    const rfxRows = rfxRowsFromCommoditySlice(slice);
    return {
      rfxRows,
      observedAt: slice.observed_at,
      asOf: slice.as_of,
      read: { mode: "committed_slice", observed_at: slice.observed_at, as_of: slice.as_of, live_failure: liveFailure },
    };
  } catch {
    return { unavailable: liveFailure, observedAt: now.toISOString() };
  }
}
