// GET /translate/<request_id>?lang=xx — informal notice translation (original-first).
//
// Precompute-first / edge-cache posture:
//   - D1 notice_translations is the durable cache, keyed by (request_id, lang) + source_hash
//   - caches.default edge-caches successful responses
//   - LLM runs only on a true miss (no per-pageview upstream calls once produced)
//   - Daily surface meter fails closed (no new translations over cap; cache hits still serve)
//   - Invariant mismatch is never cached; the client shows only the English original
//
// The English original always remains the official record on the client. This endpoint only
// supplies an optional unofficial aid.

import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { overSurfaceCap } from "./lib/meter.mjs";
import {
  isTranslateLang,
  sourceHash,
  translateAndVerify,
  TRANSLATE_LANGS,
} from "./lib/translate_notice.mjs";
import { noticeSourceText } from "./lib/translate_invariants.mjs";

const DEFAULT_MAX_PER_DAY = 150;
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const SELECT =
  "request_id,start_date,agency_name,type_of_notice_description,category_description,"
  + "short_title,pin,contract_amount,vendor_name,due_date,address_to_request,"
  + "additional_description_1,other_info_1";

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function sq(s) {
  return String(s || "").replace(/'/g, "''");
}

async function fetchNoticeRow(env, requestId) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT request_id, start_date, agency AS agency_name, type_of_notice AS type_of_notice_description,
                short_title, pin, contract_amount, vendor_name, due_date,
                description AS additional_description_1, other_info AS other_info_1
           FROM notices WHERE request_id = ?`,
      ).bind(requestId).first();
      if (row) return row;
    } catch { /* fall through to SODA */ }
  }
  try {
    const r = await fetch(
      `${SODA}?${new URLSearchParams({
        $select: SELECT,
        $where: `request_id='${sq(requestId)}'`,
        $limit: "1",
      }).toString()}`,
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

async function cacheGet(env, requestId, lang, expectedHash) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT source_hash, payload, computed_at FROM notice_translations WHERE request_id = ? AND lang = ?",
    ).bind(requestId, lang).first();
    if (!row || !row.payload) return null;
    if (expectedHash && row.source_hash !== expectedHash) return null; // source changed → miss
    const payload = JSON.parse(row.payload);
    if (!payload || payload.ok !== true) return null;
    return { ...payload, source_hash: row.source_hash, computed_at: row.computed_at, cached: true };
  } catch {
    return null;
  }
}

async function cachePut(env, requestId, lang, payload) {
  if (!env.DB || !payload || payload.ok !== true) return;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO notice_translations (request_id, lang, source_hash, payload, computed_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      requestId,
      lang,
      payload.source_hash,
      JSON.stringify({
        ok: true,
        title: payload.title,
        description: payload.description,
        model: payload.model,
        lang: payload.lang,
        request_id: payload.request_id,
      }),
      new Date().toISOString(),
    ).run();
  } catch { /* cache write must never break the read path */ }
}

/**
 * Read D1; on miss, meter + translate + verify + store. Cache hits never spend the meter
 * and never call the model (precompute-first / no per-pageview upstream).
 */
export async function getOrTranslate(env, requestId, lang) {
  const row = await fetchNoticeRow(env, requestId);
  if (!row) return { ok: false, reason: "not-found" };

  const hash = await sourceHash(noticeSourceText(row));
  const cached = await cacheGet(env, requestId, lang, hash);
  if (cached) return cached;

  // Only brand-new translations count against the daily ceiling. Fail closed.
  const max = Number(env.TRANSLATE_MAX_CALLS_PER_DAY) || DEFAULT_MAX_PER_DAY;
  if (await overSurfaceCap(env.NL_METER, "translate", max)) {
    return { ok: false, reason: "daily-cap" };
  }

  const result = await translateAndVerify(env, lang, row);
  if (!result.ok) return result;

  await cachePut(env, requestId, lang, result);
  return { ...result, cached: false };
}

export async function handleTranslate(req, env, pathname, ctx) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, {
    methods: "GET, OPTIONS",
    headers: "Content-Type",
  });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  // Origin check: browser calls only. Missing Origin (curl / edge revalidation) is allowed.
  if (origin && !isAllowedRequestOrigin(origin, env)) {
    return json({ ok: false, reason: "origin" }, 403, cors);
  }

  let rawId;
  try {
    rawId = decodeURIComponent(pathname.slice("/translate/".length).split("?")[0]);
  } catch {
    return json({ ok: false, reason: "bad-id" }, 400, cors);
  }
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(rawId)) {
    return json({ ok: false, reason: "bad-id" }, 400, cors);
  }

  const url = new URL(req.url);
  const lang = String(url.searchParams.get("lang") || "").trim();
  if (!isTranslateLang(lang)) {
    return json({
      ok: false,
      reason: "bad-lang",
      langs: TRANSLATE_LANGS,
    }, 400, cors);
  }

  // Edge cache only successful translations. Key includes lang via the full request URL.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(req).catch(() => null);
    if (hit) {
      // Re-apply CORS for the requesting origin (edge entry may have been stored with another).
      const headers = new Headers(hit.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  const result = await getOrTranslate(env, rawId, lang);
  const ok = result.ok === true;
  const body = ok
    ? {
        ok: true,
        id: rawId,
        lang,
        title: result.title,
        description: result.description,
        model: result.model || null,
        cached: !!result.cached,
        // Minimal label key for clients — do not invent longer disclaimer copy.
        label: "unofficial_translation",
      }
    : {
        ok: false,
        id: rawId,
        lang,
        reason: result.reason || "error",
        missing: result.missing || undefined,
      };

  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      // Cache hits are free forever at the edge for an hour; misses that failed must not stick.
      "Cache-Control": ok ? "public, max-age=3600" : "no-store",
    },
  });

  if (cache && ok && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(cache.put(req, res.clone()).catch(() => {}));
  } else if (cache && ok) {
    try { await cache.put(req, res.clone()); } catch { /* ignore */ }
  }
  return res;
}

export { TRANSLATE_LANGS, isTranslateLang };
