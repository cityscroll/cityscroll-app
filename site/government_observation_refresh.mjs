/**
 * Scheduled acquisition boundary for the three observer calendars.
 *
 * Readers consume the returned materialization; they never call this module or
 * a publisher. A failed, empty, or schema-drifted response is a source health
 * event, not evidence that the schedule is empty.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GOVERNMENT_REFRESH_SCHEMA = "cityscroll.government_observation_refresh.v1";
export const GOVERNMENT_RECEIPT_SCHEMA = "cityscroll.government_scheduled_receipt.v1";
export const GOVERNMENT_REFRESH_BOUNDS = Object.freeze({
  maxRequests: 100,
  maxResponseBytes: 5 * 1024 * 1024,
  maxAggregateBytes: 25 * 1024 * 1024,
  timeoutMs: 25_000,
  maxRedirects: 3,
  retries: 2,
  minOriginIntervalMs: 2_000,
});

const SOURCE_DEFINITIONS = Object.freeze([
  {
    id: "pdc-calendar",
    env: "CITYSCROLL_PDC_CALENDAR_REFRESH",
    url: "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page",
    cadenceHours: 24,
    cursor: true,
  },
  {
    id: "bsa-calendar",
    env: "CITYSCROLL_BSA_CALENDAR_REFRESH",
    url: "https://www.nyc.gov/site/bsa/public-hearings/upcoming-hearing-info.page",
    cadenceHours: 24,
    cursor: true,
  },
  {
    id: "oath-trial-calendar",
    env: "CITYSCROLL_OATH_TRIAL_CALENDAR_REFRESH",
    url: "https://www.nyc.gov/assets/oath/data/daily-calendar.csv",
    cadenceHours: 24,
    cursor: true,
  },
]);

export const GOVERNMENT_SOURCE_DEFINITIONS = SOURCE_DEFINITIONS;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const iso = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const sourceKey = (source) => source.id.toUpperCase().replaceAll("-", "_");

function disabled(source, env, root) {
  const value = String(env?.[source.env] || "").toLowerCase();
  return ["off", "0", "false", "disabled"].includes(value)
    || existsSync(join(root, `.${source.id}.refresh.off`));
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) || null;
}

async function readBounded(response, maxBytes) {
  const declared = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response exceeds byte bound");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("response exceeds byte bound");
  return bytes;
}

function defaultParser(bytes, source) {
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return { records: [], schema: `${source.id}.v1` };
  if (source.id === "oath-trial-calendar") {
    const [header, ...rows] = text.trim().split(/\r?\n/).map((line) => line.split(",").map((value) => value.trim()));
    return { schema: "cityscroll.oath_trial_calendar.v1", records: rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] || ""]))) };
  }
  try { return JSON.parse(text); } catch { return { schema: `${source.id}.v1`, records: [text] }; }
}

function validateParsed(parsed, source) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.records)) throw new Error("schema drift: records array is required");
  if (parsed.records.length === 0) return { ...parsed, empty: true };
  return parsed;
}

function materializationHash(value) {
  return sha256(JSON.stringify(value, Object.keys(value).sort()));
}

function failureMaterialization(previous, reason) {
  if (!previous?.materialization) return null;
  return { ...previous.materialization, retained_after_failure: reason };
}

async function fetchSource(source, options) {
  const bounds = { ...GOVERNMENT_REFRESH_BOUNDS, ...(options.bounds || {}) };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const previous = options.previous || null;
  const headers = { Accept: source.id === "oath-trial-calendar" ? "text/csv" : "text/html, application/json" };
  if (previous?.receipt?.etag) headers["If-None-Match"] = previous.receipt.etag;
  if (previous?.receipt?.lastModified) headers["If-Modified-Since"] = previous.receipt.lastModified;
  let lastError = null;
  for (let attempt = 0; attempt <= bounds.retries; attempt += 1) {
    try {
      if (options.requestBudget) {
        options.requestBudget.requests += 1;
        if (options.requestBudget.requests > bounds.maxRequests) throw new Error("request count exceeds run bound");
      }
      const response = await fetchImpl(source.url, { headers, redirect: "follow", signal: AbortSignal.timeout(bounds.timeoutMs) });
      if (response.status === 304 && previous?.materialization) return { kind: "not-modified", response, bytes: new Uint8Array() };
      const bytes = await readBounded(response, bounds.maxResponseBytes);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { kind: "fetched", response, bytes };
    } catch (error) {
      lastError = error;
      if (attempt < bounds.retries) continue;
    }
  }
  throw lastError || new Error("request failed");
}

export function sourceRefreshDisabled(sourceId, { env = process.env, root = "." } = {}) {
  const source = SOURCE_DEFINITIONS.find((item) => item.id === sourceId);
  return source ? disabled(source, env, root) : false;
}

export async function refreshGovernmentSource(source, options = {}) {
  const observedAt = iso(options.asOf || new Date().toISOString());
  if (!observedAt) throw new Error("refresh requires a valid observation timestamp");
  const previous = options.previous || null;
  const baseReceipt = { schema: GOVERNMENT_REFRESH_SCHEMA, source_id: source.id, observed_at: observedAt, cadence_hours: source.cadenceHours, cursor: previous?.receipt?.cursor || null };
  if (disabled(source, options.env || process.env, options.root || ".")) {
    return { status: "skipped", materialization: previous?.materialization || null, receipt: { ...baseReceipt, status: "disabled", kill_switch: true, last_good_preserved: Boolean(previous?.materialization) } };
  }
  try {
    const result = await fetchSource(source, options);
    if (result.kind === "not-modified") {
      return { status: "succeeded", materialization: previous.materialization, receipt: { ...baseReceipt, status: "succeeded", not_modified: true, source_hash: previous.receipt.source_hash, extraction_receipt: previous.receipt.extraction_receipt, materialization_hash: previous.receipt.materialization_hash, last_good_preserved: false } };
    }
    const sourceHash = sha256(result.bytes);
    const parsed = validateParsed((options.parse || defaultParser)(result.bytes, source), source);
    if (parsed.empty) throw new Error("empty parse");
    const materialization = { ...parsed, source_id: source.id, observed_at: observedAt, source_hash: sourceHash };
    return { status: "succeeded", materialization, receipt: { ...baseReceipt, status: "succeeded", source_hash: sourceHash, bytes: result.bytes.byteLength, extraction_receipt: { schema: "cityscroll.extraction_receipt.v1", parser: options.parserVersion || `${source.id}.refresh.v1`, status: "ok" }, etag: responseHeader(result.response, "etag"), lastModified: responseHeader(result.response, "last-modified"), materialization_hash: materializationHash(materialization), last_good_preserved: false } };
  } catch (error) {
    const reason = error.message === "empty parse" ? "empty_parse" : /schema drift/.test(error.message) ? "schema_drift" : /response exceeds/.test(error.message) ? "byte_limit" : "network_or_retry_exhaustion";
    return { status: "degraded", materialization: failureMaterialization(previous, reason), receipt: { ...baseReceipt, status: "failed", failure: reason, error: error.message, last_good_preserved: Boolean(previous?.materialization), materialization_hash: previous?.receipt?.materialization_hash || null } };
  }
}

/** Run the registered sources as one bounded scheduled acquisition cycle. */
export async function runGovernmentObservationRefresh({
  asOf = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  parse,
  env = process.env,
  root = ".",
  sources = SOURCE_DEFINITIONS,
  previousBySource = {},
  bounds = {},
} = {}) {
  const effectiveBounds = { ...GOVERNMENT_REFRESH_BOUNDS, ...bounds };
  const requestBudget = { requests: 0, bytes: 0 };
  const results = [];
  for (const source of sources) {
    const result = await refreshGovernmentSource(source, { asOf, fetchImpl, parse, env, root, bounds: effectiveBounds, previous: previousBySource[source.id], requestBudget });
    if (result.receipt.bytes) requestBudget.bytes += result.receipt.bytes;
    if (requestBudget.bytes > effectiveBounds.maxAggregateBytes) {
      result.status = "degraded";
      result.receipt.status = "failed";
      result.receipt.failure = "aggregate_byte_limit";
      result.materialization = failureMaterialization(previousBySource[source.id], "aggregate_byte_limit");
    }
    results.push({ source_id: source.id, ...result });
  }
  return {
    schema: GOVERNMENT_REFRESH_SCHEMA,
    observed_at: iso(asOf),
    request_count: requestBudget.requests,
    bytes: requestBudget.bytes,
    bounds: effectiveBounds,
    sources: results,
    status: results.some((result) => result.status === "degraded") ? "degraded" : "succeeded",
  };
}

