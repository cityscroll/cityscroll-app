// GET|POST /prefs — preference center for an email account's watches.
//
// Auth: signed purpose token { sc: "prefs", e: email } (issued from digest footers
// and the manage link). No passwords. List / edit freq / keywords / pause / delete
// one watch, or unsubscribe all. Changes write to SUBS immediately; digests read
// SUBS on the next daily cron (~9am Eastern) — CUTOVER_COPY on every surface.
//
// GET  /prefs?token=…           HTML list + forms
// POST /prefs (form or JSON)    action=update|pause|unpause|delete|unsub_all

import { signToken, verifyToken } from "optin-token";
import { htmlPage } from "./lib/confirm_email.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import { overActorLimit } from "./lib/meter.mjs";
import { normalizeEmail, redactEmail } from "./lib/subscriptions.mjs";
import { appendWatchLog, updateDetail, watchLabel, watchSnapshot } from "./lib/watchlog.mjs";
import { emailFromRequest } from "./session.mjs";
import {
  PREFS_SCOPE,
  PREFS_TOKEN_TTL_SECONDS,
  PREFS_MAX_WATCHES,
  CUTOVER_COPY,
  prefsPayload,
  isPrefsPayload,
  toPrefsWatchRow,
  applyWatchPatch,
  parsePrefsAction,
} from "./lib/prefs.mjs";

const MAX_PREFS_ATTEMPTS_PER_IP_DAY = 60;

/** Issue a long-lived preference-center URL for digests / admin. */
export async function prefsLink(env, email) {
  if (!env.TOKEN_SECRET) return null;
  const base = env.CONFIRM_BASE || "https://api.cityscroll.org";
  const token = await signToken(env.TOKEN_SECRET, prefsPayload(email), {
    ttlSeconds: PREFS_TOKEN_TTL_SECONDS,
  });
  return `${base}/prefs?token=${encodeURIComponent(token)}`;
}

async function issuePrefsCredential(env, email) {
  return signToken(env.TOKEN_SECRET, prefsPayload(email), {
    ttlSeconds: PREFS_TOKEN_TTL_SECONDS,
  });
}

export async function handlePrefs(req, env) {
  if (!env.TOKEN_SECRET || !env.SUBS) {
    return page("Unavailable", "This link isn't available right now.", 503);
  }

  const url = new URL(req.url);
  const ip = req.headers.get("CF-Connecting-IP") || "";
  if (ip && await overActorLimit(env.SUBS, "prefs", ip, MAX_PREFS_ATTEMPTS_PER_IP_DAY)) {
    return page("Try again later", "Too many requests from this network. Please try again tomorrow.", 429);
  }

  if (req.method === "GET") {
    let credential = url.searchParams.get("token") || "";
    let email = await emailFromPrefsToken(env, credential);
    // A recognized email-link session may enter the preference center without a
    // second magic link. Mint the existing narrower prefs token into the forms;
    // POST authorization below remains prefs-token-only.
    if (!credential && !email) {
      email = normalizeEmail(await emailFromRequest(req, env));
      if (email) credential = await issuePrefsCredential(env, email);
    }
    if (!email) {
      return page("Link not valid", "This manage link is invalid or has expired. Use the link in a recent CityScroll email.", 400);
    }
    const watches = await listWatchesForEmail(env, email);
    return prefsHtmlResponse(email, watches, credential, null);
  }

  if (req.method === "POST") {
    let body = {};
    const ct = req.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) {
        body = await req.json();
      } else if (ct.includes("application/x-www-form-urlencoded")) {
        // formData() is fine; also support raw urlencoded for test clients without FormData edge cases.
        const text = await req.text();
        body = Object.fromEntries(new URLSearchParams(text).entries());
      } else {
        try {
          const form = await req.formData();
          body = Object.fromEntries(form.entries());
        } catch {
          body = {};
        }
      }
    } catch {
      body = {};
    }
    // Token may be in query string (link + form post) or form/JSON body.
    const postToken = body.token || url.searchParams.get("token") || "";
    const email = await emailFromPrefsToken(env, postToken);
    if (!email) {
      return page("Link not valid", "This manage link is invalid or has expired.", 400);
    }

    const { action, key, patch } = parsePrefsAction(body);
    const flash = await applyPrefsAction(env, email, action, key, patch);
    const watches = await listWatchesForEmail(env, email);
    const wantsJson = (req.headers.get("accept") || "").includes("application/json")
      || ct.includes("application/json");
    if (wantsJson) {
      return json({
        ok: !flash?.error,
        email: redactEmail(email),
        flash,
        cutover: CUTOVER_COPY,
        watches,
      }, flash?.error ? 400 : 200);
    }
    return prefsHtmlResponse(email, watches, postToken, flash);
  }

  return page("Method not allowed", "Use GET or POST.", 405);
}

