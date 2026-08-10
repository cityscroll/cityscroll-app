#!/usr/bin/env node

// Stage the first carry-forward payload from the authenticated Aug 10 shadow.
// This runner is intentionally limited to read-only evidence routes and the
// no-send backfill endpoint. It has no provider, queue, or drain dependency.

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  DELIVERED_LAND_ITEM_ID,
  FIRST_PAYLOAD_ID,
  FIRST_PAYLOAD_MANIFEST,
} from "../src/digest_backfill.mjs";
import { deriveSubscriberId } from "../src/lib/subscriptions.mjs";

export const DEFAULT_BASE_URL = "https://api.cityscroll.org";
export const SHADOW_DAY = "2026-08-10";
export const OWNER_REDACTED = "ja***@gmail.com";
export const ADMIN_KEY_PATH = "/Users/openclaw/.config/estate/cityscroll-admin-key";
export const RECOVERY_PATHS = Object.freeze(new Set([
  "/admin/digest-shadow",
  "/admin/stats",
  "/admin/digest-backfill",
  "/admin/owed-backlog",
]));

export class CarryForwardRunnerError extends Error {
  constructor(message) {
    super(message);
    this.name = "CarryForwardRunnerError";
  }
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function validIso(value, label) {
  const clean = text(value);
  if (!clean || Number.isNaN(Date.parse(clean))) throw new CarryForwardRunnerError(`${label} must be an ISO timestamp`);
  return clean;
}

function htmlDecode(value) {
  return text(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripTags(value) {
  return htmlDecode(text(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function decodeOwnerEmail(html) {
  const match = text(html).match(/[?&]s=([^&"'\s]+)/i);
  if (!match) throw new CarryForwardRunnerError("shadow preview has no signed owner link");
  let token;
  try {
    token = decodeURIComponent(match[1]);
    const encoded = token.split(".")[0].replaceAll("-", "+").replaceAll("_", "/");
    token = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(token);
    const email = text(parsed.e).toLowerCase();
    if (!email || !email.includes("@")) throw new Error("missing email");
    return email;
  } catch {
    throw new CarryForwardRunnerError("shadow owner link is not decodable");
  }
}

function previewItems(html) {
  return [...text(html).matchAll(/<li[^>]*data-digest-item=["']1["'][^>]*>[\s\S]*?<\/li>/gi)]
    .map((match) => match[0]);
}

function itemRequestId(fragment, lens) {
  const hrefs = [...fragment.matchAll(/href=["']([^"']+)["']/gi)].map((match) => htmlDecode(match[1]));
  const expected = new RegExp(`/r/${lens}/([^/?#]+)`, "i");
  const href = hrefs.find((value) => expected.test(value));
  if (!href) throw new CarryForwardRunnerError(`shadow ${lens} item has no request id`);
  return href.match(expected)[1];
}

function firstAnchorText(fragment) {
  const match = fragment.match(/<b>\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/b>/i);
  return stripTags(match?.[1] || "");
}

function firstAgencyText(fragment) {
  const match = fragment.match(/<span[^>]*style=["'][^"']*color:#555[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  return stripTags(match?.[1] || "");
}

function eventDate(fragment) {
  return fragment.match(/Event:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || null;
}

function ruleActionKey(fragment, requestId) {
  const visible = stripTags(fragment);
  const match = visible.match(/Comments open through\s+([A-Z][a-z]+\s+\d{1,2})/i);
  if (match) {
    const deadline = new Date(`${match[1]} ${SHADOW_DAY.slice(0, 4)} UTC`);
    if (!Number.isNaN(deadline.getTime())) return `temporal:rules:${requestId}:comment-open:${deadline.toISOString().slice(0, 10)}`;
  }
  // The shadow renderer does not expose the source's hidden temporal-action
  // object for ordinary Agency Rules rows. Keep a stable, source-scoped
  // identity for those rows rather than inventing a publication or event date.
  return `shadow:rules:${requestId}`;
}

function sourceSnapshot(fragment, lens, requestId) {
  const row = {
    request_id: requestId,
    short_title: firstAnchorText(fragment),
    agency_name: firstAgencyText(fragment),
    section_name: lens === "rules" ? "Agency Rules" : "Public Hearings and Meetings",
    backfill_shadow_day: SHADOW_DAY,
  };
  if (lens === "rules") row.action_key = ruleActionKey(fragment, requestId);
  if (lens === "meetings") row.event_date = eventDate(fragment);
  if (!row.short_title || !row.agency_name) throw new CarryForwardRunnerError(`${lens} ${requestId} shadow render is incomplete`);
  return {
    request_id: requestId,
    source_date: SHADOW_DAY,
    render_snapshot: row,
  };
}

function exactManifest(entries, lens) {
  const expected = FIRST_PAYLOAD_MANIFEST[lens];
  const actual = entries.map((entry) => text(entry.request_id));
  if (actual.length !== expected.length || new Set(actual).size !== expected.length || actual.some((id) => !expected.includes(id))) {
    throw new CarryForwardRunnerError(`${lens} shadow items do not match the exact first-payload manifest`);
  }
  return entries;
}

export function extractOwnerSnapshots(preview) {
  if (!preview || typeof preview !== "object") throw new CarryForwardRunnerError("owner shadow preview is missing");
  const counts = Array.isArray(preview.watch_counts) ? preview.watch_counts : [];
  const rulesCount = Number(counts.find((watch) => watch.lens === "rules")?.item_count);
  const landCount = Number(counts.find((watch) => watch.lens === "land")?.item_count);
  const meetingsCount = Number(counts.find((watch) => watch.lens === "meetings")?.item_count);
  if (rulesCount !== 25 || landCount !== 1 || meetingsCount !== 20) {
    throw new CarryForwardRunnerError("owner shadow watch counts are not 25 rules + 1 land + 20 meetings");
  }
  const items = previewItems(preview.html);
  if (items.length !== 46) throw new CarryForwardRunnerError("owner shadow render does not contain exactly 46 items");
  const rules = items.slice(0, rulesCount).map((fragment) => {
    const id = itemRequestId(fragment, "rules");
    return sourceSnapshot(fragment, "rules", id);
  });
  const meetings = items.slice(rulesCount + landCount, rulesCount + landCount + meetingsCount).map((fragment) => {
    const id = itemRequestId(fragment, "meetings");
    return sourceSnapshot(fragment, "meetings", id);
  });
  return {
    owner_email: decodeOwnerEmail(preview.html),
    source_snapshots: {
      rules: exactManifest(rules, "rules"),
      meetings: exactManifest(meetings, "meetings"),
    },
    shadow_item_count: items.length,
    land_shadow_item_count: landCount,
  };
}

function findOwnerPreview(summary) {
  const preview = (summary?.previews || []).find((candidate) => candidate.recipient_redacted === OWNER_REDACTED);
  if (!preview?.digest_id) throw new CarryForwardRunnerError("owner preview is absent from the Aug 10 shadow");
  return preview;
}

function recoveryEvidence(stats) {
  const run = stats?.digests?.catch_up_last_run;
  const result = (run?.results || []).find((candidate) =>
    candidate?.emailRedacted === OWNER_REDACTED
    && candidate?.sent === true
    && Array.isArray(candidate.noticeIds)
    && candidate.noticeIds.includes("2020Q0317"));
  const acceptedAt = validIso(run?.ranAt, "catch-up accepted timestamp");
  const landSection = (result?.sections || []).find((section) => section?.lens === "land");
  if (run?.status !== "sent" || !result || landSection?.new !== 1 || landSection?.error) {
    throw new CarryForwardRunnerError("ULURP delivery evidence is not reconciled in authenticated stats");
  }
  return {
    reconciled: true,
    item_id: DELIVERED_LAND_ITEM_ID,
    provider_accepted_at: acceptedAt,
    evidence_ref: "admin-stats:/admin/stats#digests.catch_up_last_run",
  };
}

export function assembleBackfillRequest({ shadow, preview, stats, firstOwedAt } = {}) {
  const extracted = extractOwnerSnapshots(preview);
  const evidence = recoveryEvidence(stats);
  const owedAt = validIso(firstOwedAt || stats?.digests?.catch_up_last_run?.ranAt, "first_owed_at");
  return {
    payload_id: FIRST_PAYLOAD_ID,
    owner_email: extracted.owner_email,
    source_snapshots: extracted.source_snapshots,
    delivery_evidence: evidence,
    first_owed_at: owedAt,
    _evidence: {
      shadow_day: shadow?.run_day || SHADOW_DAY,
      shadow_digest_id: preview.digest_id,
      shadow_item_count: extracted.shadow_item_count,
      shadow_land_item_count: extracted.land_shadow_item_count,
    },
  };
}

function requestBody(body) {
  const copy = { ...body };
  delete copy._evidence;
  return copy;
}

export function assertRecoveryPath(url) {
  const path = new URL(url).pathname;
  if (!RECOVERY_PATHS.has(path)) throw new CarryForwardRunnerError(`refusing non-recovery endpoint: ${path}`);
}

async function getKey(path = ADMIN_KEY_PATH) {
  const key = text(await readFile(path, "utf8"));
  if (!key) throw new CarryForwardRunnerError("admin key file is empty");
  return key;
}

async function fetchJson(fetchImpl, url, key, init = {}) {
  assertRecoveryPath(url);
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${key}` },
  });
  let body;
  try { body = await response.json(); } catch { throw new CarryForwardRunnerError(`invalid JSON from ${new URL(url).pathname}`); }
  if (!response.ok && !(new URL(url).pathname === "/admin/digest-shadow" && response.status === 503)) {
    throw new CarryForwardRunnerError(`${new URL(url).pathname} failed with HTTP ${response.status}`);
  }
  return body;
}

export async function buildProductionRequest({ fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL, keyPath = ADMIN_KEY_PATH } = {}) {
  const key = await getKey(keyPath);
  const shadowResponse = await fetchJson(fetchImpl, `${baseUrl}/admin/digest-shadow?day=${SHADOW_DAY}`, key);
  const summary = shadowResponse.summary || shadowResponse;
  const owner = findOwnerPreview(summary);
  const previewResponse = await fetchJson(fetchImpl, `${baseUrl}/admin/digest-shadow?day=${SHADOW_DAY}&digest=${encodeURIComponent(owner.digest_id)}`, key);
  const stats = await fetchJson(fetchImpl, `${baseUrl}/admin/stats`, key);
  return assembleBackfillRequest({ shadow: summary, preview: previewResponse.preview, stats });
}

export async function stageProduction({ fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL, keyPath = ADMIN_KEY_PATH } = {}) {
  const key = await getKey(keyPath);
  const body = await buildProductionRequest({ fetchImpl, baseUrl, keyPath });
  const response = await fetchJson(fetchImpl, `${baseUrl}/admin/digest-backfill`, key, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody(body)),
  });
  return { response, evidence: body._evidence, request: body };
}

export async function verifyProduction({ fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL, keyPath = ADMIN_KEY_PATH } = {}) {
  const key = await getKey(keyPath);
  const request = await buildProductionRequest({ fetchImpl, baseUrl, keyPath });
  const ownerSubscriberId = await deriveSubscriberId(request.owner_email);
  const body = await fetchJson(fetchImpl, `${baseUrl}/admin/owed-backlog`, key);
  const owner = (body.subscribers || []).find((row) => row.subscriber_id === ownerSubscriberId);
  if (body.summary?.owed_count !== 45 || body.summary?.subscriber_count !== 1 || !owner || owner.owed_count !== 45 || owner.overdue !== false) {
    throw new CarryForwardRunnerError("owed-backlog is not exactly 45 for the owner or is already overdue");
  }
  return { ...body, owner_verification: { subscriber_id: ownerSubscriberId, subscriber_label: owner.subscriber_label } };
}

function usage() {
  return "Usage: node worker/scripts/carry_forward_backfill.mjs [stage|verify]";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] || "stage";
  try {
    if (!["stage", "verify"].includes(command)) throw new CarryForwardRunnerError(usage());
    const result = command === "stage" ? await stageProduction() : await verifyProduction();
    console.log(JSON.stringify(command === "stage" ? {
      payload_id: result.response.payload_id,
      staged: result.response.enqueued,
      duplicates: result.response.duplicates,
      backlog: result.response.backlog,
      shadow_digest_id: result.evidence.shadow_digest_id,
    } : {
      summary: result.summary,
      owner: result.subscribers.find((row) => row.subscriber_id === result.owner_verification.subscriber_id),
      next_scheduled_at: result.next_scheduled_at,
    }, null, 2));
  } catch (error) {
    console.error(`carry-forward backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