export function buildGovernmentReadback({ sourceId, cycle, materializationHash: hash, buildRevision, publicationId, surfaces = {} } = {}) {
  const required = ["canonical", "observer", "search", "ics"];
  const assertions = Object.fromEntries(required.map((key) => [key, surfaces[key]?.ok === true && surfaces[key]?.content_hash ? "passed" : "failed"]));
  return { source_id: sourceId, cycle, observed_at: iso(cycle?.observed_at), source_hash: cycle?.source_hash || null, materialization_hash: hash || null, build_revision: buildRevision || null, publication_id: publicationId || null, assertions, success: Object.values(assertions).every((value) => value === "passed") };
}

export function buildGovernmentScheduledReceipt({ cycles = [], readbacks = [], now = new Date().toISOString() } = {}) {
  const successful = cycles.filter((cycle) => cycle?.status === "succeeded");
  const ordered = [...successful].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const twoApart = ordered.length >= 2 && Date.parse(ordered.at(-1).observed_at) - Date.parse(ordered.at(-2).observed_at) >= 24 * 60 * 60 * 1000;
  return { schema: GOVERNMENT_RECEIPT_SCHEMA, generated_at: iso(now), cycles: ordered, readbacks, consecutive_successful_cycles: ordered.length, two_cycles_24h_apart: twoApart, readbacks_passed: readbacks.length > 0 && readbacks.every((readback) => readback.success) };
}

