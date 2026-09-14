// One reviewed action for a curated pack. Each child remains an ordinary subscription;
// the pack receipt only records the immutable child payload and retryable progress.

import { LENSES, prepareWatchFilter, resolveLens } from "./lib/filter.mjs";
import { buildSubscription, isValidEmail, subscriptionKey } from "./lib/subscriptions.mjs";
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";

const MAX_CHILDREN = 20;

export async function handleMonitorPackSubscribe(req, env) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin, env);
  if (!isAllowedRequestOrigin(origin, env)) return json({ ok: false, reason: "origin" }, 403, cors);
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405, cors);
  if (!env.TOKEN_SECRET || !env.RESEND_API_KEY || !env.SUBS) return json({ ok: false, reason: "not-configured" }, 503, cors);

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json({ ok: false, reason: "bad-request" }, 400, cors);
  }
  const email = String(body?.email || "");
  const packId = String(body?.pack_id || "").trim();
  const children = Array.isArray(body?.children) ? body.children : [];
  if (!isValidEmail(email) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(packId) || !children.length || children.length > MAX_CHILDREN) {
    return json({ ok: false, reason: "invalid-pack" }, 400, cors);
  }

  const validated = [];
  for (const child of children) {
    const lens = String(child?.lens || "").trim();
    const rawFilter = child?.filter && typeof child.filter === "object" && !Array.isArray(child.filter) ? child.filter : null;
    const prepared = prepareWatchFilter(lens, rawFilter || {});
    const allowed = new Set([...(LENSES[resolveLens(lens)] || []), "text_query", "subject_refs_all", "entity_refs_all"]);
    const droppedKey = !rawFilter || Object.keys(rawFilter).some((key) => !allowed.has(key));
    const identityFieldsValid = validatePackIdentityFields(rawFilter);
    if (!prepared.ok || !lens || !String(child?.label || "").trim() || droppedKey || !identityFieldsValid) {
      return json({ ok: false, reason: "invalid-child" }, 400, cors);
    }
    const filter = { ...prepared.filter };
    for (const key of ["subject_refs_all", "entity_refs_all"]) {
      if (Object.prototype.hasOwnProperty.call(rawFilter, key)) filter[key] = [...rawFilter[key]];
    }
    validated.push({ label: String(child.label).trim().slice(0, 160), lens: prepared.lens, filter });
  }
  const duplicate = new Set(validated.map((child) => JSON.stringify({ lens: child.lens, filter: child.filter })));
  if (duplicate.size !== validated.length) return json({ ok: false, reason: "duplicate-child" }, 400, cors);

  const receiptKey = await packReceiptKey({ email, packId, children: validated });
  let receipt = await readReceipt(env.SUBS, receiptKey);
  if (!receipt) {
    receipt = {
      schema: "cityscroll.monitor_pack_subscription_receipt.v1",
      pack_id: packId,
      email,
      children: validated.map((child, index) => ({
        index,
        label: child.label,
        lens: child.lens,
        filter: child.filter,
        status: "pending",
        key: null,
        error: null,
      })),
    };
    await env.SUBS.put(receiptKey, JSON.stringify(receipt));
  } else if (JSON.stringify(receipt.children.map(stripProgress)) !== JSON.stringify(validated.map((child) => ({ label: child.label, lens: child.lens, filter: child.filter })))) {
    return json({ ok: false, reason: "receipt-mismatch" }, 409, cors);
  }

  let createdThisRequest = 0;
  const enroll = env.enrollAndWelcome || (await import("./subscribe.mjs")).enrollAndWelcome;
  for (const child of receipt.children) {
    if (child.status === "created" || child.status === "duplicate") continue;
    const spec = { email, lens: child.lens, filter: child.filter, freq: body.freq === "daily" ? "daily" : "weekly", lang: typeof body.lang === "string" ? body.lang : "en" };
    const key = await subscriptionKey(spec);
    child.key = key;
    try {
      const existing = await env.SUBS.get(key);
      if (existing) {
        child.status = "duplicate";
      } else {
        await enroll(env, buildSubscription(spec), { source: `pack:${packId}` });
        child.status = "created";
        createdThisRequest += 1;
      }
      child.error = null;
    } catch (error) {
      // A welcome-send failure happens after the child write. Treat that child as created so
      // a retry cannot duplicate it; an actual save failure remains missing and is retryable.
      child.status = await env.SUBS.get(key) ? "created" : "failed";
      child.error = child.status === "failed" ? String(error?.code || error?.message || "child-failed") : null;
      await env.SUBS.put(receiptKey, JSON.stringify(receipt));
      return json({ ok: false, reason: "partial-failure", receipt: publicReceipt(receipt), missing_children: missing(receipt) }, 502, cors);
    }
    await env.SUBS.put(receiptKey, JSON.stringify(receipt));
  }
  return json({ ok: true, receipt: publicReceipt(receipt), created: createdThisRequest, missing_children: missing(receipt) }, 200, cors);
}

async function readBody(req) {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return req.json();
  const form = Object.fromEntries(new URLSearchParams(await req.text()).entries());
  if (typeof form.children === "string") form.children = JSON.parse(form.children);
  return form;
}

async function packReceiptKey(input) {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `monitor-pack:${[...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function readReceipt(store, key) {
  const raw = await store.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function stripProgress(child) {
  return { label: child.label, lens: child.lens, filter: child.filter };
}

function missing(receipt) {
  return receipt.children.filter((child) => child.status === "pending" || child.status === "failed").map((child) => child.index);
}

function publicReceipt(receipt) {
  return { ...receipt, children: receipt.children.map(({ key, ...child }) => child) };
}

function validatePackIdentityFields(filter) {
  if (!filter || typeof filter !== "object") return false;
  for (const key of ["subject_refs_all", "entity_refs_all"]) {
    if (!Object.prototype.hasOwnProperty.call(filter, key)) continue;
    if (!Array.isArray(filter[key]) || !filter[key].length || filter[key].length > 20) return false;
    if (filter[key].some((value) => typeof value !== "string" || /\s/.test(value) || !/^[A-Za-z0-9:_-]{3,120}$/.test(value))) return false;
  }
  return true;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
