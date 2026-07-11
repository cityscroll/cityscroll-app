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
// the next run (left unseen) rather than dropping its notices silently. The guard itself is
// the `sendcap` package (a pure "may I make one more paid action?" decision).

import cfg from "../alerts.config.json" with { type: "json" };
import { capDecision } from "@jimdc/sendcap";
import { signToken, listUnsubscribe } from "optin-token";
import { compileSub, vendorStem } from "./lib/compile.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import { digestDecision, shortDate } from "./lib/digest.mjs";
import { runCheckbookPipeline } from "./checkbook.mjs";
import { runMocsPlanPipeline } from "./mocs_plan.mjs";

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

  // Trigger checkbook and MOCS forecasting pipelines
  try {
    const subs = await subWatches(env);
    await runCheckbookPipeline(env, watches, subs);
    await runMocsPlanPipeline(env);
  } catch (e) {
    console.error("alerts: forecasting pipelines error:", e);
  }


  for (const w of watches) {
    try {
      const rows = await runWatch(w);
      const seen = await getSeen(env, w.id);
      const fresh = rows.filter((r) => r.request_id && !seen.has(r.request_id));

      const { allow: send, capped } = capDecision({
        want: fresh.length > 0 && LIVE && !!w.email,
        counts: { "per-run": sentThisRun, daily: sentToday },
        caps: { "per-run": maxPerRun, daily: maxPerDay },
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
  // Two delivery modes, same per-sub logic (processOneSub):
  //   inline (default): the loop below, per-run + daily caps enforced in-run.
  //   queue  (QUEUE_DIGESTS="true" + DIGEST_QUEUE bound): one job per sub — each
  //   independently retryable, poison subs land in the DLQ; the DAILY cap remains
  //   the hard spend ceiling (per-run pacing becomes queue delivery itself).
  const today = day;
  const isMonday = new Date().getUTCDay() === 1;
  const ctx = {
    FROM, LIVE, heartbeatDays, today, isMonday,
    counts: () => ({ "per-run": sentThisRun, daily: sentToday }),
    caps: { "per-run": maxPerRun, daily: maxPerDay },
    onSent: async () => { sentThisRun++; sentToday++; await setSendCount(env, day, sentToday); },
  };
  if (env.QUEUE_DIGESTS === "true" && env.DIGEST_QUEUE) {
    let enqueued = 0;
    for (const s of await subWatches(env)) {
      await env.DIGEST_QUEUE.send({ key: s.key });
      enqueued++;
    }
    results.push({ mode: "queue", enqueued });
  } else {
    for (const s of await subWatches(env)) {
      results.push(await processOneSub(env, s, ctx));
    }
  }

  const deferred = results.filter((r) => r.capped).length;
  if (deferred) console.warn(`alerts: ${deferred} watch(es) deferred by send caps (perRun=${maxPerRun}, perDay=${maxPerDay})`);
  const summary = { ranAt: new Date().toISOString(), live: LIVE, sentThisRun, sentToday, caps: { perRun: maxPerRun, perDay: maxPerDay }, results };
  console.log("alerts run:", JSON.stringify(summary));
  return summary;
}

// One subscription, end to end: compile → fetch → forecasts → confidence decision →
// cap check → send → bookkeeping. ctx supplies identity, caps, counters, and clock so
// the inline loop and the queue consumer share this logic exactly.
export async function processOneSub(env, s, ctx) {
  try {
    if (s.freq === "weekly" && !ctx.isMonday) return { sub: maskKey(s.key), skipped: "weekly" };
    const q = compileSub(s, ctx.today);
    if (!q) return { sub: maskKey(s.key), skipped: `lens:${s.lens}` };

    const forecasts = await matchForecasts(env, s, ctx.today);

    let rows = await fetchRows(q.url, q.params);
    if (q.postFilter) rows = rows.filter(q.postFilter); // e.g. entity watches refine stem-prefix matches
    const seen = await getSeen(env, s.key);
    const fresh = rows.filter((r) => r[q.idField] && !seen.has(r[q.idField]));

    // Confidence: decide whether to break silence (a weekly check-in or a daily heartbeat) even
    // with no fresh notices, so a quiet inbox never looks like a broken alert. `since` = when we
    // last emailed this sub (falls back to signup), rendered as "since <date>".
    const since = (await getLastSent(env, s.key)) || s.createdAt || null;
    const effectiveCount = fresh.length + forecasts.length;
    const decision = digestDecision({ freshCount: effectiveCount, freq: s.freq, lastSentDate: since, today: ctx.today, heartbeatDays: ctx.heartbeatDays });

    const { allow: send, capped } = capDecision({
      want: (decision.action !== "none" || forecasts.length > 0) && ctx.LIVE && !!s.email,
      counts: ctx.counts(),
      caps: ctx.caps,
    });

    if (send) {
      const label = describeFilter(s.lens, s.filter);
      const unsubUrl = await unsubLink(env, s.key);
      let subject, html;

      const hasActivity = fresh.length > 0 || forecasts.length > 0;
      if (hasActivity) {
        const freshLabel = fresh.length > 0 ? `${fresh.length} new` : "";
        const forecastLabel = forecasts.length > 0 ? `${forecasts.length} forecast(s)` : "";
        const parts = [freshLabel, forecastLabel].filter(Boolean).join(" & ");
        subject = `CROL-List: ${parts} — ${label}`;
        html = subDigestHtml(label, q.kind, fresh, unsubUrl, since, env.CONFIRM_BASE || "https://api.crol-list.org", forecasts);
      } else {
        subject = decision.action === "weekly-empty"
          ? `CROL-List: nothing new this week — ${label}`
          : `CROL-List: still watching — ${label}`;
        html = quietHtml(label, decision.action, since, unsubUrl);
      }
      await sendEmail(env, ctx.FROM, s.email, subject, html, `<${unsubUrl}>`, true);
      await ctx.onSent();
      await setLastSent(env, s.key, ctx.today);   // only on a real send, so the heartbeat clock tracks actual email
    }

    if (rows.length && !capped) await markSeen(env, s.key, rows.map((r) => r[q.idField]).filter(Boolean));
    return { sub: maskKey(s.key), lens: s.lens, found: rows.length, new: fresh.length, forecasts: forecasts.length, action: decision.action, sent: send, capped };
  } catch (e) {
    return { sub: maskKey(s.key), error: String(e?.message || e) };
  }
}

// Queue consumer entry: one digest job = one subscription key. Reads the daily send
// count fresh per job (consumer max_concurrency=1 keeps the counter honest).
export async function consumeDigestJob(env, key) {
  const s = await loadSub(env, key);
  if (!s) return { sub: maskKey(key), skipped: "gone" };
  const day = new Date().toISOString().slice(0, 10);
  let daily = await getSendCount(env, day);
  const ctx = {
    FROM: env.ALERTS_FROM || "CROL-List <alerts@crol-list.org>",
    LIVE: env.ALERTS_LIVE === "true",
    heartbeatDays: Number(env.HEARTBEAT_DAYS) || 14,
    today: day,
    isMonday: new Date().getUTCDay() === 1,
    // Per-run pacing is the queue's job now; the DAILY ceiling stays hard.
    counts: () => ({ "per-run": 0, daily }),
    caps: { "per-run": Number(env.MAX_PER_RUN) || 25, daily: Number(env.MAX_SENDS_PER_DAY) || 50 },
    onSent: async () => { daily++; await setSendCount(env, day, daily); },
  };
  const r = await processOneSub(env, s, ctx);
  console.log("digest job:", JSON.stringify(r));
  return r;
}

async function loadSub(env, key) {
  if (!env.SUBS) return null;
  try {
    const v = JSON.parse(await env.SUBS.get(key));
    return v && v.email ? { key, ...v } : null;
  } catch {
    return null;
  }
}

// ---- query a watch against the City Record -------------------------------

// Honest deadline label: due dates in year >= 2090 are rolling placeholders (EDA:
// pre-qualified-list entries), not real deadlines — never render them as dates.
export function dueLabel(dueDate) {
  if (!dueDate) return "";
  const s = String(dueDate);
  const year = Number(s.slice(0, 4));
  if (Number.isFinite(year) && year >= 2090) return "no fixed deadline (rolling)";
  return "due " + s.slice(0, 10);
}

async function runWatch(w) {
  const params = new URLSearchParams();
  params.set("$select", "request_id,start_date,agency_name,short_title,pin,contract_amount,vendor_name,due_date,contact_name,contact_phone,email,street_address_1,section_name");
  params.set("$limit", String(w.limit || 25));
  params.set("$order", "start_date DESC");

  if (w.type === "awards") {
    // Cap excludes data-entry errors (EDA: 3 rows >= $10B, max legit ≈ $6.68B) which
    // would otherwise dominate any amount-sorted digest.
    params.set("$where", `type_of_notice_description='Award' AND contract_amount >= ${Number(w.min) || 1000000} AND contract_amount < 10000000000`);
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
      const sub = [r.agency_name, r.pin ? "PIN " + r.pin : "", money(r.contract_amount), dueLabel(r.due_date)]
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
function subDigestHtml(label, kind, rows, unsubUrl, since, base = "https://api.crol-list.org", forecasts = []) {
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
      dueLabel(r.due_date),
      r.event_date ? "event " + String(r.event_date).slice(0, 10) : ""]
      .filter(Boolean).map(esc).join(" · ");
    return `<li style="margin:0 0 14px"><b>${esc(r.short_title || "Notice")}</b><br>
      <span style="color:#555;font-size:13px">${meta}</span><br>
      <span style="font-size:13px">${acts.join(" &nbsp; ")}</span></li>`;
  };

  let forecastsHtml = "";
  if (forecasts.length > 0) {
    const fItems = forecasts.map(f => {
      if (f.source === "checkbook") {
        return `<li style="margin:0 0 14px"><b>Estimated Renewal: ${esc(f.vendor_name || "Vendor")}</b><br>
          <span style="color:#555;font-size:13px">${esc(f.agency_name)} · Amount ${usd(f.amount)}</span><br>
          <span style="color:#a42;font-size:13px">Predicted Expiration: ${f.expiration_date} · 6-Month Warning: ${f.warning_date}</span></li>`;
      } else {
        return `<li style="margin:0 0 14px"><b>MOCS Plan Notice: ${esc(f.description)}</b><br>
          <span style="color:#555;font-size:13px">${esc(f.agency)} · Value Band ${esc(f.value_band)}</span><br>
          <span style="color:#a42;font-size:13px">Anticipated Release: ${f.release_quarter}</span></li>`;
      }
    }).join("");
    forecastsHtml = `<h3 style="margin-top:20px;border-top:1px solid #ddd;padding-top:15px;font-family:system-ui">Upcoming Procurement Forecasts (Early Warning)</h3>
      <p style="font-size:13px;color:#666;font-style:italic;margin-bottom:12px">These are predicted upcoming contract expirations and planned schedules, not active open solicitations.</p>
      <ul style="list-style:none;padding:0">${fItems}</ul>`;
  }

  const listHtml = rows.length > 0 ? `<ul style="list-style:none;padding:0">${rows.map(item).join("")}</ul>` : `<p style="color:#666;font-style:italic">No new active notices matching your criteria.</p>`;

  return `<div style="font-family:Georgia,serif;max-width:620px">
    <h2 style="font-family:system-ui">CROL-List — ${esc(label)}</h2>
    <p style="color:#555">${rows.length} new ${rows.length === 1 ? "item" : "items"}${since ? ` since ${shortDate(since)}` : ""}.</p>
    ${listHtml}
    ${forecastsHtml}
    <p style="color:#999;font-size:12px;margin-top:20px">You subscribed to this on crol-list.org. <a href="${esc(unsubUrl)}">Unsubscribe</a> (one-click).<br>
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

export async function matchForecasts(env, s, today) {
  const matched = [];
  if (!env.ALERT_STATE) return matched;

  const stems = [];
  if (s.lens === "entity" && s.filter && s.filter.name) {
    stems.push(vendorStem(s.filter.name));
  }
  if (s.lens === "money" && s.filter && s.filter.agency) {
    stems.push(vendorStem(s.filter.agency));
  }

  const LIVE = env.ALERTS_LIVE === "true";

  for (const stem of stems) {
    if (stem.length < 3) continue;

    // Checkbook expirations
    const fcRaw = await env.ALERT_STATE.get(`fc:${stem}`);
    if (fcRaw) {
      const list = JSON.parse(fcRaw);
      for (const fx of list) {
        if (fx.warning_date === today) {
          const forecastId = `fc:${fx.contract_id}:${s.key}`;
          const sent = await env.ALERT_STATE.get(`sent:${forecastId}`);
          if (!sent) {
            matched.push(fx);
            if (LIVE) {
              await env.ALERT_STATE.put(`sent:${forecastId}`, "1");
            }
          }
        }
      }
    }

    // MOCS plans
    const planRaw = await env.ALERT_STATE.get(`plan:${stem}`);
    if (planRaw) {
      const list = JSON.parse(planRaw);
      for (const px of list) {
        const descId = String(px.description).replace(/\s+/g, "_").slice(0, 50);
        const forecastId = `plan:${stem}:${descId}:${s.key}`;
        const sent = await env.ALERT_STATE.get(`sent:${forecastId}`);
        if (!sent) {
          matched.push(px);
          if (LIVE) {
            await env.ALERT_STATE.put(`sent:${forecastId}`, "1");
          }
        }
      }
    }
  }

  return matched;
}
