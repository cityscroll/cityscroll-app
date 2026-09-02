// POST /search-activity — private, bounded intake for one completed Search.
//
// Deliberately separate from /events and /performance-events. Those are aggregate,
// dimension-only usage and field-performance streams with no visitor, query, or
// result identity by design; a search-execution receipt is the opposite — private
// per-execution evidence. Merging them would either leak query text into aggregate
// analytics or dilute this route's stricter bounds, so they stay distinct.
//
// FAIL SOFT everywhere: a missing store, a rejected body, or an internal error all
// return promptly and never touch Search results or availability. The browser
// treats every response the same way, so this route can never become an oracle.

import {
  SEARCH_ACTIVITY_MAX_REQUEST_BYTES,
  normalizeSearchExecutionSubmission,
} from "../../capabilities/search_activity.mjs";
import { ANALYTICS_DEV_HEADER, hasValidDeveloperExclusion } from "./events.mjs";
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { deriveSubscriberId } from "./lib/subscriptions.mjs";
import {
  SEARCH_ACTIVITY_RETENTION_SECONDS,
  buildSearchExecutionReceipt,
  classifyUserAgent,
  networkObservation,
  newExecutionId,
  newReceiptId,
  redactedAccountLabel,
  resolveVisitor,
  searchActivityKey,
} from "./lib/search_activity.mjs";
import { emailFromRequest } from "./session.mjs";

const CORS_OPTS = Object.freeze({
  methods: "POST, OPTIONS",
  headers: `Content-Type, ${ANALYTICS_DEV_HEADER}`,
  maxAge: "86400",
  cacheControl: "no-store",
  credentials: true,
});

function receiptResponse(body, status, cors, setCookie) {
  const headers = new Headers({
    ...cors,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Classify this request as production or developer traffic using the SAME
 * developer-exclusion secret /events already uses. One mechanism, so a probe
 * excluded from public usage totals is excluded from these totals too.
 */
async function trafficClassFor(req, env, nowMs) {
  if (env?.ANALYTICS_ENVIRONMENT !== "production") return "developer";
  return await hasValidDeveloperExclusion(req, env, nowMs) ? "developer" : "production";
}

/** Resolve the recognized account, if any, through the existing session helper. */
async function recognizedAccount(req, env) {
  try {
    const email = await emailFromRequest(req, env);
    if (!email) return { recognized: false, subscriberId: null, accountLabel: null };
    return {
      recognized: true,
      subscriberId: await deriveSubscriberId(email),
      accountLabel: redactedAccountLabel(email),
    };
  } catch {
    // A recognition failure must never cost the receipt; it stays anonymous.
    return { recognized: false, subscriberId: null, accountLabel: null };
  }
}

export async function handleSearchActivity(req, env) {
  const origin = req.headers.get("Origin") || req.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, CORS_OPTS);
  if (!isAllowedRequestOrigin(origin, env)) {
    return receiptResponse({ ok: false, reason: "origin" }, 403, cors);
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return receiptResponse({ ok: false, reason: "method" }, 405, cors);

  const declaredLength = Number(req.headers.get("Content-Length") || 0);
  if (declaredLength > SEARCH_ACTIVITY_MAX_REQUEST_BYTES) {
    return receiptResponse({ ok: false, reason: "too-large" }, 413, cors);
  }

  // Read the body as text first so an undeclared oversized payload is bounded too.
  let raw;
  try {
    raw = await req.text();
  } catch {
    return receiptResponse({ ok: false, reason: "unreadable" }, 400, cors);
  }
  if (raw.length > SEARCH_ACTIVITY_MAX_REQUEST_BYTES) {
    return receiptResponse({ ok: false, reason: "too-large" }, 413, cors);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return receiptResponse({ ok: false, reason: "bad-json" }, 400, cors);
  }

  const normalized = normalizeSearchExecutionSubmission(input);
  if (!normalized.ok) {
    return receiptResponse({ ok: false, reason: normalized.reason }, 400, cors);
  }

  // Identity is resolved AFTER validation so a malformed body cannot mint a cookie.
  const visitor = resolveVisitor(req);
  const nowMs = Date.now();
  const [trafficClass, account] = await Promise.all([
    trafficClassFor(req, env, nowMs),
    recognizedAccount(req, env),
  ]);

  const receiptId = newReceiptId();
  const receipt = buildSearchExecutionReceipt(normalized.value, {
    receiptId,
    executionId: newExecutionId(),
    receivedAt: new Date(nowMs).toISOString(),
    visitorId: visitor.visitorId,
    subscriberId: account.subscriberId,
    accountLabel: account.accountLabel,
    recognized: account.recognized,
    trafficClass,
    userAgentObservation: classifyUserAgent(req.headers.get("User-Agent")),
    network: networkObservation(req),
  });

  if (!env?.ALERT_STATE?.put) {
    // No private store configured: still hand back the visitor cookie so browser
    // identity stays stable, and report the miss without failing the Search.
    return receiptResponse({ ok: false, reason: "not-configured" }, 202, cors, visitor.setCookie);
  }

  try {
    await env.ALERT_STATE.put(
      searchActivityKey({ receivedAtMs: nowMs, receiptId, trafficClass }),
      JSON.stringify(receipt),
      // Retention is mechanical: the store expires the row, no sweep required.
      { expirationTtl: SEARCH_ACTIVITY_RETENTION_SECONDS },
    );
  } catch {
    return receiptResponse({ ok: false, reason: "store-failed" }, 202, cors, visitor.setCookie);
  }

  return receiptResponse({ ok: true }, 202, cors, visitor.setCookie);
}
