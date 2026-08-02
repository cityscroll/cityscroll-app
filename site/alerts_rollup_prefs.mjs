/**
 * Alerts rollup + preferences — public surface helpers for multi-watch digests.
 *
 * Account-level delivery already consolidates active watches for one email into
 * a single daily digest (worker/src/lib/rollup.mjs + alerts.mjs). This module is
 * the pure view layer for the #alerts tab:
 *   - group related watches by topic / agency / geography for review
 *   - build a hermetic multi-watch digest preview (fixture-backed demo)
 *   - preference cutover copy (edits take effect next daily run ~9am ET)
 *
 * No new delivery mode. No false labels. Geography/agency empty buckets mean
 * "no filter set on that watch", not "city withheld data".
 */

export const ALERTS_ROLLUP_PREFS_SCHEMA_VERSION = 1;

/** How related watches cluster for review (not separate email products). */
export const ROLLUP_GROUP_DIMS = Object.freeze(["topic", "agency", "geography"]);

export const PREFS_CUTOVER_COPY =
  "Preference changes take effect on the next daily digest run (~9am Eastern).";

const LENS_TOPIC = Object.freeze({
  money: "Contracts & awards",
  land: "Rezonings & land use",
  property: "Property disposition",
  rules: "Agency rules",
  meetings: "Hearings & meetings",
  entity: "Vendor or agency name",
  award: "Award on a notice",
  people: "People & roles",
});

/**
 * Demo multi-watch account — three active watches that share one email so the
 * product path (rollup when active watches > 1) is visible without live SUBS.
 * Fixture only; never a production subscription.
 */
export function demoRollupWatches() {
  return [
    {
      key: "sub:demo-construction",
      lens: "money",
      filter: { keywords: ["construction"], agency: "Department of Education" },
      query: 'contract money — about "construction" · agency "Department of Education"',
      freq: "daily",
      paused: false,
      sampleRows: [
        {
          request_id: "20260731001",
          short_title: "School construction services",
          agency_name: "Department of Education",
          contract_amount: "2000000",
        },
      ],
    },
    {
      key: "sub:demo-les-rezone",
      lens: "land",
      filter: { keywords: ["Lower East Side"], status: "all" },
      query: 'land & rezonings — about "Lower East Side" · including closed',
      freq: "daily",
      paused: false,
      sampleRows: [
        {
          project_id: "2022M0258",
          project_name: "Lower East Side mixed-use",
          borough: "Manhattan",
          public_status: "In Public Review",
        },
      ],
    },
    {
      key: "sub:demo-dot-agency",
      lens: "entity",
      filter: { kind: "agency", name: "Department of Transportation" },
      query: 'agency "Department of Transportation" — every new City Record notice naming them',
      freq: "weekly",
      paused: false,
      sampleRows: [
        {
          request_id: "20260731002",
          short_title: "Street reconstruction — Brooklyn",
          agency_name: "Department of Transportation",
          contract_amount: "850000",
        },
      ],
    },
  ];
}

/** Normalize a watch-like row for grouping (SUBS shape or local draft). */
export function normalizeWatchRow(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const lens = raw.lens || null;
  const filter = raw.filter && typeof raw.filter === "object" ? raw.filter : {};
  const query =
    typeof raw.query === "string" && raw.query
      ? raw.query
      : typeof raw.desc === "string"
        ? raw.desc
        : lens || "watch";
  return {
    key: raw.key || null,
    lens,
    filter,
    query,
    freq: raw.freq === "weekly" ? "weekly" : "daily",
    paused: !!raw.paused,
    sampleRows: Array.isArray(raw.sampleRows) ? raw.sampleRows : [],
  };
}

export function topicLabel(lens) {
  if (!lens) return "Other topics";
  return LENS_TOPIC[lens] || String(lens);
}

/**
 * Dimension key + human label for one watch.
 * Empty agency/geography → explicit "Any agency" / "Citywide or unscoped"
 * so empty never looks like a missing publisher field.
 */
