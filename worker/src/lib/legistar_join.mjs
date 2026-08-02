// Strict City Record hearing notice ↔ NYC Council Legistar event join.
//
// Authenticated re-measure 2026-07-30 against webapi.legistar.com/v1/nyc
// (LEGISTAR_API_TOKEN as token= query; see site/data/legistar_sources/):
//
//   Product universe (City Council Public Hearings, start_date >= 2025-01-01):
//     strict event join rate 100% (59 / 59).
//   Historical overlap (start_date in [2019-01-01, 2025-01-01)):
//     strict event join rate 73.41% (127 / 173).
//   Depth on joined modern events:
//     EventItems 100% · matter-linked items 98.3% · any votes (sampled) 10.2%.
//
// Accepted strategies (strict only):
//   exact_date_body_tokens — notice.event_date equals EventDate/meeting_date AND
//     the body/committee name is uniquely identified in the notice title
//     (full normalized containment, or every distinctive body token appears).
//
// Rejected as weak:
//   date_only                 — any Council meeting on the same day without body match
//   title_token_overlap_loose — partial token overlap across different bodies
//   multi_match_ambiguous     — two+ same-day bodies that both match the title
//
// Open Data m48u-yjt8 (committee/meeting_date) is a free freeze through 2024-12-19
// and is still useful for historical event identity without a token. Live depth
// (EventItems / Votes / Attachments) requires LEGISTAR_API_TOKEN.
//
// Verdict: above usefulness threshold (~30%) for modern event + agenda materialization.
// Recommend edge materialization with Worker secret LEGISTAR_API_TOKEN.

const STOPWORDS = new Set([
  "meeting",
  "correction",
  "subcommittee",
  "committee",
  "the",
  "and",
  "of",
  "on",
  "for",
  "a",
  "an",
]);

/** Lowercase alnum tokens collapsed to single spaces. */
export function alnumSpaces(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinctive body/committee tokens (length > 3, not stopwords). */
export function distinctiveTokens(value) {
  return alnumSpaces(value)
    .split(" ")
    .filter((t) => t && t.length > 3 && !STOPWORDS.has(t));
}

/**
 * True when the meeting body/committee is named in the City Record notice title.
 * Prefers full normalized containment; falls back to all distinctive tokens present.
 */
export function committeeMatchesTitle(committee, title) {
  const cn = alnumSpaces(committee);
  const tn = alnumSpaces(title);
  if (!cn || !tn) return false;
  if (tn.includes(cn)) return true;
  const ctoks = distinctiveTokens(committee);
  if (ctoks.length < 2) return false;
  const tset = new Set(tn.split(" ").filter(Boolean));
  return ctoks.every((t) => tset.has(t));
}

/** Alias for Legistar API EventBodyName matching. */
export const bodyMatchesTitle = committeeMatchesTitle;

/**
 * Build a meeting_date / EventDate → events index.
 * Accepts Open Data rows (meeting_date, committee) or Legistar Events
 * (EventDate, EventBodyName, EventId).
 * @returns {Map<string, object[]>}
 */
export function buildMeetingDateIndex(meetings) {
  const byDate = new Map();
  for (const row of meetings || []) {
    const day = String(row?.meeting_date || row?.EventDate || row?.event_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push(row);
  }
  return byDate;
}

function bodyName(meeting) {
  return meeting?.committee || meeting?.EventBodyName || meeting?.body_name || meeting?.body || "";
}

function eventIdOf(meeting) {
  if (meeting?.event_id != null) return String(meeting.event_id);
  if (meeting?.EventId != null) return String(meeting.EventId);
  return "";
}

/**
 * Strict join of one City Record hearing notice to a date-indexed event list.
 * @returns {{ method: string, event_id: string, meeting: object } | null}
 */
export function joinNoticeToCouncilMeeting(notice, byDate) {
  if (!byDate || typeof byDate.get !== "function") return null;
  const day = String(notice?.event_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const title = notice?.short_title || notice?.title || "";
  const hits = [];
  for (const meeting of byDate.get(day) || []) {
    if (committeeMatchesTitle(bodyName(meeting), title)) hits.push(meeting);
  }
  if (hits.length !== 1) return null;
  const meeting = hits[0];
  const eventId = eventIdOf(meeting);
  if (!eventId) return null;
  return {
    method: "exact_date_body_tokens",
    event_id: eventId,
    meeting,
  };
}

/**
 * Meeting detail URL from an Open Data or Legistar row.
 */
export function meetingDetailUrl(meeting) {
  const raw = meeting?.url;
  if (typeof raw === "string" && raw) return raw;
  if (raw && typeof raw === "object" && raw.url) return String(raw.url);
  const id = eventIdOf(meeting);
  if (id) {
    return `https://nyc.legistar.com/MeetingDetail.aspx?LEGID=${encodeURIComponent(id)}`;
  }
  return null;
}

/**
 * Deep-link a Council matter (legislation) from a numeric Legistar MatterId.
 *
 * LegislationDetail.aspx requires both ID and GUID ("Invalid parameters!" without
 * GUID). Gateway M=L resolves MatterId → the full InSite detail URL (302). Only
 * numeric API MatterIds are accepted — fixture strings like "mat-001" return null
 * so we never emit a fake destination.
 *
 * Verified 2026-08-02: MatterId 79062 → LU 0091-2026 LegislationDetail.
 */
export function matterDetailUrl(matterId) {
  const id = String(matterId == null ? "" : matterId).trim();
  if (!/^\d+$/.test(id)) return null;
  return `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${encodeURIComponent(id)}`;
}
