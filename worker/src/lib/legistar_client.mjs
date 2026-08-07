// Authenticated NYC Council Legistar Web API client.
//
// webapi.legistar.com/v1/nyc requires a full multi-segment API token passed as
// the `token=` query parameter (unauthenticated or truncated-first-segment → 403).
// The token reaches the Worker as the env secret LEGISTAR_API_TOKEN and is NEVER
// logged, persisted, or echoed — only stitched into the request URL in memory.
//
// Materialization is polite: one paginated Events fetch per run, then a nested
// EventItems fetch ONLY for events that the strict notice→event join matched,
// plus a bounded best-effort roll-call vote fetch. No per-user live fan-out.
//
// Person-level vote rows are retained (not only aye/nay tallies) so the official
// entity family can form votes_on edges naming the members who cast each vote.

import { summarizePersonVotes } from "../../../entity_resolution/officials/index.mjs";

export const LEGISTAR_API_BASE = "https://webapi.legistar.com/v1/nyc";
export const LEGISTAR_LOOKBACK_DAYS = 180;
export const EVENTS_PAGE_SIZE = 200;
export const EVENTS_MAX_PAGES = 4;
export const BODIES_PAGE_SIZE = 500;
export const BODIES_MAX_PAGES = 4;
export const EVENT_ITEMS_TOP = 500;
export const VOTES_TOP = 200;
// Bound the best-effort roll-call fan-out so a single materialization run stays
// polite even if many items are flagged.
export const MAX_VOTE_PROBES_PER_EVENT = 6;
export const MAX_TOTAL_VOTE_PROBES = 240;
export const MAX_ATTACHMENT_PROBES_PER_EVENT = 8;
export const MAX_TOTAL_ATTACHMENT_PROBES = 320;
export const MATTERS_PAGE_SIZE = 200;
export const MATTERS_MAX_PAGES = 20;

/**
 * Stitch the token into a URL without ever materializing it in a log line.
 * Returns the full URL string; callers must not log it.
 */
