// GET /admin/subs?key=… — operator read of confirmed subscriptions, straight from the worker's
// OWN SUBS binding. This answers "what does the worker actually see" independent of any external
// CLI/dashboard view of the namespace. FAIL CLOSED: 404 until ADMIN_KEY is set. Read-only.
//
// GET /admin/digest-rollup?key=…&email=… — dry-run account rollup for one email (no Resend send).

import { redactEmail } from "./lib/subscriptions.mjs";
import {
  WATCHLOG_LATEST_KEY,
  enrichWatchLogEvents,
  maskKey as watchLogMaskKey,
  readWatchLog,
} from "./lib/watchlog.mjs";
import {
  dryRunRollupForEmail,
  digestSendTestForEmail,
  previewNextDigestForSubscriber,
  runCatchUpDigests,
} from "./alerts.mjs";
import {
  INVESTIGATION_WORKSPACE_VERSION,
  buildInvestigationWorkspace,
  activeReviewItems,
  toReviewItems,
} from "../../entity_resolution/review/index.mjs";
import { readPossiblySamePairs } from "./lib/possibly_same.mjs";
import {
  FALSE_SPLIT_EVIDENCE_VERSION,
  appendFalseSplitDisposition,
  readFalseSplitDispositions,
} from "./lib/false_split_evidence.mjs";
import { appendActionLog, reviewActionFromDisposition } from "./lib/action_log.mjs";
import { buildOpsContract } from "./lib/ops_contract.mjs";
import { timingSafeEqualString } from "./lib/secret_compare.mjs";
import { ingestPassportPublic } from "./passport.mjs";
import { readDigestShadow, runDigestShadow } from "./digest_shadow.mjs";
import { handlePrivateStats } from "./stats.mjs";
import { readOwedBacklog, scanSubscriberMetadata, scheduledTimes } from "./owed_backlog.mjs";
import {
  BackfillCoverageError,
  BackfillInputError,
  FIRST_PAYLOAD_ID,
  readBackfillSubscriptions,
  runFirstPayloadBackfill,
} from "./digest_backfill.mjs";
import {
  DigestShadowHoldInputError,
  overrideDigestShadowHold,
  readDigestShadowDegradedReceipt,
  resolveDigestShadowHold,
} from "./digest_shadow_hold.mjs";

// Store digests rather than publishing the desk's private recipient addresses in this repo.
const DIGEST_TEST_SEND_ALLOWLIST = new Set([
  "a17c00b69ea8339da4543a92b20605a87efbd45067ebb8bce88fbe3e29368e03",
  "ba4676e7d45accb8101c2cc1acdd8e5681319413608bd723e44b4081b19c9bec",
  "aa0b61da59b2ad5210a4f4e425534b7437e6a0b8d0a388d82d660b60be1693e2",
  "7878af20a7538ed0a03e11f6b0f67f9ad8cc29b7116da0b10d7a7fc078d503fe",
]);

async function isAllowedDigestTestRecipient(email) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  const digest = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return DIGEST_TEST_SEND_ALLOWLIST.has(digest);
}

// Shared auth gate for every /admin/* route: key via ?key= or an Authorization: Bearer header.
// FAIL CLOSED — 404 (not 401) until ADMIN_KEY is configured, so an unconfigured deploy doesn't
// even reveal the route exists. Returns { ok:true } or { ok:false, res:<Response to return> }.
export function checkAdminKey(req, env) {
  if (!env.ADMIN_KEY) return { ok: false, res: json({ error: "not found" }, 404) };
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (key !== env.ADMIN_KEY) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  return { ok: true };
}

// The digest test-send probe also accepts the analytics developer-exclusion credential. It is
// an operator probe key, not a Cloudflare-issued administrator credential.
export function checkOperatorProbeKey(req, env) {
  if (!env.ADMIN_KEY && !env.ANALYTICS_DEV_KEY) return { ok: false, res: json({ error: "not found" }, 404) };
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (key !== env.ADMIN_KEY && key !== env.ANALYTICS_DEV_KEY) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  return { ok: true };
}

// Extracts the operator key exactly the way the shared gates do: ?key= query param or an
// Authorization: Bearer header. Centralized so the scoped gate below stays in lockstep.
function requestKey(req) {
  const url = new URL(req.url);
  return url.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
}

// Scoped gate for GET/POST /admin/digest-shadow. GET additionally accepts the read-only
// SHADOW_STATUS_KEY so an ops proxy can surface the rehearsal status without custody of the
// full ADMIN_KEY. POST (rerun / hold override) and every other /admin/* route still require
// ADMIN_KEY. Both secrets are compared in constant time and never logged. Fails closed
// (404, not 401) when no accepted secret is configured; the 401 shape matches checkAdminKey.
export function checkDigestShadowAuth(req, env) {
  const allowShadowStatus = req.method === "GET" && new URL(req.url).pathname === "/admin/digest-shadow";
  if (allowShadowStatus) {
    if (!env.ADMIN_KEY && !env.SHADOW_STATUS_KEY) return { ok: false, res: json({ error: "not found" }, 404) };
  } else if (!env.ADMIN_KEY) {
    return { ok: false, res: json({ error: "not found" }, 404) };
  }
  const key = requestKey(req);
  if (env.ADMIN_KEY && timingSafeEqualString(key, env.ADMIN_KEY)) return { ok: true };
  if (allowShadowStatus && env.SHADOW_STATUS_KEY && timingSafeEqualString(key, env.SHADOW_STATUS_KEY)) return { ok: true };
  return { ok: false, res: json({ error: "unauthorized" }, 401) };
}

