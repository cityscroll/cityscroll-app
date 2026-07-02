// alerts — scheduled daily digest. The Worker's `scheduled` handler (cron in
// wrangler.toml: "0 13 * * *") calls runAlerts().
//
// It re-runs each saved query — both the legacy alerts.config.json watches AND every confirmed
// self-serve subscription in SUBS KV (compileSub maps {lens,filter} → a City Record / ZAP query)
// — diffs results against last run (Workers KV), and emails any NEW notices to the subscriber's
// OWN address via Resend (REST, no SDK), with a one-click unsubscribe.
//
// SAFETY: never sends mail "as James." The From is the app's own domain (ALERTS_FROM);
// the To is the subscriber's opted-in address from the config. DRY-RUN by default —
// only sends when env.ALERTS_LIVE === "true". Until then it just logs what it would send.
//
// SPEND GUARDS: MAX_PER_RUN + MAX_SENDS_PER_DAY (KV-counted) bound how much this can ever
// send, so a bug, a test, or a stuffed config can't run up a bill. A capped watch DEFERS to
// the next run (left unseen) rather than dropping its notices silently. See lib/sendcap.mjs.

import cfg from "../alerts.config.json";
import { capDecision } from "./lib/sendcap.mjs";
import { listUnsubscribe } from "./lib/unsub.mjs";
import { compileSub } from "./lib/compile.mjs";
import { signToken } from "./lib/token.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import { digestDecision, shortDate } from "./lib/digest.mjs";

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const REQ_URL = (id) => `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;

export async function runAlerts(env, watches = cfg.watches || []) {
  const FROM = env.ALERTS_FROM || "CROL-List <alerts@crol-list.org>";
  const LIVE = env.ALERTS_LIVE === "true";
  const maxPerRun = Number(env.MAX_PER_RUN) || 25;            // most emails one cron firing may send
  const maxPerDay = Number(env.MAX_SENDS_PER_DAY) || 50;      // daily ceiling, kept below Resend's free 100/day
  const heartbeatDays = Number(env.HEARTBEAT_DAYS) || 14;     // quiet days before a daily sub gets a liveness ping
  const day = new Date().toISOString().slice(0, 10);
  let sentToday = await getSendCount(env, day);
  let sentThisRun = 0;
  const results = [];

  for (const w of watches) {
    try {
      const rows = await runWatch(w);
      const seen = await getSeen(env, w.id);
      const fresh = rows.filter((r) => r.request_id && !seen.has(r.request_id));

      const { send, capped } = capDecision({
        hasFresh: fresh.length > 0, live: LIVE, hasEmail: !!w.email,
        sentThisRun, sentToday, maxPerRun, maxPerDay,
      });

      if (send) {
        await sendEmail(env, FROM, w.email, `CROL-List: ${fresh.length} new for "${w.label}"`, digestHtml(w, fresh), listUnsubscribe(FROM, w.id));
        sentThisRun++; sentToday++;
        await setSendCount(env, day, sentToday);
      }

      // Mark seen only when NOT capped. A capped watch is deferred — leave its notices unseen
      // so the next run retries them once the cap clears, rather than losing them silently.
      if (rows.length && !capped) await markSeen(env, w.id, rows.map((r) => r.request_id).filter(Boolean));

      results.push({ watch: w.id, found: rows.length, new: fresh.length, sent: send, capped });
    } catch (e) {
      results.push({ watch: w.id, error: String(e?.message || e) });
    }
  }

  // ---- replay confirmed subscriptions from SUBS KV (the self-serve path) ----
  const today = day;
  const isMonday = new Date().getUTCDay() === 1;
  for (const s of await subWatches(env)) {
    try {
      if (s.freq === "weekly" && !isMonday) { results.push({ sub: maskKey(s.key), skipped: "weekly" }); continue; }
      const q = compileSub(s, today);
      if (!q) { results.push({ sub: maskKey(s.key), skipped: `lens:${s.lens}` }); continue; }

      let rows = await fetchRows(q.url, q.params);
      if (q.postFilter) rows = rows.filter(q.postFilter); // e.g. entity watches refine stem-prefix matches
      const seen = await getSeen(env, s.key);
      const fresh = rows.filter((r) => r[q.idField] && !seen.has(r[q.idField]));

      // Confidence: decide whether to break silence (a weekly check-in or a daily heartbeat) even
      // with no fresh notices, so a quiet inbox never looks like a broken alert. `since` = when we
      // last emailed this sub (falls back to signup), rendered as "since <date>".
      const since = (await getLastSent(env, s.key)) || s.createdAt || null;
      const decision = digestDecision({ freshCount: fresh.length, freq: s.freq, lastSentDate: since, today, heartbeatDays });

      const { send, capped } = capDecision({
        hasFresh: decision.action !== "none", live: LIVE, hasEmail: !!s.email,
        sentThisRun, sentToday, maxPerRun, maxPerDay,
      });

      if (send) {
        const label = describeFilter(s.lens, s.filter);
        const unsubUrl = await unsubLink(env, s.key);
        let subject, html;
        if (decision.action === "match") {
          subject = `CROL-List: ${fresh.length} new — ${label}`;
          html = subDigestHtml(label, q.kind, fresh, unsubUrl, since, env.CONFIRM_BASE || "https://api.crol-list.org");
        } else {
          subject = decision.action === "weekly-empty"
            ? `CROL-List: nothing new this week — ${label}`
            : `CROL-List: still watching — ${label}`;
          html = quietHtml(label, decision.action, since, unsubUrl);
        }
        await sendEmail(env, FROM, s.email, subject, html, `<${unsubUrl}>`, true);
        sentThisRun++; sentToday++;
        await setSendCount(env, day, sentToday);
        await setLastSent(env, s.key, today);   // only on a real send, so the heartbeat clock tracks actual email
      }

      if (rows.length && !capped) await markSeen(env, s.key, rows.map((r) => r[q.idField]).filter(Boolean));
      results.push({ sub: maskKey(s.key), lens: s.lens, found: rows.length, new: fresh.length, action: decision.action, sent: send, capped });
    } catch (e) {
      results.push({ sub: maskKey(s.key), error: String(e?.message || e) });
    }
  }

  const deferred = results.filter((r) => r.capped).length;
  if (deferred) console.warn(`alerts: ${deferred} watch(es) deferred by send caps (perRun=${maxPerRun}, perDay=${maxPerDay})`);
  const summary = { ranAt: new Date().toISOString(), live: LIVE, sentThisRun, sentToday, caps: { perRun: maxPerRun, perDay: maxPerDay }, results };
  console.log("alerts run:", JSON.stringify(summary));
  return summary;
}

// ---- query a watch against the City Record -------------------------------

async function runWatch(w) {
  const params = new URLSearchParams();
  params.set("$select", "request_id,start_date,agency_name,short_title,pin,contract_amount,vendor_name,due_date,contact_name,contact_phone,email,street_address_1,section_name");
  params.set("$limit", String(w.limit || 25));
  params.set("$order", "start_date DESC");

  if (w.type === "awards") {
    params.set("$where", `type_of_notice_description='Award' AND contract_amount >= ${Number(w.min) || 1000000}`);
  } else if (w.where || w.q) {
    if (w.where) params.set("$where", w.where);
    if (w.q) params.set("$q", w.q);
  }

  const r = await fetch(`${SODA}?${params.toString()}`);
  if (!r.ok) throw new Error(`SODA ${r.status}`);
  return r.json();
}

// ---- actionable digest (phone / email / links per item) ------------------

function digestHtml(w, rows) {
  const money = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US"));
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const items = rows
    .map((r) => {
      const acts = [];
      if (r.email) acts.push(`<a href="mailto:${esc(r.email)}">✉ Email</a>`);
      if (r.contact_phone) acts.push(`<a href="tel:${esc(String(r.contact_phone).replace(/[^0-9+]/g, ""))}">☎ Call</a>`);
      acts.push(`<a href="${REQ_URL(r.request_id)}">↗ View in City Record</a>`);
      const sub = [r.agency_name, r.pin ? "PIN " + r.pin : "", money(r.contract_amount), r.due_date ? "due " + String(r.due_date).slice(0, 10) : ""]
        .filter(Boolean).map(esc).join(" · ");
      return `<li style="margin:0 0 14px"><b>${esc(r.short_title || r.section_name || "Notice")}</b><br>
        <span style="color:#555;font-size:13px">${sub}</span><br>
        <span style="font-size:13px">${acts.join(" &nbsp; ")}</span></li>`;
    })
    .join("");
  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CROL-List — ${esc(w.label)}</h2>
    <p style="color:#555">${rows.length} new ${rows.length === 1 ? "notice" : "notices"} in The City Record.</p>
    <ul style="list-style:none;padding:0">${items}</ul>
    <p style="color:#999;font-size:12px">You subscribed to this slice on crol-list.org. <a href="mailto:alerts@crol-list.org?subject=unsubscribe">Unsubscribe</a>.</p>
  </div>`;
}

