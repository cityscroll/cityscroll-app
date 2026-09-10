// Read-only membership probe over a watch's seen-id watermark.
//
// Operators supply candidate ids; the response reports set size and which of
// those ids are members. It never dumps the stored set, subscriber addresses,
// or watch filter contents.

import { digestShadowId } from "../digest_shadow_hold.mjs";

export const WATCH_SEEN_MEMBERSHIP_SCHEMA = "cityscroll.watch_seen_membership.v1";
export const MAX_WATCHES = 8;
export const MAX_IDS_PER_WATCH = 500;

const WATCH_KEY_RE = /^sub:[A-Za-z0-9][A-Za-z0-9._@+:-]{7,120}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export function parseWatchKey(value) {
  const key = String(value ?? "").trim();
  return WATCH_KEY_RE.test(key) ? key : null;
}

export function parseCandidateIds(list) {
  if (list == null) return { ok: true, ids: [] };
  if (!Array.isArray(list)) return { ok: false, error: "ids-not-array" };
  if (list.length > MAX_IDS_PER_WATCH) return { ok: false, error: "too-many-ids" };
  const ids = [];
  const seen = new Set();
  for (const raw of list) {
    const id = String(raw ?? "").trim();
    if (!id) continue;
    if (!ID_RE.test(id)) return { ok: false, error: "invalid-id" };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids };
}

export function parseSeenSet(raw) {
  if (raw == null || raw === "") return { ok: true, ids: [] };
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: "unreadable" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "unreadable" };
  return { ok: true, ids: parsed.map((value) => String(value)) };
}

export function seenMembership(storedIds, suppliedIds) {
  const seen = storedIds instanceof Set ? storedIds : new Set(storedIds || []);
  const seenMemberIds = [];
  const unseenMemberIds = [];
  for (const id of suppliedIds) {
    if (seen.has(id)) seenMemberIds.push(id);
    else unseenMemberIds.push(id);
  }
  return {
    seen_set_size: seen.size,
    supplied_id_count: suppliedIds.length,
    seen_member_count: seenMemberIds.length,
    unseen_member_count: unseenMemberIds.length,
    seen_member_ids: seenMemberIds,
    unseen_member_ids: unseenMemberIds,
  };
}

export async function internalWatchReference(watchKey) {
  return digestShadowId("digest", watchKey);
}

export function parseWatchQuery(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "invalid-watch" };
  const watchKey = parseWatchKey(input.watch_key);
  if (!watchKey) return { ok: false, error: "invalid-watch-key" };
  const ids = parseCandidateIds(input.ids);
  if (!ids.ok) return ids;
  return { ok: true, watch_key: watchKey, ids: ids.ids };
}

export function parseWatchQueries(body, { watchKeyParam = null, idsParam = null } = {}) {
  if (watchKeyParam) {
    const parsed = parseWatchQuery({
      watch_key: watchKeyParam,
      ids: idsParam == null || idsParam === ""
        ? []
        : String(idsParam).split(",").map((part) => part.trim()).filter(Boolean),
    });
    if (!parsed.ok) return parsed;
    return { ok: true, watches: [parsed] };
  }
  const watches = body?.watches;
  if (!Array.isArray(watches) || watches.length === 0) return { ok: false, error: "watches-required" };
  if (watches.length > MAX_WATCHES) return { ok: false, error: "too-many-watches" };
  const out = [];
  for (const row of watches) {
    const parsed = parseWatchQuery(row);
    if (!parsed.ok) return parsed;
    out.push(parsed);
  }
  return { ok: true, watches: out };
}