export async function handleAdminSubs(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (!env.SUBS) return json({ error: "no-store" }, 503);

  const subs = [];
  const sampleKeys = [];
  let cursor, totalKeys = 0;
  do {
    const res = await env.SUBS.list({ cursor });
    totalKeys += res.keys.length;
    for (const k of res.keys) {
      if (sampleKeys.length < 12) sampleKeys.push(maskKey(k.name));
      if (k.name.startsWith("sub:")) {
        let v = null;
        try { v = JSON.parse(await env.SUBS.get(k.name)); } catch { /* skip */ }
        if (v) subs.push({ email: redactEmail(v.email), lens: v.lens, filter: v.filter, freq: v.freq, paused: !!v.paused, createdAt: v.createdAt });
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  return json({ confirmedSubs: subs.length, totalKeysInStore: totalKeys, subs, sampleKeys }, 200);
}

// GET /admin/watch-log?key=…&days=7 — operator read of watch lifecycle changes.
export async function handleAdminWatchLog(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const days = new URL(req.url).searchParams.get("days") || "7";
  const events = await readWatchLog(env, days);
  return json({ days: Math.max(1, Math.min(31, Number(days) || 7)), events }, 200);
}

// POST /admin/watch-log/enrich?key=… — retrofit thin stored lifecycle events from live SUBS.
// JSON: { days?: 1..31, date?: "YYYY-MM-DD", overrides?: [{ at?, subKeyMasked?, action?, label, freq?, detail? }] }
// `date` selects the newest UTC day and is intended for bounded historical repairs.
export async function handleAdminWatchLogEnrich(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.ALERT_STATE || !env.SUBS) return json({ error: "no-store" }, 503);

  let body = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const days = Math.max(1, Math.min(31, Number(body.days) || 7));
  const hasDate = body.date != null;
  const endDate = hasDate && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? new Date(`${body.date}T00:00:00.000Z`)
    : new Date();
  if (hasDate && (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)
      || Number.isNaN(endDate.valueOf()) || endDate.toISOString().slice(0, 10) !== body.date)) {
    return json({ error: "invalid-date" }, 400);
  }
  const overrides = Array.isArray(body.overrides) ? body.overrides : [];
  const liveSubsByMask = await liveWatchRecordsByMask(env.SUBS);
  const keys = [WATCHLOG_LATEST_KEY];
  const cursor = new Date(endDate);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    keys.push(`watchlog:${cursor.toISOString().slice(0, 10)}`);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  let scanned = 0;
  let enriched = 0;
  let unchanged = 0;
  for (const key of keys) {
    let raw;
    try { raw = await env.ALERT_STATE.get(key); } catch { continue; }
    if (!raw) continue;
    let events;
    try { events = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(events)) continue;
    const result = enrichWatchLogEvents(events, liveSubsByMask, overrides);
    if (result.enriched) {
      try {
        await env.ALERT_STATE.put(key, JSON.stringify(result.events));
      } catch {
        return json({ error: "write-failed", scanned, enriched, unchanged }, 503);
      }
    }
    scanned += events.length;
    enriched += result.enriched;
    unchanged += result.unchanged;
  }
  return json({ scanned, enriched, unchanged }, 200);
}

async function liveWatchRecordsByMask(store) {
  const records = new Map();
  let cursor;
  try {
    do {
      const page = await store.list({ prefix: "sub:", cursor });
      for (const key of page.keys) {
        const masked = watchLogMaskKey(key.name);
        if (!masked) continue;
        let record;
        try { record = JSON.parse(await store.get(key.name)); } catch { continue; }
        // The mask deliberately hides most of the key. Do not guess when two live keys collide.
        if (records.has(masked)) records.set(masked, null);
        else if (record) records.set(masked, record);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  } catch { /* return the records collected so far */ }
  return records;
}

// GET /admin/feedback?key=… — operator read of stored feedback rows, straight from the worker's
// OWN FEEDBACK binding. FAIL CLOSED: 404 until ADMIN_KEY is set. Read-only. Newest first. Emails
// are redacted here (the notification email carries the real Reply-To); only `fb:` rows are read,
// so the rate-limit counters (rl:*) in the same namespace stay out of the listing.
export async function handleAdminFeedback(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (!env.FEEDBACK) return json({ error: "no-store" }, 503);

  const items = [];
  let cursor, totalKeys = 0;
  do {
    const res = await env.FEEDBACK.list({ prefix: "fb:", cursor });
    totalKeys += res.keys.length;
    for (const k of res.keys) {
      let v = null;
      try { v = JSON.parse(await env.FEEDBACK.get(k.name)); } catch { /* skip */ }
      if (v) items.push({
        id: k.name,
        category: v.category,
        message: v.message,
        email: v.email ? redactEmail(v.email) : "",
        ip: v.ip,
        ua: v.ua,
        at: v.at,
      });
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  items.sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1)); // newest first
  return json({ feedbackCount: items.length, totalFbKeys: totalKeys, items }, 200);
}

// GET/POST /admin/possibly-same?key=… — desk evidence for candidate vendor pairs.
// POST appends a disposition audit event; it never mutates source records or entity links.
export async function handleAdminPossiblySame(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (!new Set(["GET", "POST"]).has(req.method)) return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "no-store" }, 503);

  let pairs = [];
  try {
    pairs = await readPossiblySamePairs(env.DB);
  } catch {
    return json({ error: "review-data-unavailable" }, 503);
  }
  if (req.method === "POST") {
    const requestUrl = new URL(req.url);
    let body;
    try {
      body = (req.headers.get("content-type") || "").includes("application/json")
        ? await req.json()
        : Object.fromEntries(await req.formData());
    } catch {
      return json({ error: "invalid-body" }, 400);
    }
    body.review_session ||= requestUrl.searchParams.get("review_session")
      || req.headers.get("X-Review-Session") || "";
    const pair = pairs.find((candidate) => candidate.id === String(body?.pair_id || ""));
    let event;
    try {
      event = await appendFalseSplitDisposition(env.DB, pair, body);
    } catch {
      return json({ error: "disposition-write-failed" }, 503);
    }
    if (event.error) return json({ error: event.error }, event.error === "pair-not-found" ? 404 : 400);
    // Fail-soft product action log: desk evidence remains authoritative; logging never blocks review.
    const reviewAction = reviewActionFromDisposition(event);
    if (reviewAction) await appendActionLog(env, reviewAction, { id: event.id });
    if ((req.headers.get("accept") || "").includes("application/json")) {
      return json({ event }, 201);
    }
    const target = new URL(req.url);
    target.searchParams.set("saved", event.id);
    return new Response(null, { status: 303, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
  }

  const items = activeReviewItems(toReviewItems(pairs));
  let events;
  try {
    events = await readFalseSplitDispositions(env.DB, items.map((item) => item.id));
  } catch {
    return json({ error: "review-data-unavailable" }, 503);
  }
  const eventsByPair = Object.groupBy(events, (event) => event.pair_id);
  const selectedPairId = new URL(req.url).searchParams.get("pair") || "";
  if (selectedPairId) {
    const workspace = buildInvestigationWorkspace(selectedPairId, items);
    if (!workspace) return json({ error: "pair-not-found" }, 404);
    const workspaceEvents = Object.fromEntries(workspace.comparisons.map((comparison) => [
      comparison.id,
      eventsByPair[comparison.id] || [],
    ]));
    if ((req.headers.get("accept") || "").includes("application/json")) {
      return json({ workspace, dispositions: workspaceEvents }, 200);
    }
    return new Response(renderInvestigationWorkspacePage(workspace, workspaceEvents, req.url), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if ((req.headers.get("accept") || "").includes("application/json")) {
    const labelsPerSession = {};
    const labelsPerHour = {};
    for (const event of events) {
      const hour = String(event.created_at || "").slice(0, 13);
      if (hour) labelsPerHour[hour] = (labelsPerHour[hour] || 0) + 1;
      let snapshot = {};
      try { snapshot = JSON.parse(event.evidence_json || "{}"); } catch { /* old event */ }
      const session = String(snapshot.review_session || "").trim();
      if (session) labelsPerSession[session] = (labelsPerSession[session] || 0) + 1;
    }
    return json({
      reviewVersion: FALSE_SPLIT_EVIDENCE_VERSION,
      source: "live_dual_write",
      count: items.length,
      measured: {
        candidates: items.length,
        disposition_events: events.length,
        ordering: {
          strategy: "active_information_gain_v1",
          baseline: "existing_shared_keys_then_observed_at_order",
          labels_per_hour: labelsPerHour,
          labels_per_session: labelsPerSession,
        },
      },
      items: items.map((item) => ({ ...item, dispositions: eventsByPair[item.id] || [] })),
    }, 200);
  }
  return new Response(renderPossiblySamePage(items, eventsByPair, req.url), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

function confidenceLabel(value) {
  return value == null ? "Score unavailable" : `${Math.round(value * 100)}% candidate score`;
}

function candidateBasis(evidence = {}) {
  const keys = Array.isArray(evidence.shared_keys) ? evidence.shared_keys : [];
  if (!keys.length) return "Blocking overlap";
  return keys.map((key) => {
    if (key.startsWith("stem:")) return `same normalized stem: ${key.slice(5)}`;
    if (key.startsWith("tok:")) return `shared token: ${key.slice(4)}`;
    return `shared key: ${key}`;
  }).join(" · ");
}

function observedFieldsHtml(side) {
  const rows = Object.entries(side.observed_fields || {}).map(([field, value]) =>
    `<tr><th scope="row">${escapeHtml(field)}</th><td>${escapeHtml(value)}</td></tr>`).join("");
  return rows || '<tr><td colspan="2">No normalized fields recorded.</td></tr>';
}

function sourceRecordHtml(side, label) {
  const source = side.source_url
    ? `<a href="${escapeHtml(side.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(side.source || "Open source")}</a>`
    : escapeHtml(side.source || "Source unavailable");
  return `<section class="record"><h3>${escapeHtml(label)} · ${escapeHtml(side.name)}</h3>
    <dl><div><dt>Source</dt><dd>${source}</dd></div>
      <div><dt>Source-record key</dt><dd>${escapeHtml(side.source_record_key || "Not supplied")}</dd></div>
      <div><dt>Snapshot ID</dt><dd>${escapeHtml(side.id || "Not supplied")}</dd></div>
      <div><dt>Observed</dt><dd>${escapeHtml(side.observed_at || "Not supplied")}</dd></div></dl>
    <table><caption>Observed fields</caption><tbody>${observedFieldsHtml(side)}</tbody></table></section>`;
}

function comparisonFeaturesHtml(evidence = {}) {
  const features = evidence.comparison_features || {};
  const rows = Object.entries(features).map(([field, value]) =>
    `<tr><th scope="row">${escapeHtml(field)}</th><td>${escapeHtml(Array.isArray(value) ? value.join(", ") || "—" : value)}</td></tr>`).join("");
  return `<details><summary>Comparison features</summary><table><tbody>${rows || '<tr><td>No comparison features recorded.</td></tr>'}</tbody></table></details>`;
}

function assertionSourceHtml(assertion = {}) {
  const sourceLabel = assertion.source_system || "Source";
  const source = assertion.source_url
    ? `<a href="${escapeHtml(assertion.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceLabel)}</a>`
    : escapeHtml(sourceLabel);
  return `<li class="assertion"><span class="evidence-label assertion-label">Source assertion</span>
    <strong>${source}</strong>
    <span class="assertion-value">${escapeHtml(assertion.value)}</span>
    <small>${escapeHtml(assertion.source_field)} · record ${escapeHtml(assertion.source_system_id || assertion.source_record_id || "not supplied")}</small></li>`;
}

function assertionInterpretationHtml(evidence = {}) {
  const rail = evidence.assertion_interpretation;
  if (!rail?.conflicts?.length) return "";
  return `<section class="evidence-rail"><h3>Assertion vs interpretation</h3>
    <p>Publisher values are shown as assertions. CityScroll's comparison is labeled separately and does not replace either source.</p>
    ${rail.conflicts.map((conflict) => `<article class="field-conflict">
      <h4>${escapeHtml(conflict.label)}</h4>
      <ul class="assertions">${conflict.assertions.map(assertionSourceHtml).join("")}</ul>
      <div class="interpretation"><span class="evidence-label interpretation-label">CityScroll interpretation</span>
        <strong>Conflict · unresolved</strong><p>${escapeHtml(conflict.interpretation?.summary)}</p></div>
    </article>`).join("")}
  </section>`;
}

function dispositionHistoryHtml(events = []) {
  if (!events.length) return '<p class="empty-history">No dispositions recorded.</p>';
  return `<ol class="history">${events.map((event) => `<li><strong>${escapeHtml(event.decision)}</strong> by ${escapeHtml(event.actor)}
    <time datetime="${escapeHtml(event.created_at)}">${escapeHtml(event.created_at)}</time>
    ${event.note ? `<p>${escapeHtml(event.note)}</p>` : ""}
    <small>${escapeHtml(event.evidence_version)} · event ${escapeHtml(event.id)}</small></li>`).join("")}</ol>`;
}

export function renderPossiblySamePage(items = [], eventsByPair = {}, currentUrl = "https://desk.invalid/admin/possibly-same") {
  const workspaceHref = (pairId) => {
    const url = new URL(currentUrl);
    url.searchParams.delete("saved");
    url.searchParams.set("pair", pairId);
    return `${url.pathname}${url.search}`;
  };
  const session = new URL(currentUrl).searchParams.get("review_session") || "";
  const cards = items.map((item) => `<article class="pair" data-pair-id="${escapeHtml(item.id)}">
    <p class="eyebrow">${escapeHtml(item.label)}</p>
    <h2>${escapeHtml(item.left.name)} <span aria-hidden="true">↔</span> ${escapeHtml(item.right.name)}</h2>
    <p class="score">${escapeHtml(confidenceLabel(item.confidence))} · ${escapeHtml(item.method)} · information gain ${escapeHtml(item.review_priority?.information_gain ?? "—")}</p>
    <p><strong>Candidate basis:</strong> ${escapeHtml(candidateBasis(item.evidence))}</p>
    <p><a class="workspace-link" href="${escapeHtml(workspaceHref(item.id))}">Open private evidence workspace</a></p>
    <div class="records">${sourceRecordHtml(item.left, "Record A")}${sourceRecordHtml(item.right, "Record B")}</div>
    ${assertionInterpretationHtml(item.evidence)}
    ${comparisonFeaturesHtml(item.evidence)}
    <p class="note">This is a review lead, not a finding. Confirm identity from the underlying records before taking action.</p>
    <section><h3>Disposition history</h3>${dispositionHistoryHtml(eventsByPair[item.id] || [])}</section>
    <form method="post"><input type="hidden" name="pair_id" value="${escapeHtml(item.id)}"><input type="hidden" name="review_session" value="${escapeHtml(session)}">
      <label>Operator <input name="actor" required maxlength="120" autocomplete="username"></label>
      <label>Evidence note <textarea name="note" maxlength="2000" aria-label="Evidence note for ${escapeHtml(item.id)}"></textarea></label>
      <fieldset><legend>Append disposition</legend>
        <button name="decision" value="same">Same</button>
        <button name="decision" value="different">Different</button>
        <button name="decision" value="defer">Defer</button></fieldset>
      <small>Saving appends a ${FALSE_SPLIT_EVIDENCE_VERSION} audit event. It does not change entity links.</small>
    </form>
  </article>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Possibly same vendors</title>
    <style>body{font:16px system-ui,sans-serif;max-width:1120px;margin:40px auto;padding:0 20px;color:#17202a;background:#f6f3ed}.pair{background:white;border:1px solid #d8d2c8;border-radius:12px;padding:22px;margin:18px 0;box-shadow:0 2px 8px #0000000d}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#795548;font-weight:700}.pair h2{font-size:22px;margin:8px 0}.score{color:#40566a;font-family:ui-monospace,monospace}.records{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.record{min-width:0;background:#f5f7f8;padding:14px;border-radius:8px}.pair dl{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pair dl div{min-width:0}.pair dt{font-size:12px;color:#687783}.pair dd{margin:4px 0 0;overflow-wrap:anywhere}.pair table{width:100%;border-collapse:collapse;font-size:13px}.pair th,.pair td{text-align:left;vertical-align:top;border-top:1px solid #d8dfe3;padding:6px;overflow-wrap:anywhere}.pair th{width:35%}.evidence-rail{margin:18px 0;padding:16px;border:1px solid #d8b36a;border-radius:10px;background:#fffaf0}.field-conflict{padding:12px 0;border-top:1px solid #ead8b6}.field-conflict h4{margin:0 0 8px}.assertions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;list-style:none;padding:0}.assertion,.interpretation{min-width:0;padding:12px;border-radius:7px}.assertion{background:#fff;border:1px solid #ded7ca}.assertion strong,.assertion-value,.assertion small,.interpretation strong{display:block;overflow-wrap:anywhere}.assertion-value{margin:6px 0;font:600 15px ui-monospace,monospace}.assertion small{color:#687783}.interpretation{margin-top:10px;background:#eaf3f7;border-left:4px solid #39788f}.evidence-label{display:inline-block;margin-bottom:6px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.assertion-label{background:#f1e9d9;color:#604a25}.interpretation-label{background:#cfe5ee;color:#194f64}.interpretation p{margin-bottom:0}.note{border-left:3px solid #d39b36;padding-left:10px}.pair input,.pair textarea{display:block;width:100%;padding:8px;margin:6px 0 12px;box-sizing:border-box}.pair textarea{min-height:70px}.pair fieldset{border:0;padding:0;margin:8px 0}.pair button{padding:8px 14px;margin:4px 6px 4px 0}.history time,.history small{display:block;color:#687783}.empty,.empty-history{padding:18px;background:#fff;border-radius:12px}@media(max-width:720px){.records,.pair dl,.assertions{grid-template-columns:1fr}}</style></head><body>
    <header><p class="eyebrow">Authenticated desk review</p><h1>Possibly same vendors</h1><p>These candidate pairs are surfaced for human review. Dispositions are an append-only evidence trail; records are not combined or exposed in the public site.</p></header>
    ${cards || '<p class="empty">No candidate pairs are currently surfaced from recent dual-write observations.</p>'}
  </body></html>`;
}

function workspaceAssertionRailHtml(rail = {}) {
  const assertions = (rail.assertions || []).map(assertionSourceHtml).join("");
  const interpretations = (rail.interpretations || []).map((interpretation) =>
    `<li><span class="evidence-label interpretation-label">CityScroll interpretation</span>
      <strong>${escapeHtml(interpretedStatus(interpretedStatusValue(interpretation)))}</strong>
      <p>${escapeHtml(interpretation.summary || "No comparison summary recorded.")}</p>
      <small>Comparison ${escapeHtml(interpretation.pair_id)}</small></li>`).join("");
  return `<article class="workspace-assertion"><h3>${escapeHtml(rail.label)}</h3>
    <ul class="assertions">${assertions || '<li>No publisher assertions recorded.</li>'}</ul>
    <ol class="interpretations">${interpretations || '<li>No interpretation recorded.</li>'}</ol></article>`;
}

function interpretedStatusValue(interpretation = {}) {
  return [interpretation.status, interpretation.resolution].filter(Boolean).join(" · ") || "unresolved";
}

function interpretedStatus(value) {
  const text = String(value || "unresolved");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sourceDisplayName(value) {
  return String(value || "Source")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function workspaceSourceRailHtml(rail = {}) {
  return `<section class="source-rail"><h2>${escapeHtml(sourceDisplayName(rail.source))}</h2>
    <p>${rail.records.length} immutable source snapshot${rail.records.length === 1 ? "" : "s"}</p>
    ${rail.records.map((record) => sourceRecordHtml(record, "Source record")).join("")}</section>`;
}

function workspaceDispositionHtml(comparison, events = []) {
  return `<article class="comparison"><h3>Candidate comparison</h3>
    <dl><div><dt>Pair ID</dt><dd>${escapeHtml(comparison.id)}</dd></div>
      <div><dt>Method</dt><dd>${escapeHtml(comparison.method)}</dd></div>
      <div><dt>Shared keys</dt><dd>${escapeHtml((comparison.shared_keys || []).join(", ") || "None recorded")}</dd></div></dl>
    <h4>Disposition history</h4>${dispositionHistoryHtml(events)}</article>`;
}

export function renderInvestigationWorkspacePage(workspace, eventsByPair = {}, currentUrl = "https://desk.invalid/admin/possibly-same") {
  const backUrl = new URL(currentUrl);
  backUrl.searchParams.delete("pair");
  backUrl.searchParams.delete("saved");
  const selectedEvents = eventsByPair[workspace.id] || [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Private evidence workspace</title>
    <style>body{font:16px system-ui,sans-serif;max-width:1220px;margin:36px auto;padding:0 20px;color:#17202a;background:#f2eee6}a{color:#175f78}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:#795548;font-weight:750}.scope{max-width:760px}.summary{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.summary span{background:#e3ddd1;border-radius:999px;padding:7px 11px;font:600 13px ui-monospace,monospace}.source-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px;align-items:start}.source-rail{min-width:0;background:#fff;border-top:5px solid #8c6a3e;border-radius:10px;padding:18px;box-shadow:0 2px 8px #0000000d}.source-rail>h2{text-transform:capitalize;margin-top:0}.record{min-width:0;background:#f6f7f7;padding:14px;border-radius:8px;margin-top:12px}.record h3{font-size:16px}.record dl,.comparison dl{display:grid;grid-template-columns:1fr 1fr;gap:8px}.record dl div,.comparison dl div{min-width:0}.record dt,.comparison dt{font-size:12px;color:#687783}.record dd,.comparison dd{margin:4px 0 0;overflow-wrap:anywhere}.record table{width:100%;border-collapse:collapse;font-size:13px}.record th,.record td{text-align:left;vertical-align:top;border-top:1px solid #d8dfe3;padding:6px;overflow-wrap:anywhere}.record th{width:35%}.assertion-section,.comparison-section,.decision{margin-top:24px}.workspace-assertion,.comparison,.decision{background:#fff;border:1px solid #d8d2c8;border-radius:10px;padding:18px;margin:12px 0}.assertions{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:10px;list-style:none;padding:0}.assertion{min-width:0;padding:12px;border:1px solid #ded7ca;border-radius:7px}.assertion strong,.assertion-value,.assertion small{display:block;overflow-wrap:anywhere}.assertion-value{margin:6px 0;font:600 15px ui-monospace,monospace}.assertion small{color:#687783}.interpretations{background:#eaf3f7;border-left:4px solid #39788f;padding:12px 12px 12px 34px}.evidence-label{display:inline-block;margin-bottom:6px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.assertion-label{background:#f1e9d9;color:#604a25}.interpretation-label{background:#cfe5ee;color:#194f64}.history time,.history small{display:block;color:#687783}.decision input,.decision textarea{display:block;width:100%;padding:8px;margin:6px 0 12px;box-sizing:border-box}.decision textarea{min-height:80px}.decision fieldset{border:0;padding:0}.decision button{padding:8px 14px;margin-right:6px}@media(max-width:620px){.record dl,.comparison dl{grid-template-columns:1fr}}</style></head><body>
    <nav><a href="${escapeHtml(`${backUrl.pathname}${backUrl.search}`)}">← Candidate tray</a></nav>
    <header><p class="eyebrow">Authenticated desk · ${escapeHtml(INVESTIGATION_WORKSPACE_VERSION)}</p><h1>Private evidence workspace</h1>
      <p class="scope">${escapeHtml(workspace.scope.note)}</p>
      <div class="summary"><span>${workspace.scope.source_rails} source rails</span><span>${workspace.scope.source_records} source records</span><span>${workspace.scope.candidate_pairs} candidate comparisons</span></div></header>
    <main><section aria-labelledby="source-rails"><h2 id="source-rails">Publisher evidence rails</h2><div class="source-grid">${workspace.sources.map(workspaceSourceRailHtml).join("")}</div></section>
      <section class="assertion-section" aria-labelledby="assertion-rails"><h2 id="assertion-rails">Assertion and interpretation rails</h2>
        <p>Publisher assertions remain separate from CityScroll interpretations. Conflicts are left unresolved.</p>
        ${workspace.assertions.map(workspaceAssertionRailHtml).join("") || '<p>No cross-source assertion conflicts are recorded for this case.</p>'}</section>
      <section class="comparison-section" aria-labelledby="comparisons"><h2 id="comparisons">Candidate comparisons</h2>
        ${workspace.comparisons.map((comparison) => workspaceDispositionHtml(comparison, eventsByPair[comparison.id] || [])).join("")}</section>
      <form class="decision" method="post"><h2>Append a disposition for the selected pair</h2><input type="hidden" name="pair_id" value="${escapeHtml(workspace.id)}">
        <label>Operator <input name="actor" required maxlength="120" autocomplete="username"></label>
        <label>Evidence note <textarea name="note" maxlength="2000"></textarea></label>
        <fieldset><legend>Disposition</legend><button name="decision" value="same">Same</button><button name="decision" value="different">Different</button><button name="decision" value="defer">Defer</button></fieldset>
        <small>Saving appends an immutable evidence event. It does not change entity links or source assertions.</small>
        ${selectedEvents.length ? `<p>${selectedEvents.length} prior event${selectedEvents.length === 1 ? "" : "s"} for this pair.</p>` : ""}</form>
    </main></body></html>`;
}

/**
 * GET /admin/ops-contract?key=…
 * Versioned machine-readable ops contract for desk panels (no secrets).
 * FAIL CLOSED: same ADMIN_KEY gate as other /admin/* routes. Never on public /stats.
 */
export async function handleAdminOpsContract(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  return json(buildOpsContract(), 200);
}

/** GET /admin/owed-backlog?key=… — read-only D1 delivery obligations for the desk. */
export async function handleAdminOwedBacklog(req, env, options = {}) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const backlog = await readOwedBacklog(env, options);
  if (!backlog.available) return json({ error: backlog.error || "no-store" }, 503);
  return json(backlog, 200);
}

function digestHtmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|h[1-6]|section|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function previewSubscribers(env, backlog) {
  const byId = new Map((backlog.subscribers || []).map((row) => [row.subscriber_id, { ...row }]));
  const metadata = await scanSubscriberMetadata(env.SUBS);
  for (const [subscriberId, details] of metadata.bySubscriber) {
    const current = byId.get(subscriberId) || {
      subscriber_id: subscriberId,
      owed_count: 0,
      next_scheduled_at: backlog.next_scheduled_at,
    };
    byId.set(subscriberId, {
      ...current,
      subscriber_label: details.subscriber_label || current.subscriber_label || subscriberId,
      active_watch_count: details.active_watch_count ?? current.active_watch_count ?? 0,
    });
  }
  return [...byId.values()].sort((a, b) => String(a.subscriber_id).localeCompare(String(b.subscriber_id)));
}

function previewLink(req, subscriberId = null) {
  const url = new URL(req.url);
  url.pathname = "/admin/next-digest-preview";
  url.searchParams.delete("view");
  if (subscriberId) url.searchParams.set("subscriber", subscriberId);
  else url.searchParams.delete("subscriber");
  return `${url.pathname}${url.search}`;
}

function renderNextDigestPreviewPage(body) {
  const heading = body.index ? "Next scheduled digest previews" : "Next scheduled digest preview";
  const content = body.index
    ? (body.subscribers.length
      ? `<table><thead><tr><th>Subscriber</th><th>Owed</th><th>Preview</th></tr></thead><tbody>${body.subscribers.map((row) => `<tr><th scope="row">${escapeHtml(row.subscriber_label)}<br><small>${escapeHtml(row.subscriber_id)}</small></th><td>${deskNumber(row.owed_count)}</td><td><a href="${escapeHtml(row.preview_url)}">Open preview</a></td></tr>`).join("")}</tbody></table>`
      : "<p>No subscribers are configured.</p>")
    : `<dl class="ops"><dt>Subscriber</dt><dd>${escapeHtml(body.subscriber_label)}<br><small>${escapeHtml(body.subscriber_id)}</small></dd><dt>Next scheduled at</dt><dd>${escapeHtml(deskDate(body.next_scheduled_at))}</dd><dt>Owed items</dt><dd>${deskNumber(body.owed_item_count)}</dd></dl>${body.empty ? "<p class=\"empty\">No owed delivery items. The next scheduled digest has nothing to preview.</p>" : `<h2>Digest body</h2><p><strong>${escapeHtml(body.subject)}</strong></p><div class="digest-body">${body.digest_html}</div>`}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading} · CityScroll desk</title><style>:root{color-scheme:light;--ink:#172031;--muted:#5f6875;--paper:#f2f0e9;--card:#fffdf7;--rule:#cbc6b8}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,sans-serif}.wrap{max-width:900px;margin:auto;padding:28px 20px 64px}.card{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:20px}header{border-bottom:3px solid var(--ink);padding-bottom:18px;margin-bottom:20px}.eyebrow{margin:0 0 6px;color:#1f6b4f;font-weight:800;letter-spacing:.13em;text-transform:uppercase;font-size:.75rem}h1,h2{font-family:ui-serif,Georgia,serif}h1{margin:0;font-size:clamp(2rem,5vw,3.4rem);line-height:1.05}.lede,.empty{color:var(--muted)}.ops{display:grid;grid-template-columns:1fr auto;gap:8px 14px;margin:0 0 20px}.ops dt{color:var(--muted)}.ops dd{margin:0;text-align:right;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{padding:9px 6px;border-bottom:1px solid var(--rule);text-align:right}th:first-child{text-align:left}small{color:var(--muted);font-weight:400}.digest-body{border-top:1px solid var(--rule);padding-top:18px;overflow-wrap:anywhere}@media(max-width:600px){.wrap{padding-inline:14px}.ops{grid-template-columns:1fr}.ops dd{text-align:left}}</style></head><body><main class="wrap"><header><p class="eyebrow">Authenticated desk · read-only preview</p><h1>${heading}</h1><p class="lede">A dry-run of the body the next scheduled drain would send. This surface sends nothing and advances no delivery state.</p></header><section class="card">${content}</section></main></body></html>`;
}

/** GET /admin/next-digest-preview?key=…[&subscriber=<opaque id|redacted label>] — read-only. */
export async function handleAdminNextDigestPreview(req, env, options = {}) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "no-store" }, 503);

  const url = new URL(req.url);
  const backlog = await readOwedBacklog(env, options);
  if (!backlog.available) return json({ error: backlog.error || "no-store" }, 503);
  const subscribers = await previewSubscribers(env, backlog);
  const requested = url.searchParams.get("subscriber");
  if (!requested) {
    const body = {
      schema: "next-digest-preview.v1",
      index: true,
      generated_at: backlog.generated_at,
      next_scheduled_at: backlog.next_scheduled_at,
      subscribers: subscribers.map((row) => ({
        subscriber_id: row.subscriber_id,
        subscriber_label: row.subscriber_label || row.subscriber_id,
        owed_count: Number(row.owed_count) || 0,
        preview_url: previewLink(req, row.subscriber_id),
      })),
    };
    if (url.searchParams.get("view") === "html" || (req.headers.get("accept") || "").includes("text/html")) {
      return new Response(renderNextDigestPreviewPage(body), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
    }
    return json(body, 200);
  }

  const matches = subscribers.filter((row) => row.subscriber_id === requested || row.subscriber_label === requested);
  if (matches.length > 1) return json({ error: "subscriber-ambiguous" }, 409);
  if (!matches.length) return json({ error: "subscriber-not-found" }, 404);
  const row = matches[0];
  const timing = scheduledTimes(options.now || new Date());
  const result = await previewNextDigestForSubscriber(env, row.subscriber_id, { day: timing.nextScheduledAt.slice(0, 10), now: timing.now });
  if (!result.ok) return json({ error: result.reason || "subscriber-not-found" }, 404);
  if (result.result?.error) return json({ error: "preview-unavailable" }, 503);
  const digest = result.result?.preview || null;
  const body = {
    schema: "next-digest-preview.v1",
    index: false,
    generated_at: timing.now.toISOString(),
    next_scheduled_at: timing.nextScheduledAt,
    subscriber_id: row.subscriber_id,
    subscriber_label: row.subscriber_label || row.subscriber_id,
    owed_item_count: Number(row.owed_count) || 0,
    mode: result.mode,
    empty: !digest?.html,
    subject: digest?.subject || null,
    digest_html: digest?.html || null,
    digest_text: digest?.html ? digestHtmlToText(digest.html) : null,
  };
  if (url.searchParams.get("view") === "html" || (req.headers.get("accept") || "").includes("text/html")) {
    return new Response(renderNextDigestPreviewPage(body), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
  }
  return json(body, 200);
}

/**
 * POST /admin/digest-backfill?key=… — enqueue the exact first carry-forward
 * payload. This is a no-send path: it reads SUBS, writes D1 outbox rows, and
 * never evaluates a watch or invokes a provider.
 */
export async function handleAdminDigestBackfill(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.DB || !env.SUBS) return json({ error: "no-store" }, 503);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  if (body?.payload_id !== FIRST_PAYLOAD_ID) return json({ error: "unsupported-backfill-payload" }, 400);
  try {
    const subscriptions = await readBackfillSubscriptions(env.SUBS);
    const result = await runFirstPayloadBackfill({
      db: env.DB,
      subscriptions,
      ownerEmail: body?.owner_email,
      sourceSnapshots: body?.source_snapshots,
      deliveryEvidence: body?.delivery_evidence,
      firstOwedAt: body?.first_owed_at,
      payloadId: body?.payload_id,
    });
    return json(result, 200);
  } catch (error) {
    const status = error instanceof BackfillCoverageError || error instanceof BackfillInputError
      ? error.status
      : 503;
    return json({ error: error instanceof Error ? error.message : "backfill failed" }, status);
  }
}

function deskNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function deskDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? escapeHtml(value)
    : date.toLocaleString("en-US", { timeZone: "UTC" }) + " UTC";
}

export function renderAdminStatsPage(stats = {}, owedBacklog = null, owedBacklogHref = "/admin/owed-backlog", nextDigestPreviewHref = "/admin/next-digest-preview") {
  const usage = stats.usage || {};
  const daily = Object.entries(usage.growth?.by_day || {})
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 14);
  const dailyRows = daily.length
    ? daily.map(([day, row]) => `<tr><th scope="row">${escapeHtml(day)}</th><td>${deskNumber(row.page_views)}</td><td>${deskNumber(row.interactions)}</td></tr>`).join("")
    : '<tr><td colspan="3">No daily activity is recorded.</td></tr>';
  const lastRun = stats.digests?.last_run || {};
  const backlogRows = owedBacklog?.subscribers || [];
  const backlogTotal = owedBacklog?.summary?.owed_count || 0;
  const backlogUnavailable = owedBacklog && owedBacklog.available === false;
  const backlogContent = !owedBacklog || backlogUnavailable
    ? "<p>Owed backlog is unavailable until the D1 read model is configured.</p>"
    : backlogRows.length === 0
      ? "<p>No owed delivery items.</p>"
      : `<table><thead><tr><th>Subscriber</th><th>Owed</th><th>Oldest</th><th>Last delivery</th><th>Drill-in</th></tr></thead><tbody>${backlogRows.map((row) => `<tr${row.overdue ? ' class="overdue-row"' : ""}><th scope="row">${escapeHtml(row.subscriber_label)}<br><small>${escapeHtml(row.subscriber_id)} · ${row.active_watch_count == null ? "watch count unavailable" : `${deskNumber(row.active_watch_count)} active watch${row.active_watch_count === 1 ? "" : "es"}`}</small></th><td>${deskNumber(row.owed_count)} ${row.overdue ? '<strong class="overdue-badge">OVERDUE</strong>' : ""}</td><td>${escapeHtml(row.oldest_age)}<br><small>${escapeHtml(deskDate(row.oldest_owed_at))}</small></td><td>${escapeHtml(row.last_delivery_status || "Not recorded")}<br><small>${escapeHtml(deskDate(row.last_sent_at))}</small></td><td>${escapeHtml(row.oldest_lens || "Not recorded")} / ${escapeHtml(row.oldest_item_id || "Not recorded")}</td></tr>`).join("")}</tbody></table>`;
  const backlogPanel = `<section class="panel backlog-panel" aria-labelledby="owed-backlog-heading"><div class="panel-heading"><div><h2 id="owed-backlog-heading">Owed delivery backlog</h2><p class="panel-note">${backlogUnavailable ? "D1 read model unavailable." : `${deskNumber(backlogTotal)} item${backlogTotal === 1 ? "" : "s"} owed across ${deskNumber(backlogRows.length)} subscriber${backlogRows.length === 1 ? "" : "s"}. Next scheduled digest: ${escapeHtml(deskDate(owedBacklog?.next_scheduled_at))}.`}</p></div><span class="panel-actions"><a href="${escapeHtml(owedBacklogHref)}">Open JSON</a><a href="${escapeHtml(nextDigestPreviewHref)}">Preview next digests</a></span></div>${backlogContent}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Product activity · CityScroll desk</title><style>
  :root{color-scheme:light;--ink:#172031;--muted:#5f6875;--paper:#f2f0e9;--card:#fffdf7;--rule:#cbc6b8;--green:#1f6b4f;--red:#a52d25}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,sans-serif}.wrap{max-width:1080px;margin:auto;padding:28px 20px 64px}header{border-bottom:3px solid var(--ink);padding-bottom:18px}.eyebrow{margin:0 0 6px;color:var(--green);font-weight:800;letter-spacing:.13em;text-transform:uppercase;font-size:.75rem}h1{font:700 clamp(2rem,5vw,3.6rem)/1.02 ui-serif,Georgia,serif;margin:0}.lede{max-width:70ch;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0}.card,.panel{min-width:0;background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:16px}.value{font:750 2rem/1 ui-serif,Georgia,serif}.label{margin-top:8px;color:var(--muted);font-size:.82rem;font-weight:750;text-transform:uppercase;letter-spacing:.05em}.panels{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:14px}.backlog-panel{grid-column:1/-1}.panel-heading{display:flex;justify-content:space-between;gap:16px;align-items:start}.panel-actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end}.panel-actions a{white-space:nowrap}.panel-note{color:var(--muted);margin:0 0 12px}.overdue-row{background:#fff0ed}.overdue-badge{display:inline-block;color:#fff;background:var(--red);border-radius:4px;padding:1px 5px;font-size:.68rem;letter-spacing:.04em;margin-left:4px}h2{margin:0 0 10px;font:700 1.25rem ui-serif,Georgia,serif}.ops{display:grid;grid-template-columns:1fr auto;gap:8px 14px;margin:0}.ops dt{color:var(--muted)}.ops dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{padding:8px;border-bottom:1px solid var(--rule);text-align:right;font-variant-numeric:tabular-nums}th:first-child{text-align:left}small{color:var(--muted);font-weight:400}.stamp{color:var(--muted);font-size:.82rem;margin-top:18px}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.panels{grid-template-columns:1fr}.backlog-panel{grid-column:auto}}@media(max-width:430px){.wrap{padding-inline:14px}.grid{grid-template-columns:1fr}.value{font-size:1.75rem}}
  </style></head><body><main class="wrap"><header><p class="eyebrow">Authenticated desk · private operations</p><h1>Product activity</h1><p class="lede">Usage, subscriptions, and delivery volumes live here because they describe product operations and people’s activity—not the public civic corpus.</p></header>
  <section class="grid" aria-label="Product activity summary">
    <article class="card"><div class="value">${deskNumber(stats.subscriptions?.accounts)}</div><div class="label">Accounts with watches</div></article>
    <article class="card"><div class="value">${deskNumber(stats.subscriptions?.active)}</div><div class="label">Active watches</div></article>
    <article class="card"><div class="value">${deskNumber(stats.digests?.sent_last7d)}</div><div class="label">Digests · 7 days</div></article>
    <article class="card"><div class="value">${deskNumber(usage.page_views?.last7d)}</div><div class="label">Page views · 7 days</div></article>
    <article class="card"><div class="value">${deskNumber(usage.searches?.last7d)}</div><div class="label">Searches · 7 days</div></article>
    <article class="card"><div class="value">${deskNumber(usage.deep_links?.last7d)}</div><div class="label">Deep links · 7 days</div></article>
    <article class="card"><div class="value">${deskNumber(usage.exports?.last7d)}</div><div class="label">Exports · 7 days</div></article>
    <article class="card"><div class="value">${deskNumber(usage.alerts?.confirmed_last7d)}</div><div class="label">Watches confirmed · 7 days</div></article>
  </section><section class="panels"><article class="panel"><h2>Delivery operations</h2><dl class="ops">
    <dt>Digests sent today</dt><dd>${deskNumber(stats.digests?.sent_today)}</dd><dt>Catch-up sends today</dt><dd>${deskNumber(stats.digests?.catch_up_sent_today)}</dd><dt>Lagging subscriptions</dt><dd>${deskNumber(stats.digests?.lagging_subs)}</dd><dt>Last run</dt><dd>${deskDate(lastRun.ran_at || lastRun.ranAt || lastRun.at)}</dd><dt>Last-run status</dt><dd>${escapeHtml(lastRun.skipped_reason || lastRun.status || "Not recorded")}</dd>
  </dl></article><article class="panel"><h2>Daily activity</h2><table><thead><tr><th>UTC day</th><th>Page views</th><th>Actions</th></tr></thead><tbody>${dailyRows}</tbody></table></article>${backlogPanel}</section><p class="stamp">Generated ${deskDate(stats.generated)}. Private response: no-store.</p></main></body></html>`;
}

/** GET /admin/stats?key=… — private usage and delivery data formerly served on public /stats. */
export async function handleAdminStats(req, env, options = {}) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const response = await handlePrivateStats(req, env, options);
  const stats = await response.json();
  if (new URL(req.url).searchParams.get("view") === "html") {
    const owedBacklog = await readOwedBacklog(env, options);
    const owedBacklogUrl = new URL(req.url);
    owedBacklogUrl.pathname = "/admin/owed-backlog";
    owedBacklogUrl.searchParams.delete("view");
    const nextDigestPreviewUrl = new URL(req.url);
    nextDigestPreviewUrl.pathname = "/admin/next-digest-preview";
    nextDigestPreviewUrl.searchParams.delete("view");
    return new Response(renderAdminStatsPage(
      stats,
      owedBacklog,
      `${owedBacklogUrl.pathname}${owedBacklogUrl.search}`,
      `${nextDigestPreviewUrl.pathname}${nextDigestPreviewUrl.search}`,
    ), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }
  return json(stats, 200);
}

/**
 * GET /admin/digest-rollup?key=…&email=…
 * Dry-run the account digest (rollup when >1 active watch) without sending mail.
 * Forces ALERTS_LIVE-off evaluation; returns sections + day-log preview.
 */
export async function handleAdminDigestRollup(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "GET") return json({ error: "method" }, 405);
  const email = new URL(req.url).searchParams.get("email") || "";
  if (!email) return json({ error: "email-required" }, 400);
  try {
    const out = await dryRunRollupForEmail(env, email);
    return json(out, 200);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

/**
 * GET /admin/digest-shadow?key=…[&day=YYYY-MM-DD][&digest=<masked-id>]
 * Machine-readable 06:00 rehearsal summary. A redlined run deliberately returns 503 so
 * scheduled monitoring can wake on HTTP status while still consuming structured evidence.
 */
export async function handleAdminDigestShadow(req, env, { now = new Date() } = {}) {
  const auth = checkDigestShadowAuth(req, env);
  if (!auth.ok) return auth.res;
  if (!new Set(["GET", "POST"]).has(req.method)) return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "no-store" }, 503);
  if (req.method === "POST") {
    try {
      let body = {};
      const raw = await req.text();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return json({ error: "invalid-json" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json({ error: "invalid-json" }, 400);
        }
      }
      if (body.action === "override-hold") {
        try {
          const hold = await overrideDigestShadowHold(env.DB, {
            day: body.day,
            digestIds: body.digest_ids,
            reason: body.reason,
            now,
          });
          return json({ hold }, 200);
        } catch (error) {
          const status = error instanceof DigestShadowHoldInputError ? 400 : 503;
          return json({ error: "hold-override-failed", detail: String(error?.message || error) }, status);
        }
      }
      if (body.action && body.action !== "rerun") return json({ error: "invalid-action" }, 400);
      const summary = await runDigestShadow(env);
      return json({ summary, hold: summary.hold }, summary.ok ? 200 : 503);
    } catch (error) {
      return json({ error: "shadow-rerun-failed", detail: String(error?.message || error) }, 503);
    }
  }
  const url = new URL(req.url);
  const day = url.searchParams.get("day");
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "invalid-day" }, 400);
  const digestId = url.searchParams.get("digest");
  try {
    const out = await readDigestShadow(env.DB, { day, digestId });
    const statusDay = day || new Date(now).toISOString().slice(0, 10);
    const degradedReceipt = await readDigestShadowDegradedReceipt(env.ALERT_STATE, { day: statusDay });
    if (!out) {
      return json({ error: "not-run", degraded_receipt: degradedReceipt },
        degradedReceipt?.attention_status === "open" ? 503 : 404);
    }
    if (digestId && !out.preview) return json({ ...out, error: "preview-not-found" }, 404);
    const hold = day ? null : await resolveDigestShadowHold(env.DB, {
      now,
      receiptStore: env.ALERT_STATE,
    });
    const receipt = hold?.degraded_receipt || degradedReceipt;
    const attention = out.summary?.ok === false || receipt?.attention_status === "open";
    return json({ ...out, hold, degraded_receipt: receipt || null }, attention ? 503 : 200);
  } catch (error) {
    return json({ error: "shadow-read-failed", detail: String(error?.message || error) }, 503);
  }
}

/**
 * POST /admin/digest-send-test?key=…
 * Evaluate, or send once through, the normal digest path for one email.
 * State advancement is opt-in; test sends do not consume watermarks by default.
 */
export async function handleAdminDigestSendTest(req, env) {
  const auth = checkOperatorProbeKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const email = typeof body.email === "string" ? body.email : "";
  if (!email) return json({ error: "email-required" }, 400);
  if (!await isAllowedDigestTestRecipient(email)) return json({ error: "recipient-not-allowed" }, 403);
  if (body.live !== undefined && typeof body.live !== "boolean") return json({ error: "live-must-be-boolean" }, 400);
  if (body.advanceState !== undefined && typeof body.advanceState !== "boolean") return json({ error: "advanceState-must-be-boolean" }, 400);
  try {
    const out = await digestSendTestForEmail(env, email, {
      live: body.live === true,
      advanceState: body.advanceState === true,
    });
    return json(out, 200);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

function maskKey(n) {
  return n.replace(/^(sub:|rl:addr:)([^@:]{0,2})[^@:]*/, "$1$2***");
}
function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// POST /admin/digest-catchup?key=… — operator-triggered catch-up evaluation. Selects subs
// whose lastsent heartbeat lags by >= minLagDays (default 2), then enqueues owed identities.
// This endpoint never sends email or runs the delivery drain.
// Optional body: { minLagDays?: number, subKeys?: string[] }. FAIL CLOSED until ADMIN_KEY set.
export async function handleAdminDigestCatchUp(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let opts = {};
  try {
    const body = await req.text();
    if (body) opts = JSON.parse(body);
  } catch { /* empty body is fine */ }

  const minLagDays = Number(opts.minLagDays) || 2;
  const subKeys = Array.isArray(opts.subKeys) ? opts.subKeys.filter((k) => typeof k === "string") : null;

  const result = await runCatchUpDigests(env, { minLagDays, subKeys });
  return json({
    mode: "catch_up",
    live: result.live,
    candidates: result.candidates,
    sentThisRun: result.sentThisRun,
    sentToday: result.sentToday,
    results: result.results.map((r) => ({
      sub: r.sub, lens: r.lens, action: r.action,
      new: r.new || 0, found: r.found || 0, enqueued: r.enqueued || 0, sent: false,
      capped: !!r.capped, error: r.error || null, zeroMatch: !!r.zeroMatch,
      status: r.status || null, complete: r.complete === true, sections: r.sections || [],
    })),
  }, 200);
}

// POST /admin/passport-ingest?key=… — operator-triggered PASSPort Public rebuild
// (product tables + dual-write source_records when the flag is on). Same path as
// the daily cron. FAIL CLOSED until ADMIN_KEY is set.
export async function handleAdminPassportIngest(req, env) {
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const result = await ingestPassportPublic(env);
  return json({ mode: "passport_ingest", ...result }, result.ok ? 200 : 502);
}
