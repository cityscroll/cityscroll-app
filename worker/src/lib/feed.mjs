// Pure feed builders for GET /feed.{xml,json,ics} — no I/O, unit-tested on their own.
// A feed is the third spelling of a saved search (email digest / RSS / calendar), so items
// come from the same compileSub() queries the cron replays; entry links land on the site's
// /notices/<id> permalinks.

import { cleanNoticeText as stripHtml } from "../../../site/text_clean.mjs";
import { landProjectDisplayTitle, noticeDisplayTitle } from "../../../site/display_title.mjs";
import { calendarFeedUnsupportedFilterFields } from "../../../site/scope_v0.mjs";
import { calendarOccurrenceFromLegacyFeedItem } from "../../../site/calendar_occurrence.mjs";

const esc = (s) => String(s == null ? "" : s).replace(/[<>&"']/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[c]));
const usd = (n) => (n == null || n === "" || !Number(n) ? "" : "$" + Number(n).toLocaleString("en-US"));
const d10 = (s) => (s ? String(s).slice(0, 10) : "");

// URL query → { lens, filter } in the shape sanitize() expects. Keywords capped like the NL layer.
export function parseFeedQuery(searchParams) {
  const lens = searchParams.get("lens") || "money";
  if (searchParams.has("filter")) {
    try {
      const filter = JSON.parse(searchParams.get("filter") || "");
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("filter must be an object");
      return { lens, filter, modern: true, error: null };
    } catch {
      return { lens, filter: null, modern: true, error: "invalid filter" };
    }
  }
  const keywords = (searchParams.get("q") || "").split(/\s+/).filter(Boolean).slice(0, 4);
  const agency = searchParams.get("agency") || null;
  const min = searchParams.get("min");
  return { lens, filter: {
    keywords, agency, minAmount: min ? Number(min) : null,
    name: searchParams.get("name") || null, kind: searchParams.get("kind") || null, // entity feeds
  } };
}

/** Modern scope filters must be replayable or the feed must refuse them explicitly. */
export function unsupportedModernFeedFilterFields(lens, filter) {
  return calendarFeedUnsupportedFilterFields({ lens, filter });
}

// Normalize compileSub result rows → neutral feed items.
export function feedItems(kind, rows) {
  return (rows || []).map((r) => {
    if (kind === "project-calendar" && r?.uid) {
      return {
        id: String(r.uid),
        url: r.canonical_url || "https://cityscroll.org/",
        title: r.title || "Project calendar item",
        date: r.starts_at || r.date || null,
        summary: [r.kind, r.provenance?.connected_relation, r.source?.system]
          .filter(Boolean).join(" · "),
        eventDate: r.starts_at || r.date || null,
        phase: r.kind || "Project milestone",
        nextStep: null,
      };
    }
    if (kind === "meetings" && r.meeting_id) {
      return {
        id: String(r.meeting_id),
        url: `https://cityscroll.org/meetings/${encodeURIComponent(r.meeting_id)}/`,
        title: r.title || "Meeting",
        date: r.start_date || r.event_date || null,
        summary: [r.board_name || r.agency || r.agency_name, r.committee?.name, r.venue?.address || r.venue?.name]
          .filter(Boolean).join(" · "),
        eventDate: r.event_date || null,
        phase: "Hearing / meeting",
        nextStep: r.event_date ? `Event ${d10(r.event_date)}` : null,
      };
    }
    if (kind === "exam" && r.exam_number) {
      const id = String(r.exam_number);
      const date = r.application_end || r.application_start || r.exam_date || null;
      return {
        id: `exam:${id}`,
        url: `https://cityscroll.org/exams/${encodeURIComponent(id)}/`,
        title: r.title || `Civil-service exam ${id}`,
        date,
        summary: [r.interest_area, r.application_start && `opens ${d10(r.application_start)}`,
          r.application_end && `closes ${d10(r.application_end)}`, r.exam_date && `exam ${d10(r.exam_date)}`]
          .filter(Boolean).join(" · "),
        eventDate: r.exam_date || r.application_end || r.application_start || null,
        phase: r.exam_date ? "Exam date" : "Application deadline",
        nextStep: r.application_end ? `Applications close ${d10(r.application_end)}` : null,
      };
    }
    if (r.procurement_id && !r.request_id) {
      const href = r.canonical_href
        ? `https://cityscroll.org${r.canonical_href}`
        : `https://cityscroll.org/procurements/${encodeURIComponent(r.procurement_id)}`;
      return {
        id: String(r.procurement_id),
        url: href,
        title: r.short_title || "Contract",
        date: r.start_date || null,
        summary: [r.agency_name, usd(r.contract_amount), r.vendor_name ? "→ " + stripHtml(r.vendor_name) : ""]
          .filter(Boolean).join(" · "),
        eventDate: null,
        phase: r.primary_stage || "Registered contract",
        nextStep: r.start_date ? `Registered ${d10(r.start_date)}` : null,
      };
    }
    if (kind === "land-hearings") {
      const id = String(r.project_id || "");
      if (!id) return null;
      const date = r.hearing_at || r.hearing_date || null;
      return {
        id,
        url: r.portal_url || `https://cityscroll.org/browse/zoning/#land/${encodeURIComponent(id)}`,
        title: `Public hearing — ${r.project_name || id}`,
        date,
        summary: [r.representing, r.venue_address || r.hearing_location_raw, r.livestream_url ? "Online" : ""]
          .filter(Boolean).join(" · "),
        eventDate: date,
        phase: "Zoning hearing",
        nextStep: date ? `Event ${d10(date)}` : null,
      };
    }
    if (kind === "rezone") {
      return {
        id: String(r.project_id || ""),
        url: `https://zap.planning.nyc.gov/projects/${encodeURIComponent(r.project_id || "")}`,
        title: landProjectDisplayTitle(r),
        date: r.current_milestone_date || null,
        summary: [r.borough, r.community_district ? "CD " + r.community_district : "", r.public_status, r.primary_applicant]
          .filter(Boolean).join(" · "),
        eventDate: null,
        phase: r.public_status || "Land use (ULURP)",
        nextStep: r.public_status ? `Status: ${r.public_status}` : null,
      };
    }
    if (kind === "obligation") {
      // World-state mandate rows: alert_id is the idempotency key; link the agency constellation.
      // Prediction branch deep-links expected-event surface and names the event + window.
      const agencySlug = r.agency_id
        || String(r.agency_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const isPredicted = r.predicted_event === true || !!r.expected_event_kind;
      const deadline = r.deadline_date
        ? (isPredicted
          ? (Number.isFinite(r.days_to_deadline) && r.days_to_deadline >= 0
            ? `expected by ${d10(r.deadline_date)} · ${r.days_to_deadline} day${r.days_to_deadline === 1 ? "" : "s"}`
            : `expected by ${d10(r.deadline_date)}`)
          : `statutory deadline ${d10(r.deadline_date)}`)
        : (r.deadline_text ? `deadline: ${stripHtml(r.deadline_text)}` : "no computed deadline");
      const agencyUrl = agencySlug
        ? `https://cityscroll.org/agencies/${encodeURIComponent(agencySlug)}/${isPredicted ? "#mandates-predictions" : ""}`
        : "https://cityscroll.org/agencies/";
      return {
        id: String(r.alert_id || r.obligation_id || ""),
        url: agencyUrl,
        title: stripHtml(r.duty_text || r.short_title || "Statutory mandate"),
        date: r.deadline_date || r.start_date || null,
        summary: [
          r.agency_name,
          isPredicted ? r.expected_event_label : null,
          r.deliverable_type,
          deadline,
          isPredicted ? (r.prediction_band_label || r.prediction_band) : null,
          r.recurrence,
          r.citation,
        ].filter(Boolean).map((part) => stripHtml(part)).join(" · "),
        eventDate: r.deadline_date || null,
        phase: isPredicted ? (r.expected_event_label || "Expected filing") : (r.deliverable_type || "Mandate"),
        nextStep: isPredicted
          ? (Number.isFinite(r.days_to_deadline) && r.days_to_deadline >= 0
            ? `Expected in ${r.days_to_deadline} day${r.days_to_deadline === 1 ? "" : "s"}`
            : (r.deadline_date ? `Expected by ${d10(r.deadline_date)}` : null))
          : (r.deadline_date ? `Statutory deadline ${d10(r.deadline_date)}` : null),
      };
    }
    const phase = r.type_of_notice_description
      || (kind === "rfp" ? "Solicitation" : kind === "award" ? "Award" : kind === "rules" ? "Agency Rules" : kind === "hearing" || kind === "meetings" ? "Hearing / meeting" : null);
    const nextStep = r.due_date
      ? `Due ${d10(r.due_date)}`
      : r.event_date
        ? `Event ${d10(r.event_date)}`
        : null;
    return {
      id: String(r.request_id || ""),
      url: `https://cityscroll.org/notices/${encodeURIComponent(r.request_id || "")}`,
      title: noticeDisplayTitle(r),
      date: r.start_date || null,
      summary: [
        r.agency_name, usd(r.contract_amount), r.vendor_name ? "→ " + stripHtml(r.vendor_name) : "",
        r.due_date ? "due " + d10(r.due_date) : "", r.event_date ? "event " + d10(r.event_date) : "",
        r.street_address_1 && !/not listed|^n\/?a$|^none$|^various|^see /i.test(String(r.street_address_1).trim()) ? stripHtml(r.street_address_1) : "",
      ].filter(Boolean).join(" · "),
      eventDate: r.event_date || r.due_date || null,
      phase,
      nextStep,
    };
  }).filter((it) => it.id);
}

export function atomFeed({ title, selfUrl, siteUrl, updated, items }) {
  const entries = items.map((it) => `  <entry>
    <id>tag:crol-list.org,2026:${esc(it.id)}</id>
    <title>${esc(it.title)}</title>
    <link href="${esc(it.url)}"/>
    <updated>${esc(toRfc3339(it.date, updated))}</updated>
    <summary>${esc(it.summary)}</summary>
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(title)}</title>
  <id>${esc(selfUrl)}</id>
  <link rel="self" href="${esc(selfUrl)}"/>
  <link rel="alternate" href="${esc(siteUrl)}"/>
  <updated>${esc(updated)}</updated>
${entries}
</feed>
`;
}

export function jsonFeed({ title, selfUrl, siteUrl, items }) {
  return JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title,
    home_page_url: siteUrl,
    feed_url: selfUrl,
    items: items.map((it) => ({
      id: it.id,
      url: it.url,
      title: it.title,
      date_published: toRfc3339(it.date, null) || undefined,
      content_text: it.summary || it.title,
    })),
  }, null, 1);
}

// Subscribable calendar: serialize producer-emitted occurrences only.
// `items` is retained as a compatibility input for callers from Cal-1; the
// producer-side adapter upgrades each legacy item's eventDate before it gets
// here. The literal legacy shape `UID:${escIcs(it.id)}@crol-list` remains the
// documented namespace contract even though new code serializes occurrence.uid.
export function icsFeed({ title, occurrences, items }) {
  const legacyInput = !Array.isArray(occurrences) && Array.isArray(items);
  const pad = (n) => String(n).padStart(2, "0");
  const dt = (s) => {
    // Preserve the producer's wall-clock components. Converting an ISO value
    // through the host timezone would turn 18:00-04:00 into 22:00 on UTC
    // runners, even when the occurrence explicitly carries America/New_York.
    const source = String(s == null ? "" : s);
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(source);
    if (parts) return `${parts[1]}${parts[2]}${parts[3]}T${parts[4]}${parts[5]}${parts[6] || "00"}`;
    const d = new Date(source);
    if (isNaN(d)) return null;
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };
  const escIcs = (s) => String(s == null ? "" : s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const fold = (line) => {
    const chunks = [];
    let chunk = "";
    for (const character of String(line)) {
      if (chunk.length >= 74) { chunks.push(chunk); chunk = ` ${character}`; }
      else chunk += character;
    }
    chunks.push(chunk);
    return chunks.join("\r\n");
  };
  const dateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  const dateParts = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
    return match ? match.slice(1).join("") : null;
  };
  const nextDate = (value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    parsed.setUTCDate(parsed.getUTCDate() + 1);
    return parsed.toISOString().slice(0, 10).replace(/-/g, "");
  };
  const asOccurrenceList = Array.isArray(occurrences)
    ? occurrences
    : (items || []).flatMap((item) => {
      // Legacy callers are upgraded at the producer boundary. The serializer
      // receives only occurrence objects and never selects a row timestamp.
      const occurrence = calendarOccurrenceFromLegacyFeedItem(item);
      return occurrence ? [occurrence] : [];
    });
  const formatDateTime = (occurrence, value) => {
    const when = dt(value);
    if (!when) return null;
    return occurrence.timezone ? `DTSTART;TZID=${escIcs(occurrence.timezone)}:${when}` : `DTSTART:${when}`;
  };
  const events = asOccurrenceList
    .filter((occurrence) => occurrence && (occurrence.starts_at || occurrence.date))
    .map((occurrence) => {
      const allDay = Boolean(occurrence.date);
      const when = allDay ? dateParts(occurrence.date) : dt(occurrence.starts_at);
      if (!when) return null;
      const end = allDay
        ? (dateParts(occurrence.ends_at) || nextDate(occurrence.date))
        : dt(occurrence.ends_at || occurrence.starts_at);
      if (!end) return null;
      const description = [occurrence.description, occurrence.canonical_url]
        .filter(Boolean).join(" · ");
      const lines = [
      "BEGIN:VEVENT",
      `UID:${escIcs(occurrence.uid)}@crol-list`,
      `DTSTAMP:${occurrence.observed_at ? new Date(occurrence.observed_at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") : when}`,
      ...(allDay
        ? [`DTSTART;VALUE=DATE:${when}`, `DTEND;VALUE=DATE:${end}`]
        : [formatDateTime(occurrence, occurrence.starts_at), occurrence.timezone
          ? `DTEND;TZID=${escIcs(occurrence.timezone)}:${end}` : `DTEND:${end}`]),
      `SUMMARY:${escIcs(occurrence.title)}`,
      ...(occurrence.location ? [`LOCATION:${escIcs(typeof occurrence.location === "string" ? occurrence.location : JSON.stringify(occurrence.location))}`] : []),
      ...(!legacyInput && occurrence.canonical_url ? [`URL:${escIcs(occurrence.canonical_url)}`] : []),
      ...(description ? [`DESCRIPTION:${escIcs(description)}`] : []),
      ...(occurrence.status !== "scheduled" ? [`STATUS:${occurrence.status.toUpperCase()}`] : []),
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:Tomorrow", "END:VALARM",
      "END:VEVENT",
      ];
      return lines.filter(Boolean).map(legacyInput ? (line) => line : fold).join("\r\n");
    }).filter(Boolean);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CityScroll//feeds//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escIcs(title)}`,
    ...events,
    "END:VCALENDAR", "",
  ].join("\r\n");
}

function toRfc3339(s, fallback) {
  if (!s) return fallback || "";
  const d = new Date(s);
  if (isNaN(d)) return fallback || "";
  return d.toISOString();
}