async function emailFromPrefsToken(env, token) {
  if (!token) return null;
  const res = await verifyToken(env.TOKEN_SECRET, token);
  if (!res.valid || !isPrefsPayload(res.payload)) return null;
  return normalizeEmail(res.payload.e);
}

async function listWatchesForEmail(env, email) {
  const want = normalizeEmail(email);
  const out = [];
  let cursor;
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      for (const k of res.keys) {
        if (out.length >= PREFS_MAX_WATCHES) break;
        try {
          const v = JSON.parse(await env.SUBS.get(k.name));
          if (v && normalizeEmail(v.email) === want) {
            const row = toPrefsWatchRow(v, k.name);
            if (row) out.push(row);
          }
        } catch { /* skip */ }
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor && out.length < PREFS_MAX_WATCHES);
  } catch {
    return out;
  }
  out.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  return out;
}

async function applyPrefsAction(env, email, action, key, patch) {
  const want = normalizeEmail(email);

  if (action === "list" || action === "") {
    return { message: "Your watches." };
  }

  if (action === "unsub_all") {
    const deleted = await deleteAllForEmail(env, want);
    return {
      message: deleted
        ? `Removed ${deleted} watch${deleted === 1 ? "" : "es"}. You will get no further digests for this address after the next daily run.`
        : "No watches found for this address.",
    };
  }

  if (!key) return { error: "Missing watch key." };

  // Ownership: load and verify email match before any mutation.
  let raw;
  try { raw = await env.SUBS.get(key); } catch { raw = null; }
  if (!raw) {
    if (action === "delete") return { message: "That watch was already removed." };
    return { error: "Watch not found." };
  }
  let record;
  try { record = JSON.parse(raw); } catch { return { error: "Watch record is unreadable." }; }
  if (normalizeEmail(record.email) !== want) {
    return { error: "That watch does not belong to this address." };
  }

  if (action === "delete") {
    const label = watchLabel(record) || record.label;
    try { await env.SUBS.delete(key); } catch { /* idempotent */ }
    await appendWatchLog(env, {
      action, email: record.email, subKey: key, lens: record.lens,
      label, freq: record.freq, source: "prefs",
    });
    return { message: "Watch removed. Takes effect next daily run (~9am Eastern)." };
  }

  if (action === "pause") {
    const applied = applyWatchPatch(record, { paused: true });
    if (!applied.ok) return { error: applied.reason };
    await env.SUBS.put(key, JSON.stringify(applied.record));
    await appendWatchLog(env, {
      action, email: record.email, subKey: key, lens: record.lens,
      label: watchLabel(record) || record.label, freq: record.freq, source: "prefs",
    });
    return { message: "Watch paused. No matches from it until you unpause (next daily run)." };
  }

  if (action === "unpause") {
    const applied = applyWatchPatch(record, { paused: false });
    if (!applied.ok) return { error: applied.reason };
    await env.SUBS.put(key, JSON.stringify(applied.record));
    await appendWatchLog(env, {
      action, email: record.email, subKey: key, lens: record.lens,
      label: watchLabel(record) || record.label, freq: record.freq, source: "prefs",
    });
    return { message: "Watch active again. Takes effect next daily run (~9am Eastern)." };
  }

  if (action === "update") {
    const applied = applyWatchPatch(record, patch);
    if (!applied.ok) return { error: applied.reason || "Invalid update." };
    const before = watchSnapshot(record);
    const after = watchSnapshot(applied.record);
    await env.SUBS.put(key, JSON.stringify(applied.record));
    await appendWatchLog(env, {
      action, email: record.email, subKey: key, lens: applied.record.lens,
      label: watchLabel(applied.record) || applied.record.label,
      freq: applied.record.freq,
      detail: updateDetail(record, applied.record),
      before,
      after,
      source: "prefs",
    });
    return {
      message: `Updated: ${describeFilter(applied.record.lens, applied.record.filter)} · ${applied.record.freq}. ${CUTOVER_COPY}`,
    };
  }

  return { error: `Unknown action: ${action}` };
}

