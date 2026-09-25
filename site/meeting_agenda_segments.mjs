/**
 * Stable agenda-segment identity and historical dating for meeting detail.
 *
 * Segment anchors are content-derived (kind + start_time + title) so they stay
 * stable when display order changes. Historical dating uses CROL_BUILD_DAY when
 * pinned, otherwise the runtime UTC calendar day.
 */

export const MEETING_AGENDA_SEGMENT_ANCHOR_PREFIX = "agenda-segment-";

function fnv1aHex(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeSegmentTitle(title) {
  return String(title ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Content-stable segment id. Never uses display index / order alone.
 */
export function stableAgendaSegmentId(segment = {}) {
  const existing = String(segment?.segment_id || "").trim();
  if (/^agenda-segment-[0-9a-f]{8,}$/i.test(existing)) return existing.toLowerCase();
  const kind = String(segment?.kind || "other").trim().toLowerCase() || "other";
  const start = String(segment?.start_time || "").trim() || "untimed";
  const title = normalizeSegmentTitle(segment?.title);
  return `${MEETING_AGENDA_SEGMENT_ANCHOR_PREFIX}${fnv1aHex(`${kind}|${start}|${title}`)}`;
}

export function stampAgendaSegmentIds(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.map((segment) => {
    if (!segment || typeof segment !== "object") return segment;
    return {
      ...segment,
      segment_id: stableAgendaSegmentId(segment),
    };
  });
}

/** YYYY-MM-DD as-of day for historical labeling. */
export function meetingDetailAsOfDay(env = typeof process !== "undefined" ? process.env : {}) {
  const pinned = String(env?.CROL_BUILD_DAY || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  // determinism-lint: allow clock historical labeling compares the meeting date to the served calendar day when no build day is pinned
  return new Date().toISOString().slice(0, 10);
}

export function meetingEventDay(record = {}) {
  const raw = String(record?.event_date || "").trim();
  const day = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function isHistoricalMeeting(record = {}, asOfDay = meetingDetailAsOfDay()) {
  const day = meetingEventDay(record);
  return Boolean(day && asOfDay && day < asOfDay);
}
