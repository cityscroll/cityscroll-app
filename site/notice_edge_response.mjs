/**
 * The Notice edge response: what produces it, and what the response says about
 * how it was produced.
 *
 * `site/_routes.json` lists `/notices/*`, so every request for a Notice
 * document invokes the Pages function rather than a stored object, and nothing
 * in the serving path writes to or reads from the Cache API. The document is
 * therefore produced per request: it has no edge cache entry to hit or miss.
 * The cache that does exist on this path belongs to the record subrequest,
 * whose outcome the platform reports back to the function on `cf-cache-status`.
 *
 * This module owns the vocabulary both facts are reported in, and the
 * `Server-Timing` value the response carries. Every token is drawn from a
 * closed set, and the header carries durations and tokens only — never a
 * record id, a reader, or anything derived from one.
 */

export const NOTICE_EDGE_RECORD_ORIGIN = "https://api.cityscroll.org/notice";

/**
 * Closed set of cache outcomes. `unknown` is absence of a reported outcome and
 * is never collapsed into one of the four measured states.
 */
export const NOTICE_EDGE_CACHE_OUTCOMES = Object.freeze([
  "hit",
  "miss",
  "stale",
  "dynamic",
  "unknown",
]);

/**
 * The document's own delivery: produced by the function on every request, so
 * its outcome is `dynamic` by construction rather than by measurement. This is
 * a property of the serving path, not a rate that varies between requests.
 */
export const NOTICE_EDGE_DOCUMENT_CACHE_OUTCOME = "dynamic";

const CACHE_STATUS_OUTCOMES = Object.freeze({
  HIT: "hit",
  MISS: "miss",
  EXPIRED: "stale",
  STALE: "stale",
  UPDATING: "stale",
  REVALIDATED: "stale",
  DYNAMIC: "dynamic",
  BYPASS: "dynamic",
  IGNORED: "dynamic",
  NONE: "dynamic",
});

/**
 * Map a platform cache-status header onto the closed outcome set. An absent or
 * unrecognized status is `unknown`: the serving path reports what it was told,
 * and never reads a cache outcome out of absence.
 */
export function noticeEdgeCacheOutcome(cacheStatus) {
  if (typeof cacheStatus !== "string") return "unknown";
  const normalized = cacheStatus.trim().toUpperCase();
  return CACHE_STATUS_OUTCOMES[normalized] || "unknown";
}

const SUBREQUEST_KINDS = Object.freeze({
  "/": "shell",
  "/data/meeting_outcomes_snapshot.json": "meeting-outcomes",
  "/data/notice_mandate_backlinks_lookup.json": "mandate-backlinks",
});

/**
 * Classify one subrequest target into the bounded vocabulary the response-path
 * measurement reports. An unrecognized target is `other`, never guessed at.
 */
export function noticeEdgeSubrequestKind(target) {
  if (typeof target !== "string" || !target) return "other";
  if (target.startsWith(NOTICE_EDGE_RECORD_ORIGIN)) return "record";
  if (target.startsWith("https://data.cityofnewyork.us/")) return "public-source";
  const [pathname] = target.split(/[?#]/, 1);
  return SUBREQUEST_KINDS[pathname] || "other";
}

/**
 * The one instant this measurement reads.
 *
 * Elapsed edge time is what this module exists to report, so the instant cannot
 * come from the caller: the caller is the thing being measured. The edge clock
 * advances on subrequest boundaries, so a difference between two of these
 * measures time spent waiting on subrequests rather than isolate work. Nothing
 * read here reaches a rendered document — it reaches a response header, as a
 * duration.
 */
export function noticeEdgeInstant() {
  // determinism-lint: allow clock measuring elapsed edge time is this module's purpose; the instant is read at the response boundary and only ever leaves as a duration on a response header, never as a value in a rendered document.
  return Date.now();
}

function noticeEdgeTimingDuration(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  // One decimal place is the resolution a coarsened edge clock can honestly
  // support, and keeps the header a fixed, bounded size.
  return Math.round(value * 10) / 10;
}

function noticeEdgeTimingMetric(name, durationMs, outcome) {
  const duration = noticeEdgeTimingDuration(durationMs);
  const parts = [name];
  if (duration !== null) parts.push(`dur=${duration}`);
  if (outcome) parts.push(`desc="${outcome}"`);
  return parts.join(";");
}

/**
 * Render the `Server-Timing` value for one Notice response.
 *
 * `cs-doc` is the function's own wall time producing the document — the origin
 * render cost, reported on every request because the function runs on every
 * request. `cs-record` is the record subrequest and the cache outcome the
 * platform reported for it. `cs-assets` is the resident-asset read that runs
 * alongside it.
 */
export function noticeEdgeTimingHeader({
  documentMs = null,
  recordMs = null,
  assetsMs = null,
  recordCacheOutcome = "unknown",
  documentCacheOutcome = NOTICE_EDGE_DOCUMENT_CACHE_OUTCOME,
} = {}) {
  const record = NOTICE_EDGE_CACHE_OUTCOMES.includes(recordCacheOutcome) ? recordCacheOutcome : "unknown";
  const document = NOTICE_EDGE_CACHE_OUTCOMES.includes(documentCacheOutcome)
    ? documentCacheOutcome
    : NOTICE_EDGE_DOCUMENT_CACHE_OUTCOME;
  return [
    noticeEdgeTimingMetric("cs-doc", documentMs, document),
    noticeEdgeTimingMetric("cs-record", recordMs, record),
    noticeEdgeTimingMetric("cs-assets", assetsMs, null),
  ].join(", ");
}

/**
 * Read a `Server-Timing` value back into the same vocabulary. Used by the
 * read-back side, which must never invent a duration or an outcome the header
 * did not carry.
 */
export function parseNoticeEdgeTiming(headerValue) {
  const parsed = {};
  if (typeof headerValue !== "string") return parsed;
  for (const entry of headerValue.split(",")) {
    const [rawName, ...rawParams] = entry.split(";");
    const name = rawName.trim();
    if (!name) continue;
    const metricEntry = { duration_ms: null, outcome: null };
    for (const param of rawParams) {
      const separator = param.indexOf("=");
      if (separator === -1) continue;
      const key = param.slice(0, separator).trim();
      const value = param.slice(separator + 1).trim().replace(/^"|"$/g, "");
      if (key === "dur") {
        const duration = Number(value);
        metricEntry.duration_ms = Number.isFinite(duration) && duration >= 0 ? duration : null;
      } else if (key === "desc") {
        metricEntry.outcome = NOTICE_EDGE_CACHE_OUTCOMES.includes(value) ? value : null;
      }
    }
    parsed[name] = metricEntry;
  }
  return parsed;
}