export function watchDimension(watch, dim = "topic") {
  const w = normalizeWatchRow(watch);
  if (!w) return { key: "unknown", label: "Unknown" };
  const f = w.filter || {};
  if (dim === "agency") {
    if (w.lens === "entity" && f.kind === "agency" && f.name) {
      return { key: `agency:${String(f.name).toLowerCase()}`, label: String(f.name) };
    }
    if (f.agency) {
      return { key: `agency:${String(f.agency).toLowerCase()}`, label: String(f.agency) };
    }
    return { key: "agency:any", label: "Any agency" };
  }
  if (dim === "geography") {
    if (f.boro) return { key: `geo:boro:${String(f.boro).toLowerCase()}`, label: String(f.boro) };
    if (f.borough) return { key: `geo:boro:${String(f.borough).toLowerCase()}`, label: String(f.borough) };
    if (f.neighborhood) {
      return { key: `geo:nbhd:${String(f.neighborhood).toLowerCase()}`, label: String(f.neighborhood) };
    }
    // Land rezone often stores place as keywords (e.g. "Lower East Side").
    if (w.lens === "land" && Array.isArray(f.keywords) && f.keywords.length) {
      const place = f.keywords.filter(Boolean).join(" / ");
      if (place) return { key: `geo:place:${place.toLowerCase()}`, label: place };
    }
    if (f.locationScope === "citywide-unlocated") {
      return { key: "geo:citywide-unlocated", label: "Citywide (unlocated)" };
    }
    return { key: "geo:unscoped", label: "Citywide or unscoped" };
  }
  // topic (default)
  return { key: `topic:${w.lens || "other"}`, label: topicLabel(w.lens) };
}

/**
 * Group watches by topic | agency | geography for the rollup review surface.
 * Preserves first-seen order of groups and watches within a group.
 */
export function groupWatchesForRollup(watches = [], dim = "topic") {
  const dimension = ROLLUP_GROUP_DIMS.includes(dim) ? dim : "topic";
  const groups = [];
  const index = new Map();
  for (const raw of watches || []) {
    const w = normalizeWatchRow(raw);
    if (!w || w.paused) continue;
    const { key, label } = watchDimension(w, dimension);
    let g = index.get(key);
    if (!g) {
      g = { key, label, dimension, watches: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.watches.push(w);
  }
  return groups;
}

/** True when account-level rollup would apply (more than one active watch). */
export function shouldShowAccountRollup(watches = []) {
  const active = (watches || []).map(normalizeWatchRow).filter((w) => w && !w.paused);
  return active.length > 1;
}

/**
 * Build a consolidated digest preview model for the #alerts email mock.
 * One section per active watch (same shape as account rollup body sections).
 */
export function buildRollupPreviewModel(watches = [], { groupBy = "topic", dest = "you@example.com" } = {}) {
  const active = (watches || []).map(normalizeWatchRow).filter((w) => w && !w.paused);
  const groups = groupWatchesForRollup(active, groupBy);
  const sections = active.map((w) => {
    const rows = w.sampleRows || [];
    return {
      key: w.key,
      lens: w.lens,
      label: w.query,
      freq: w.freq,
      new: rows.length,
      rows,
      quiet: rows.length === 0,
    };
  });
  const totalNew = sections.reduce((n, s) => n + (Number(s.new) || 0), 0);
  const watchCount = sections.length;
  const wantingCount = sections.filter((s) => (Number(s.new) || 0) > 0).length;
  const multi = watchCount > 1;
  const subject = multi
    ? totalNew > 0
      ? `CityScroll: ${totalNew} new — ${watchCount} watches`
      : `CityScroll: still watching — ${watchCount} watches`
    : totalNew > 0
      ? `CityScroll: ${totalNew} new — ${sections[0]?.label || "watch"}`
      : `CityScroll: still watching — ${sections[0]?.label || "watch"}`;
  return {
    schema_version: ALERTS_ROLLUP_PREFS_SCHEMA_VERSION,
    dest,
    multi,
    watchCount,
    wantingCount,
    totalNew,
    subject,
    summaryLine: multi
      ? `${wantingCount} of ${watchCount} watches with updates`
      : `${wantingCount} watch${wantingCount === 1 ? "" : "es"} with updates`,
    groupBy: ROLLUP_GROUP_DIMS.includes(groupBy) ? groupBy : "topic",
    groups,
    sections,
    cutover: PREFS_CUTOVER_COPY,
    rollupApplies: multi,
  };
}

/** Hermetic demo model used by #alerts?view=rollup and characterization tests. */
export function demoRollupPreviewModel(opts = {}) {
  return buildRollupPreviewModel(demoRollupWatches(), {
    groupBy: opts.groupBy || "topic",
    dest: opts.dest || "multi@example.com",
  });
}