async function deleteAllForEmail(env, email) {
  const want = normalizeEmail(email);
  let deleted = 0;
  let cursor;
  const keys = [];
  try {
    do {
      const res = await env.SUBS.list({ prefix: "sub:", cursor });
      for (const k of res.keys) {
        try {
          const v = JSON.parse(await env.SUBS.get(k.name));
          if (v && normalizeEmail(v.email) === want) keys.push(k.name);
        } catch { /* skip */ }
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
    for (const k of keys) {
      try {
        const raw = await env.SUBS.get(k);
        const record = raw ? JSON.parse(raw) : null;
        const label = watchLabel(record) || record?.label;
        await env.SUBS.delete(k);
        deleted++;
        await appendWatchLog(env, {
          action: "unsub_all", email: record?.email || want, subKey: k,
          lens: record?.lens, label, freq: record?.freq, source: "prefs",
        });
      } catch { /* continue */ }
    }
  } catch { /* partial */ }
  return deleted;
}

function prefsHtmlResponse(email, watches, token, flash) {
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const flashHtml = flash
    ? `<p style="padding:10px 12px;border-radius:8px;background:${flash.error ? "#fde8e8" : "#e8f5e9"};color:#1a1714">${esc(flash.error || flash.message)}</p>`
    : "";
  const rows = (watches || []).map((w) => {
    const kw = Array.isArray(w.filter?.keywords) ? w.filter.keywords.join(", ") : "";
    const status = w.paused
      ? `<span style="color:#a42;font-weight:bold">paused</span>`
      : `<span style="color:#2a6">active</span>`;
    return `<div style="border:1px solid #cdbfa6;border-radius:10px;padding:14px 16px;margin:0 0 14px;background:#fffef9;text-align:left">
      <div style="font-family:system-ui;font-size:13px;color:#5c5349;margin-bottom:4px">${esc(w.lens || "?")} · ${status} · ${esc(w.freq)}</div>
      <div style="font-weight:bold;margin-bottom:10px">${esc(w.query)}</div>
      <form method="POST" action="" style="margin:0 0 8px">
        <input type="hidden" name="token" value="${esc(token)}" />
        <input type="hidden" name="key" value="${esc(w.key)}" />
        <input type="hidden" name="action" value="update" />
        <label style="display:block;font-size:13px;color:#5c5349;margin-bottom:4px">Keywords (comma-separated)</label>
        <input name="keywords" value="${esc(kw)}" style="width:100%;box-sizing:border-box;padding:8px;margin-bottom:8px;border:1px solid #cdbfa6;border-radius:6px;font:15px system-ui" />
        <label style="display:block;font-size:13px;color:#5c5349;margin-bottom:4px">Frequency</label>
        <select name="freq" style="padding:8px;margin-bottom:10px;border:1px solid #cdbfa6;border-radius:6px;font:15px system-ui">
          <option value="daily"${w.freq === "daily" ? " selected" : ""}>daily</option>
          <option value="weekly"${w.freq === "weekly" ? " selected" : ""}>weekly</option>
        </select>
        <div>
          <button type="submit" style="font:600 14px system-ui;background:#7a1f1f;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer">Save</button>
        </div>
      </form>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
        <form method="POST" action="" style="margin:0">
          <input type="hidden" name="token" value="${esc(token)}" />
          <input type="hidden" name="key" value="${esc(w.key)}" />
          <input type="hidden" name="action" value="${w.paused ? "unpause" : "pause"}" />
          <button type="submit" style="font:600 13px system-ui;background:#f4efe4;border:1px solid #cdbfa6;border-radius:6px;padding:6px 12px;cursor:pointer">${w.paused ? "Unpause" : "Pause"}</button>
        </form>
        <form method="POST" action="" style="margin:0" onsubmit="return confirm('Remove this watch?');">
          <input type="hidden" name="token" value="${esc(token)}" />
          <input type="hidden" name="key" value="${esc(w.key)}" />
          <input type="hidden" name="action" value="delete" />
          <button type="submit" style="font:600 13px system-ui;background:#f4efe4;border:1px solid #cdbfa6;border-radius:6px;padding:6px 12px;cursor:pointer;color:#7a1f1f">Delete watch</button>
        </form>
      </div>
    </div>`;
  }).join("");

  const empty = !(watches && watches.length)
    ? `<p style="color:#5c5349">No active watches for this address. Subscribe again on <a href="https://cityscroll.org">cityscroll.org</a>.</p>`
    : "";

  const body = `
    ${flashHtml}
    <p style="color:#5c5349;font-size:14px;text-align:left">${esc(CUTOVER_COPY)}</p>
    <p style="color:#5c5349;font-size:13px;text-align:left">Account: <b>${esc(redactEmail(email))}</b> · ${watches.length} watch${watches.length === 1 ? "" : "es"}</p>
    ${empty}
    ${rows}
    ${watches.length ? `
    <form method="POST" action="" style="margin-top:20px;padding-top:16px;border-top:1px solid #cdbfa6" onsubmit="return confirm('Unsubscribe ALL watches for this address?');">
      <input type="hidden" name="token" value="${esc(token)}" />
      <input type="hidden" name="action" value="unsub_all" />
      <button type="submit" style="font:600 14px system-ui;background:transparent;border:1px solid #7a1f1f;color:#7a1f1f;border-radius:6px;padding:8px 14px;cursor:pointer">Unsubscribe all watches</button>
    </form>` : ""}
  `;

  return new Response(htmlPage("Manage your watches", body), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function page(title, message, status) {
  return new Response(htmlPage(title, message), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Re-export for tests / digest footers.
export { PREFS_SCOPE, CUTOVER_COPY, prefsPayload, isPrefsPayload };
