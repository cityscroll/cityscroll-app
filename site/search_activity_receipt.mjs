/**
 * Browser half of the search-execution receipt.
 *
 * It observes the settled render plan once and submits it to the private
 * `/search-activity` intake. It is deliberately incapable of affecting Search:
 * every path returns a status string, nothing throws, and no caller awaits a
 * result before painting. If the intake is missing, slow, blocked, or hostile,
 * the reader still sees exactly the same page.
 *
 * The browser never claims identity. Visitor cookie, recognized account, network
 * observation, traffic class, and receipt timing all belong to the Worker.
 */

import {
  SEARCH_ACTIVITY_CANONICAL_SEARCH_PATH,
  SEARCH_ACTIVITY_INTAKE_PATH,
  SEARCH_ACTIVITY_MAX_QUERY_LENGTH,
  SEARCH_ACTIVITY_MAX_REQUEST_BYTES,
  SEARCH_ACTIVITY_SCOPE_KEYS,
  SEARCH_EXECUTION_RECEIPT_SCHEMA,
  cleanReceiptText,
} from "../capabilities/search_activity.mjs";
import { normalizeUniversalSearchQuery } from "./universal_search_federator.mjs";

const RECEIPT_TIMEOUT_MS = 4_000;

/** Row shape the intake accepts; the plan already produces exactly these keys. */
function submissionRow(row) {
  return {
    reference: row.reference,
    entity_type: row.entity_type,
    family: row.family,
    kind: row.kind,
    rank: row.rank,
    title: row.title,
    canonical_href: row.canonical_href,
  };
}

/** Place context the canonical Search route already carries, bounded per key. */
export function searchActivityScope(searchParams) {
  const scope = {};
  if (!searchParams) return scope;
  for (const key of SEARCH_ACTIVITY_SCOPE_KEYS) {
    const value = cleanReceiptText(searchParams.get(key), 80);
    if (value) scope[key] = value;
  }
  return scope;
}

/**
 * Build the browser-owned half of one receipt from a settled render plan.
 * Returns null when there is nothing legitimate to observe (no query).
 */
export function buildSearchExecutionSubmission(plan, { query, scope = {}, now = new Date() } = {}) {
  const raw = cleanReceiptText(query, SEARCH_ACTIVITY_MAX_QUERY_LENGTH);
  if (!raw || !plan) return null;
  const normalized = cleanReceiptText(
    normalizeUniversalSearchQuery(raw),
    SEARCH_ACTIVITY_MAX_QUERY_LENGTH,
  ) || raw;
  return {
    schema: SEARCH_EXECUTION_RECEIPT_SCHEMA,
    occurred_at: new Date(now).toISOString(),
    query: { raw, normalized },
    search_path: SEARCH_ACTIVITY_CANONICAL_SEARCH_PATH,
    scope,
    // The front-door narrowing actually requested (site/search_front_door_scope.mjs),
    // not the place-context `scope` above. Without this, a Contracts-only execution's
    // untouched families would read as "checked and empty" instead of "never asked".
    front_door_scope: plan.scope?.id || "all",
    outcome: plan.outcome,
    rendered_count: plan.rendered_count,
    family_counts: plan.family_counts,
    incomplete_families: plan.incomplete_families,
    results: plan.rows.map(submissionRow),
    producers: plan.producers,
  };
}

/**
 * Submit one receipt. Never throws and never reports failure to the reader:
 * the return value exists only so tests can assert fail-soft behavior.
 */
export async function submitSearchExecutionReceipt(submission, {
  origins = [],
  fetchImpl,
  timeoutMs = RECEIPT_TIMEOUT_MS,
} = {}) {
  try {
    if (!submission) return "skipped";
    const send = fetchImpl || (typeof fetch === "function" ? fetch : null);
    const origin = origins[0];
    if (!send || !origin) return "skipped";

    const body = JSON.stringify(submission);
    // Refuse locally rather than making the intake reject an oversized request.
    if (body.length > SEARCH_ACTIVITY_MAX_REQUEST_BYTES) return "too-large";

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller && typeof setTimeout === "function"
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const response = await send(`${origin}${SEARCH_ACTIVITY_INTAKE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The visitor cookie is first-party to cityscroll.org and set by the API
        // host, so the intake must be a credentialed cross-origin request.
        credentials: "include",
        keepalive: true,
        body,
        ...(controller ? { signal: controller.signal } : {}),
      });
      return response?.ok ? "stored" : "rejected";
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    // Measurement must never break the search being measured.
    return "failed";
  }
}

/** Observe a settled Search execution. Fire-and-forget; resolves to a status. */
export function recordSearchExecution(plan, options = {}) {
  try {
    const submission = buildSearchExecutionSubmission(plan, options);
    return submitSearchExecutionReceipt(submission, options);
  } catch {
    return Promise.resolve("failed");
  }
}