async function sendEmail(env, from, to, subject, html, listUnsub, oneClick) {
  const body = { from, to, subject, html };
  // List-Unsubscribe: clients render a native Unsubscribe button. mailto form (legacy config
  // watches) lands at the reply address; https form + List-Unsubscribe-Post = RFC 8058 one-click.
  if (listUnsub) {
    body.headers = { "List-Unsubscribe": listUnsub };
    if (oneClick) body.headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return r.json();
}

// ---- per-watch "already seen" state (Workers KV) -------------------------

async function getSeen(env, id) {
  if (!env.ALERT_STATE) return new Set();
  try {
    const raw = await env.ALERT_STATE.get(`seen:${id}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

async function markSeen(env, id, ids) {
  if (!env.ALERT_STATE) return;
  try {
    const prev = await getSeen(env, id);
    ids.forEach((x) => prev.add(x));
    // keep the last ~500 ids so the value doesn't grow without bound
    await env.ALERT_STATE.put(`seen:${id}`, JSON.stringify([...prev].slice(-500)));
  } catch { /* ignore */ }
}

// ---- daily send counter (the denial-of-wallet ceiling, Workers KV) -------

async function getSendCount(env, day) {
  if (!env.ALERT_STATE) return 0;
  try { return Number(await env.ALERT_STATE.get(`sendcount:${day}`)) || 0; } catch { return 0; }
}

async function setSendCount(env, day, n) {
  if (!env.ALERT_STATE) return;
  // expire after 2 days so per-day counter keys self-clean
  try { await env.ALERT_STATE.put(`sendcount:${day}`, String(n), { expirationTtl: 3456000 }); } catch { /* ignore */ } // 40d: /stats reads a 7-day window; cap logic only ever reads today
}

// ---- per-sub "last time we emailed them" (Workers KV) --------------------
// Drives the confidence feature: the "since <date>" window and the daily heartbeat cadence.
// Durable (no TTL); value is a date string like "2026-07-02".

async function getLastSent(env, id) {
  if (!env.ALERT_STATE) return null;
  try { return (await env.ALERT_STATE.get(`lastsent:${id}`)) || null; } catch { return null; }
}

async function setLastSent(env, id, date) {
  if (!env.ALERT_STATE) return;
  try { await env.ALERT_STATE.put(`lastsent:${id}`, date); } catch { /* ignore */ }
}

// ---- confirmed subscriptions (SUBS KV) -----------------------------------

async function subWatches(env) {
  if (!env.SUBS) return [];
  const out = [];
  let cursor;
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      for (const k of res.keys) {
        try {
          const v = JSON.parse(await env.SUBS.get(k.name));
          if (v && v.email) out.push({ key: k.name, ...v });
        } catch { /* skip a malformed record */ }
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  } catch { /* SUBS unavailable → no self-serve sends this run */ }
  return out;
}

async function fetchRows(url, params) {
  const r = await fetch(`${url}?${new URLSearchParams(params).toString()}`);
  if (!r.ok) throw new Error(`open-data ${r.status}`);
  return r.json();
}

// A one-click unsubscribe URL: a long-lived signed token carrying the sub's KV key.
async function unsubLink(env, subKey) {
  if (!env.TOKEN_SECRET) return "mailto:alerts@crol-list.org?subject=unsubscribe";
  const base = env.CONFIRM_BASE || "https://api.crol-list.org"; // branded custom domain (workers.dev stays an alias)
  const token = await signToken(env.TOKEN_SECRET, { k: subKey }, { ttlSeconds: 60 * 24 * 3600 });
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
}

function maskKey(n) {
  return String(n).replace(/^(sub:)([^@:]{0,2})[^@:]*/, "$1$2***");
}

// Digest for a self-serve sub — award / rfp (City Record) or rezone (ZAP) items.
function subDigestHtml(label, kind, rows, unsubUrl, since, base = "https://api.crol-list.org") {
  const usd = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US"));
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const cr = (id) => `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
  const item = (r) => {
    if (kind === "rezone") {
      const meta = [r.borough, r.community_district ? "CD " + r.community_district : "", r.public_status, r.primary_applicant, /^[ty1]/i.test(String(r.mih_flag || "")) ? "affordable housing" : ""]
        .filter(Boolean).map(esc).join(" · ");
      return `<li style="margin:0 0 14px"><b>${esc(r.project_name || "(unnamed rezoning)")}</b><br>
        <span style="color:#555;font-size:13px">${meta}</span><br>
        <span style="font-size:13px"><a href="https://zap.planning.nyc.gov/projects/${encodeURIComponent(r.project_id)}">↗ View &amp; comment on ZAP</a></span></li>`;
    }
    const acts = [];
    if (r.email) acts.push(`<a href="mailto:${esc(r.email)}">✉ Email</a>`);
    const tel = String(r.contact_phone || "").replace(/[^0-9+]/g, "");
    if (tel.length >= 7) acts.push(`<a href="tel:${tel}">☎ Call</a>`);
    // Count-only click-through (R·B tier 3, team-approved 2026-07-02): /r bumps a per-day
    // counter and 302s to the permalink — no per-recipient tracking (see src/redirect.mjs).
    acts.push(`<a href="${base}/r/${encodeURIComponent(kind)}/${encodeURIComponent(r.request_id)}">↗ View on CROL-List</a>`);
    acts.push(`<a href="${cr(r.request_id)}">City Record</a>`);
    const meta = [r.agency_name, usd(r.contract_amount),
      r.due_date ? "due " + String(r.due_date).slice(0, 10) : "",
      r.event_date ? "event " + String(r.event_date).slice(0, 10) : ""]
      .filter(Boolean).map(esc).join(" · ");
    return `<li style="margin:0 0 14px"><b>${esc(r.short_title || "Notice")}</b><br>
      <span style="color:#555;font-size:13px">${meta}</span><br>
      <span style="font-size:13px">${acts.join(" &nbsp; ")}</span></li>`;
  };
  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CROL-List — ${esc(label)}</h2>
    <p style="color:#555">${rows.length} new ${rows.length === 1 ? "item" : "items"}${since ? ` since ${shortDate(since)}` : ""}.</p>
    <ul style="list-style:none;padding:0">${rows.map(item).join("")}</ul>
    <p style="color:#999;font-size:12px">You subscribed to this on crol-list.org. <a href="${esc(unsubUrl)}">Unsubscribe</a> (one-click).<br>
    Notice links go via a count-only redirect (${esc(base.replace(/^https?:\/\//, ""))}/r) so we can tell digests are useful — it counts clicks per day, never who clicked. Aggregates: <a href="https://crol-list.org/stats.html">crol-list.org/stats</a>.</p>
  </div>`;
}

// The "no news" email — a weekly check-in or a daily heartbeat. Same house style as the digest so
// silence never reads as a malfunction: the subscriber hears from us on a predictable cadence.
function quietHtml(label, action, since, unsubUrl) {
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const sinceStr = since ? `since ${shortDate(since)}` : "so far";
  const lead = action === "weekly-empty"
    ? `No new items this week for <b>${esc(label)}</b> — nothing new ${sinceStr}.`
    : `Still watching <b>${esc(label)}</b> — nothing new ${sinceStr}.`;
  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CROL-List</h2>
    <p style="color:#333">${lead}</p>
    <p style="color:#666;font-size:13px">This note just confirms your alert is working — we'll email the moment something matches.</p>
    <p style="color:#999;font-size:12px">You subscribed to this on crol-list.org. <a href="${esc(unsubUrl)}">Unsubscribe</a> (one-click).</p>
  </div>`;
}
