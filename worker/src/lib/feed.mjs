// Pure feed builders for GET /feed.{xml,json,ics} — no I/O, unit-tested on their own.
// A feed is the third spelling of a saved search (email digest / RSS / calendar), so items
// come from the same compileSub() queries the cron replays; entry links land on the site's
// #notice/<id> permalinks.

const esc = (s) => String(s == null ? "" : s).replace(/[<>&"']/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[c]));
const stripHtml = (s) => String(s == null ? "" : s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
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
    if (kind === "rezone") {
      return {
        id: String(r.project_id || ""),
        url: `https://zap.planning.nyc.gov/projects/${encodeURIComponent(r.project_id || "")}`,
        title: stripHtml(r.project_name) || "(unnamed rezoning)",
        date: r.current_milestone_date || null,
        summary: [r.borough, r.community_district ? "CD " + r.community_district : "", r.public_status, r.primary_applicant]
          .filter(Boolean).join(" · "),
        eventDate: null,
      };
    }
    return {
      id: String(r.request_id || ""),
      url: `https://crol-list.org/#notice/${encodeURIComponent(r.request_id || "")}`,
      title: stripHtml(r.short_title) || "(untitled notice)",
      date: r.start_date || null,
      summary: [
        r.agency_name, usd(r.contract_amount), r.vendor_name ? "→ " + stripHtml(r.vendor_name) : "",
        r.due_date ? "due " + d10(r.due_date) : "", r.event_date ? "event " + d10(r.event_date) : "",
        r.street_address_1 && !/not listed|^n\/?a$|^none$|^various|^see /i.test(String(r.street_address_1).trim()) ? stripHtml(r.street_address_1) : "",
      ].filter(Boolean).join(" · "),
      eventDate: r.event_date || r.due_date || null,
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
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CROL-List//feeds//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
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