export function scheduleFreshnessGuidance({ lastSuccessAt, asOf = new Date().toISOString(), officialUrl } = {}) {
  const age = lastSuccessAt ? Date.parse(asOf) - Date.parse(lastSuccessAt) : Infinity;
  return { stale: age >= 36 * 60 * 60 * 1000, ageHours: Number.isFinite(age) ? age / 3_600_000 : null, prompt: age >= 36 * 60 * 60 * 1000 ? "Confirm the schedule with the official source before going." : null, officialUrl: officialUrl || null };
}

/**
 * Separate 30-day guide policy review record. This is deliberately not the
 * 36-hour schedule freshness prompt: it tracks when the resident-facing guide
 * copy was last policy-reviewed, so a fresh schedule can still be overdue for
 * review and a stale schedule can carry a current review.
 */
export const GUIDE_POLICY_REVIEW_INTERVAL_DAYS = 30;

export function guidePolicyReviewState({ lastReviewAt, asOf = new Date().toISOString() } = {}) {
  const reviewedAt = iso(lastReviewAt);
  const age = reviewedAt ? Date.parse(asOf) - Date.parse(reviewedAt) : null;
  const due = age === null || age >= GUIDE_POLICY_REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  return { kind: "guide_policy_review", interval_days: GUIDE_POLICY_REVIEW_INTERVAL_DAYS, due, age_days: Number.isFinite(age) ? age / 86_400_000 : null, last_review_at: reviewedAt };
}

export function writeGovernmentScheduledReceipt(path, receipt) {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function readGovernmentScheduledReceipt(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