function authedUrl(path, token, params = {}) {
  const url = new URL(`${LEGISTAR_API_BASE}/${path}`);
  url.searchParams.set("token", String(token || ""));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchJson(fetchImpl, url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      headers: { Accept: "application/json", "User-Agent": "cityscroll-legistar/1.0" },
    });
    if (!res.ok) {
      const err = new Error(`legistar-http-${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.value)) return body.value;
    if (Array.isArray(body?.d)) return body.d;
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch publisher-issued governing-body identities. BodyId is the stable key;
 * names are descriptive and must not be promoted to an identity on their own.
 */
export async function fetchLegistarBodies({ token, fetchImpl = fetch } = {}) {
  if (!token) return [];
  const rows = [];
  for (let page = 0; page < BODIES_MAX_PAGES; page += 1) {
    const batch = await fetchJson(
      fetchImpl,
      authedUrl("Bodies", token, {
        $top: String(BODIES_PAGE_SIZE),
        $skip: String(page * BODIES_PAGE_SIZE),
        $orderby: "BodyName asc",
      }),
    );
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < BODIES_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Fetch enacted Introductions in a bounded date range. The API's Matter rows
 * include MatterText1..MatterText5 and report URLs; callers can fetch the
 * nested matter attachments separately when the text fields are empty.
 */
export async function fetchLegistarMatters({
  token,
  fetchImpl = fetch,
  startYear = 2014,
  endYear = new Date().getUTCFullYear(),
  limit = null,
} = {}) {
  if (!token) return [];
  const start = `${Number(startYear)}-01-01T00:00:00Z`;
  const end = `${Number(endYear) + 1}-01-01T00:00:00Z`;
  const filter = [
    "MatterTypeName eq 'Introduction'",
    "MatterStatusName eq 'Enacted'",
    `MatterEnactmentDate ge datetime'${start}'`,
    `MatterEnactmentDate lt datetime'${end}'`,
  ].join(" and ");
  const rows = [];
  for (let page = 0; page < MATTERS_MAX_PAGES; page += 1) {
    const remaining = limit == null ? MATTERS_PAGE_SIZE : Math.max(0, Number(limit) - rows.length);
    if (!remaining) break;
    const batch = await fetchJson(fetchImpl, authedUrl("Matters", token, {
      $top: String(Math.min(MATTERS_PAGE_SIZE, remaining)),
      $skip: String(page * MATTERS_PAGE_SIZE),
      $orderby: "MatterEnactmentDate asc,MatterId asc",
      $filter: filter,
    }));
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < Math.min(MATTERS_PAGE_SIZE, remaining)) break;
  }
  return limit == null ? rows : rows.slice(0, Number(limit));
}

/** Fetch one complete Matter row, including the inline MatterText fields. */
export async function fetchLegistarMatter({ matterId, token, fetchImpl = fetch } = {}) {
  if (!token || !matterId) return null;
  return fetchJson(fetchImpl, authedUrl(`Matters/${encodeURIComponent(matterId)}`, token));
}

/** Fetch the available-for-web matter attachments for one enacted law. */
export async function fetchLegistarMatterAttachments({ matterId, token, fetchImpl = fetch } = {}) {
  if (!token || !matterId) return [];
  return fetchJson(fetchImpl, authedUrl(`Matters/${encodeURIComponent(matterId)}/Attachments`, token, { $top: "100" }));
}

/**
 * Fetch Legistar Events whose EventDate falls in the look-back window, newest first.
 * Paginates with $top/$skip up to EVENTS_MAX_PAGES. Returns raw Legistar event rows.
 */
export async function fetchLegistarEvents({ token, fetchImpl = fetch, now = new Date(), lookbackDays = LEGISTAR_LOOKBACK_DAYS }) {
  if (!token) return [];
  const since = new Date(now.getTime() - lookbackDays * 86_400_000)
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  // Pass the raw OData filter; URLSearchParams encodes once (do not pre-encode).
  const filter = `EventDate ge datetime'${since}'`;
  const rows = [];
  for (let page = 0; page < EVENTS_MAX_PAGES; page += 1) {
    const params = {
      $top: String(EVENTS_PAGE_SIZE),
      $skip: String(page * EVENTS_PAGE_SIZE),
      $orderby: "EventDate desc",
      $filter: filter,
    };
    const batch = await fetchJson(fetchImpl, authedUrl("Events", token, params));
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < EVENTS_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Fetch EventItems for one event (nested route). Returns raw Legistar item rows,
 * which carry inline matter linkage (EventItemMatterFile/Name/Status) and the
 * action outcome (EventItemActionName / EventItemPassedFlagName).
 */
export async function fetchLegistarEventItems({ eventId, token, fetchImpl = fetch }) {
  if (!token || !eventId) return [];
  return fetchJson(
    fetchImpl,
    authedUrl(`Events/${encodeURIComponent(eventId)}/EventItems`, token, { $top: String(EVENT_ITEMS_TOP) }),
  );
}

/**
 * Pure roll-call summarizer shared by the live client and characterization tests.
 * Retains person-level identity when Legistar publishes VotePersonId /
 * VotePersonName (live) or PersonId / PersonName (fixtures / aliases).
 *
 * @param {Array<object>} rows
 * @param {{ matterId?: string|null, agendaItemId?: string|null, eventItemId?: string|null }} [target]
 */
export function summarizeLegistarVotes(rows, target = {}) {
  return summarizePersonVotes(rows, {
    matterId: target.matterId ?? null,
    agendaItemId: target.agendaItemId ?? target.eventItemId ?? null,
    eventItemId: target.eventItemId ?? null,
  });
}

/**
 * Raw roll-call vote rows for one agenda item (publisher payload, no summarization).
 * Used for immutable source_records dual-write and by fetchLegistarItemVotes.
 */
export async function fetchLegistarItemVoteRows({
  itemId,
  token,
  fetchImpl = fetch,
} = {}) {
  if (!token || !itemId) return [];
  return fetchJson(
    fetchImpl,
    authedUrl(`EventItems/${encodeURIComponent(itemId)}/Votes`, token, { $top: String(VOTES_TOP) }),
    10000,
  );
}

/**
 * Best-effort roll-call vote fetch for one agenda item. Returns an aggregated
 * summary with retained per-person rows (official objects + votes_on edges)
 * when the endpoint has recorded votes; null when empty.
 */
export async function fetchLegistarItemVotes({
  itemId,
  token,
  fetchImpl = fetch,
  matterId = null,
  agendaItemId = null,
} = {}) {
  if (!token || !itemId) return null;
  const rows = await fetchLegistarItemVoteRows({ itemId, token, fetchImpl });
  if (!rows.length) return null;
  return summarizeLegistarVotes(rows, {
    matterId,
    agendaItemId: agendaItemId ?? itemId,
    eventItemId: itemId,
  });
}

/**
 * Raw attachment rows for one agenda item (publisher payload).
 * Used for immutable source_records dual-write and document card mapping.
 */
export async function fetchLegistarItemAttachmentRows({
  itemId,
  token,
  fetchImpl = fetch,
} = {}) {
  if (!token || !itemId) return [];
  return fetchJson(
    fetchImpl,
    authedUrl(`EventItems/${encodeURIComponent(itemId)}/Attachments`, token, { $top: "50" }),
    10000,
  );
}

/**
 * Project raw Legistar attachment rows into public document cards.
 * Prefer MatterAttachment* fields when present.
 */
export function projectLegistarAttachmentDocuments(rows = []) {
  const out = [];
  for (const row of rows) {
    const url = row.MatterAttachmentHyperlink
      || row.AttachmentUrl
      || row.FileUrl
      || row.Url
      || null;
    if (!url) continue;
    out.push({
      url: String(url),
      name: String(row.MatterAttachmentName || row.Name || row.FileName || "Attachment").trim() || "Attachment",
      category: String(row.MatterAttachmentIsSupportingDocument != null
        ? (row.MatterAttachmentIsSupportingDocument ? "Supporting" : "Primary")
        : (row.Category || "Attachment")),
    });
  }
  return out;
}

/**
 * Best-effort attachment fetch for one agenda item. Returns [{url, name, category}]
 * or [] when the nested route is empty.
 */
export async function fetchLegistarItemAttachments({ itemId, token, fetchImpl = fetch }) {
  const rows = await fetchLegistarItemAttachmentRows({ itemId, token, fetchImpl });
  return projectLegistarAttachmentDocuments(rows);
}

/**
 * Run a list of async producers with a bounded concurrency cap, preserving order.
 * Used to keep EventItems / vote fan-out polite without serializing everything.
 */
export async function boundedMap(items, producer, concurrency = 6) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await producer(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
