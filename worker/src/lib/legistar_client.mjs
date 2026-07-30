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

export const LEGISTAR_API_BASE = "https://webapi.legistar.com/v1/nyc";
export const LEGISTAR_LOOKBACK_DAYS = 180;
export const EVENTS_PAGE_SIZE = 200;
export const EVENTS_MAX_PAGES = 4;
export const EVENT_ITEMS_TOP = 500;
export const VOTES_TOP = 200;
// Bound the best-effort roll-call fan-out so a single materialization run stays
// polite even if many items are flagged.
export const MAX_VOTE_PROBES_PER_EVENT = 6;
export const MAX_TOTAL_VOTE_PROBES = 240;
export const MAX_ATTACHMENT_PROBES_PER_EVENT = 8;
export const MAX_TOTAL_ATTACHMENT_PROBES = 320;

const VOTE_AYE = /^(aye|yes|yea|y\b|in favor|approve)/i;
const VOTE_NAY = /^(nay|no|n\b|against|reject|deny)/i;

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
    return Array.isArray(body) ? body : (body.value || body.d || []);
  } finally {
    clearTimeout(timer);
  }
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
 * Best-effort roll-call vote fetch for one agenda item. Returns an aggregated
 * { result, counts } summary, or null when the endpoint has no recorded votes.
 * Per-person rows are folded into aye/nay/abstain tallies.
 */
export async function fetchLegistarItemVotes({ itemId, token, fetchImpl = fetch }) {
  if (!token || !itemId) return null;
  const rows = await fetchJson(
    fetchImpl,
    authedUrl(`EventItems/${encodeURIComponent(itemId)}/Votes`, token, { $top: String(VOTES_TOP) }),
    10000,
  );
  if (!rows.length) return null;
  const counts = { aye: 0, nay: 0, abstain: 0 };
  for (const row of rows) {
    const value = String(
      row.VoteValue || row.VoteTypeName || row.VoteResult || row.PersonVote || "",
    ).trim();
    if (VOTE_AYE.test(value)) counts.aye += 1;
    else if (VOTE_NAY.test(value)) counts.nay += 1;
    else counts.abstain += 1;
  }
  const result = counts.aye > counts.nay
    ? "Passed"
    : counts.nay > counts.aye
      ? "Failed"
      : counts.aye
        ? "Tied"
        : null;
  return { result, counts, person_count: rows.length };
}

/**
 * Best-effort attachment fetch for one agenda item. Returns [{url, name, category}]
 * or [] when the nested route is empty. Prefer MatterAttachment* fields when present.
 */
export async function fetchLegistarItemAttachments({ itemId, token, fetchImpl = fetch }) {
  if (!token || !itemId) return [];
  const rows = await fetchJson(
    fetchImpl,
    authedUrl(`EventItems/${encodeURIComponent(itemId)}/Attachments`, token, { $top: "50" }),
    10000,
  );
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
