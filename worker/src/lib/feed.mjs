// Pure feed builders for GET /feed.{xml,json,ics} — no I/O, unit-tested on their own.
// A feed is the third spelling of a saved search (email digest / RSS / calendar), so items
// come from the same compileSub() queries the cron replays; entry links land on the site's
// /notices/<id> permalinks.

import { cleanNoticeText as stripHtml } from "../../../site/text_clean.mjs";
import { landProjectDisplayTitle, noticeDisplayTitle } from "../../../site/display_title.mjs";

const esc = (s) => String(s == null ? "" : s).replace(/[<>&"']/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[c]));
const usd = (n) => (n == null || n === "" || !Number(n) ? "" : "$" + Number(n).toLocaleString("en-US"));
const d10 = (s) => (s ? String(s).slice(0, 10) : "");

// URL query → { lens, filter } in the shape sanitize() expects. Keywords capped like the NL layer.
export function parseFeedQuery(searchParams) {
  const lens = searchParams.get("lens") || "money";
  const keywords = (searchParams.get("q") || "").split(/\s+/).filter(Boolean).slice(0, 4);
  const agency = searchParams.get("agency") || null;
  const min = searchParams.get("min");
  return { lens, filter: {
    keywords, agency, minAmount: min ? Number(min) : null,
    name: searchParams.get("name") || null, kind: searchParams.get("kind") || null, // entity feeds
  } };
}

// Normalize compileSub result rows → neutral feed items.
export function feedItems(kind, rows) {
  return (rows || []).map((r) => {
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

// Subscribable calendar: one VEVENT per item that has an event or due date.
export function icsFeed({ title, items }) {
  const pad = (n) => String(n).padStart(2, "0");
  const dt = (s) => {
    const d = new Date(s);
    if (isNaN(d)) return null;
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };
  const escIcs = (s) => String(s == null ? "" : s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const events = items
    .map((it) => ({ it, when: it.eventDate ? dt(it.eventDate) : null }))
    .filter((x) => x.when)
    .map(({ it, when }) => [
      "BEGIN:VEVENT",
      `UID:${escIcs(it.id)}@crol-list`,
      `DTSTAMP:${when}`,
      `DTSTART:${when}`,
      `DTEND:${when}`,
      `SUMMARY:${escIcs(it.title)}`,
      `DESCRIPTION:${escIcs((it.summary ? it.summary + " · " : "") + it.url)}`,
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:Tomorrow", "END:VALARM",
      "END:VEVENT",
    ].join("\r\n"));
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
