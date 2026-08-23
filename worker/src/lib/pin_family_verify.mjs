/**
 * Authenticated desk review for PIN-family Checkbook ↔ PASSPort id mismatches.
 * Verdicts are append-only evidence; they do not rewrite the public crosswalk.
 */

import reviewDoc from "../data/pin_family_mismatch_review.json" with { type: "json" };
import {
  PIN_FAMILY_DECISIONS,
  PIN_FAMILY_REVIEW_VERSION,
  findReviewPair,
  reviewQueuePairs,
} from "../../../entity_resolution/cross_domain/pin_family_mismatch.mjs";

export const PIN_FAMILY_VERIFY_VERSION = PIN_FAMILY_REVIEW_VERSION;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function loadPinFamilyReview(doc = reviewDoc) {
  return doc;
}

export function pinFamilyVerdictInput(body = {}) {
  const pairId = clean(body.pair_id);
  const actor = clean(body.actor);
  const rawDecision = clean(body.decision).toLowerCase();
  const decision = rawDecision === "same"
    ? "same_contract"
    : rawDecision === "related"
      ? "related_instrument"
      : rawDecision;
  const note = clean(body.note).slice(0, 2000);
  if (!pairId) return { error: "pair-required" };
  if (!actor || actor.length > 120) return { error: "actor-required" };
  if (!PIN_FAMILY_DECISIONS.includes(decision)) return { error: "invalid-decision" };
  return { pairId, actor, decision, note };
}

export function buildPinFamilyVerdict(pair, input, opts = {}) {
  const parsed = pinFamilyVerdictInput(input);
  if (parsed.error) return parsed;
  if (!pair || pair.pair_id !== parsed.pairId) return { error: "pair-not-found" };
  return {
    id: opts.id || crypto.randomUUID(),
    pair_id: pair.pair_id,
    checkbook_contract_id: pair.evidence.checkbook.contract_id,
    passport_contract_id: pair.evidence.passport.contract_id,
    actor: parsed.actor,
    decision: parsed.decision,
    note: parsed.note,
    evidence_version: PIN_FAMILY_VERIFY_VERSION,
    evidence_json: JSON.stringify({
      evidence_version: PIN_FAMILY_VERIFY_VERSION,
      pair_id: pair.pair_id,
      identity_class: pair.identity_class,
      rule: pair.rule,
      rationale: pair.rationale,
      evidence: pair.evidence,
    }),
    created_at: opts.now || new Date().toISOString(),
  };
}

export function pinFamilyVerdictInsert(db, event) {
  return db.prepare(
    `INSERT INTO pin_family_verify_event
       (id, pair_id, checkbook_contract_id, passport_contract_id, actor, decision, note,
        evidence_version, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.id,
    event.pair_id,
    event.checkbook_contract_id,
    event.passport_contract_id,
    event.actor,
    event.decision,
    event.note || null,
    event.evidence_version,
    event.evidence_json,
    event.created_at,
  );
}

export function publicPinFamilyVerdict(event) {
  return {
    id: event.id,
    pair_id: event.pair_id,
    actor: event.actor,
    decision: event.decision,
    note: event.note,
    evidence_version: event.evidence_version,
    created_at: event.created_at,
  };
}

export async function appendPinFamilyVerdict(db, pair, input, opts = {}) {
  const event = buildPinFamilyVerdict(pair, input, opts);
  if (event.error) return event;
  await pinFamilyVerdictInsert(db, event).run();
  return publicPinFamilyVerdict(event);
}

export async function readPinFamilyVerdicts(db, pairIds = []) {
  const ids = [...new Set(pairIds.map(clean).filter(Boolean))];
  if (!db || !ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT id, pair_id, checkbook_contract_id, passport_contract_id, actor, decision, note,
            evidence_version, evidence_json, created_at
       FROM pin_family_verify_event
      WHERE pair_id IN (${placeholders})
      ORDER BY created_at ASC, rowid ASC`,
  ).bind(...ids).all();
  return result?.results || [];
}

export function latestVerdictByPair(events = []) {
  const latest = {};
  for (const event of events) latest[event.pair_id] = event;
  return latest;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

function moneyLabel(value) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function dl(entries) {
  return `<dl>${entries.map(([dt, dd]) =>
    `<div><dt>${escapeHtml(dt)}</dt><dd>${escapeHtml(dd ?? "—")}</dd></div>`).join("")}</dl>`;
}

function sideHtml(side, label) {
  return `<section class="record"><h3>${escapeHtml(label)}</h3>${dl([
    ["Contract id", side.contract_id],
    ["Vendor", side.vendor],
    ["Agency", side.agency],
    ["Amount", moneyLabel(side.current_amount)],
    ["Term", `${side.start || "—"} → ${side.end || "—"}`],
    ["Registered", side.registered],
    ["Status", side.status],
    ["FMS type", side.fms?.type],
    ["Title", side.title],
    ["Method", side.procurement_method],
  ])}</section>`;
}

function verdictHistoryHtml(events = []) {
  if (!events.length) return '<p class="empty-history">No verdict yet.</p>';
  return `<ol class="history">${events.map((event) => `<li><strong>${escapeHtml(event.decision)}</strong> by ${escapeHtml(event.actor)}
    <time datetime="${escapeHtml(event.created_at)}">${escapeHtml(event.created_at)}</time>
    ${event.note ? `<p>${escapeHtml(event.note)}</p>` : ""}</li>`).join("")}</ol>`;
}

export function pinFamilyReviewPayload(doc = reviewDoc, events = [], { includeAuto = false } = {}) {
  const queue = reviewQueuePairs(doc, { includeAuto });
  const latest = latestVerdictByPair(events);
  return {
    version: PIN_FAMILY_VERIFY_VERSION,
    metrics: doc.metrics,
    include_auto: includeAuto,
    count: queue.length,
    pairs: queue.map((pair) => ({
      ...pair,
      verdicts: events.filter((event) => event.pair_id === pair.pair_id).map(publicPinFamilyVerdict),
      latest_verdict: latest[pair.pair_id] ? publicPinFamilyVerdict(latest[pair.pair_id]) : null,
    })),
  };
}

export function renderPinFamilyVerifyPage(doc = reviewDoc, eventsByPair = {}, currentUrl = "https://desk.invalid/admin/pin-family-verify") {
  const url = new URL(currentUrl);
  const includeAuto = url.searchParams.get("view") === "auto";
  const sessionActor = url.searchParams.get("actor") || "";
  const payload = pinFamilyReviewPayload(doc, Object.values(eventsByPair).flat(), { includeAuto });
  const autoHref = new URL(currentUrl);
  autoHref.searchParams.set("view", "auto");
  const queueHref = new URL(currentUrl);
  queueHref.searchParams.delete("view");
  const cards = payload.pairs.map((pair) => {
    const e = pair.evidence;
    return `<article class="pair" data-pair-id="${escapeHtml(pair.pair_id)}">
      <p class="eyebrow">${escapeHtml(pair.identity_class)}${pair.rule ? ` · ${escapeHtml(pair.rule)}` : ""}</p>
      <h2>PIN ${escapeHtml(e.pin || "unknown")}</h2>
      <p class="rationale">${escapeHtml(pair.rationale)}</p>
      <p class="meta">Join ${escapeHtml(e.join_method || "unknown")} · vendor ${e.vendor_same ? "agrees" : "differs"} · amount ratio ${e.amount_ratio == null ? "—" : e.amount_ratio.toFixed(3)} · term gap ${e.term_gap_days == null ? "—" : `${e.term_gap_days}d`}</p>
      <div class="records">${sideHtml(e.checkbook, "Checkbook")}${sideHtml(e.passport, "PASSPort")}</div>
      <section><h3>Verdicts</h3>${verdictHistoryHtml(eventsByPair[pair.pair_id] || [])}</section>
      <form method="post">
        <input type="hidden" name="pair_id" value="${escapeHtml(pair.pair_id)}">
        <label>Operator <input name="actor" required maxlength="120" autocomplete="username" value="${escapeHtml(sessionActor)}"></label>
        <label>Note <textarea name="note" maxlength="2000"></textarea></label>
        <fieldset><legend>Write a verdict</legend>
          <button name="decision" value="same_contract">Same contract</button>
          <button name="decision" value="related_instrument">Related instrument</button>
        </fieldset>
        <small>Saves an append-only desk verdict. It does not change the public crosswalk.</small>
      </form>
    </article>`;
  }).join("\n");
  const metrics = doc.metrics || {};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PIN-family contract verify</title>
    <style>body{font:16px system-ui,sans-serif;max-width:1120px;margin:40px auto;padding:0 20px;color:#17202a;background:#f6f3ed}a{color:#175f78}.pair{background:white;border:1px solid #d8d2c8;border-radius:12px;padding:22px;margin:18px 0;box-shadow:0 2px 8px #0000000d}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#795548;font-weight:700}.pair h2{font-size:22px;margin:8px 0}.rationale,.meta{color:#40566a}.records{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.record{min-width:0;background:#f5f7f8;padding:14px;border-radius:8px}.pair dl{display:grid;gap:8px}.pair dt{font-size:12px;color:#687783}.pair dd{margin:4px 0 0;overflow-wrap:anywhere}.pair input,.pair textarea{display:block;width:100%;padding:8px;margin:6px 0 12px;box-sizing:border-box}.pair textarea{min-height:70px}.pair fieldset{border:0;padding:0;margin:8px 0}.pair button{padding:8px 14px;margin:4px 6px 4px 0}.summary{display:flex;gap:10px;flex-wrap:wrap}.summary span{background:#e3ddd1;border-radius:999px;padding:7px 11px;font:600 13px ui-monospace,monospace}.empty{padding:18px;background:#fff;border-radius:12px}@media(max-width:720px){.records{grid-template-columns:1fr}}</style></head><body>
    <header><p class="eyebrow">Authenticated desk review</p>
      <h1>PIN-family contract verify</h1>
      <p>PIN joins whose Checkbook and PASSPort contract ids differ. Auto-labeled related instruments stay off this queue. Exact contract-id matches stay public.</p>
      <div class="summary">
        <span>${metrics.pin_family_id_mismatches ?? 0} PIN-family mismatches</span>
        <span>${metrics.auto_related_instrument ?? 0} auto related-instrument</span>
        <span>${metrics.needs_review ?? 0} need a person</span>
      </div>
      <p>${includeAuto
        ? `<a href="${escapeHtml(`${queueHref.pathname}${queueHref.search}`)}">Show only genuinely ambiguous pairs</a>`
        : `<a href="${escapeHtml(`${autoHref.pathname}${autoHref.search}`)}">Audit auto-labeled pairs</a>`}</p>
    </header>
    ${cards || '<p class="empty">No genuinely ambiguous PIN-family pairs are waiting. Auto-labeled related instruments are on the audit view.</p>'}
  </body></html>`;
}

export { findReviewPair, reviewQueuePairs };
