/**
 * Bounded adapters for community-board sources.
 *
 * A source descriptor is the authority for both the URL and the adapter. The
 * adapters deliberately do not guess a board from a hostname or a record ID
 * from a URL shape. They return source records with the receipt attached so a
 * later join can keep inaccessible, stale, and ambiguous observations honest.
 */

export const COMMUNITY_BOARD_SOURCE_RECORD_SCHEMA = "cityscroll.community_board_source_record.v1";
export const COMMUNITY_BOARD_SOURCE_RECEIPT_SCHEMA = "cityscroll.community_board_source_receipt.v1";

export const COMMUNITY_BOARD_SOURCE_ADAPTER_CONTRACTS = Object.freeze({
  html_pdf_v1: Object.freeze({
    id: "html_pdf_v1",
    formats: Object.freeze(["html", "pdf", "doc", "docx"]),
    record_kinds: Object.freeze(["event", "document"]),
    max_bytes: 2_000_000,
    contract: "explicit HTML index with linked PDF/DOC/DOCX records; record IDs and dates come from explicit attributes or labels",
  }),
  nyc_official_calendar_v1: Object.freeze({
    id: "nyc_official_calendar_v1",
    formats: Object.freeze(["html", "nyc_official_calendar"]),
    record_kinds: Object.freeze(["event"]),
    max_bytes: 2_000_000,
    contract: "NYC-hosted community-board calendar HTML; each event requires an explicit heading, publisher date, and page-declared calendar year",
  }),
  google_calendar_v1: Object.freeze({
    id: "google_calendar_v1",
    formats: Object.freeze(["ics", "google_calendar"]),
    record_kinds: Object.freeze(["event"]),
    max_bytes: 1_000_000,
    contract: "explicit iCalendar feed or a public Google Calendar embed whose calendar id yields /public/basic.ics; UID, DTSTART, and board evidence are required for a usable event",
  }),
  pdf_calendar_v1: Object.freeze({
    id: "pdf_calendar_v1",
    formats: Object.freeze(["pdf", "pdf_calendar"]),
    record_kinds: Object.freeze(["event"]),
    max_bytes: 3_000_000,
    contract: "official agenda or calendar PDF whose text carries an explicit meeting date and clock time; identity is date plus title from the PDF, never inferred from a month label or 'usually 6pm' copy",
  }),
  airtable_v1: Object.freeze({
    id: "airtable_v1",
    formats: Object.freeze(["airtable", "json"]),
    record_kinds: Object.freeze(["document", "event"]),
    max_bytes: 2_000_000,
    contract: "explicit JSON records and field map; Airtable URLs are never converted into API URLs",
  }),
  video_record_v1: Object.freeze({
    id: "video_record_v1",
    formats: Object.freeze(["video", "json"]),
    record_kinds: Object.freeze(["video"]),
    max_bytes: 2_000_000,
    contract: "explicit video-record JSON feed; record ID, date, and board evidence come from feed fields",
  }),
});

const ADAPTER_ALIASES = Object.freeze({
  html_document_index_v1: "html_pdf_v1",
  google_calendar: "google_calendar_v1",
  pdf_calendar: "pdf_calendar_v1",
  airtable: "airtable_v1",
  video: "video_record_v1",
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const iso = (value) => {
  const match = clean(value, 80).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;
  const date = `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : date;
};

const monthDate = (value) => {
  const text = clean(value, 300);
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (!match) return null;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1].toLowerCase()) + 1;
  return iso(`${match[3]}-${month}-${match[2]}`);
};

function dateFromText(value) {
  return iso(value) || monthDate(value) || yearMonth(value);
}

function yearMonth(value) {
  const text = clean(value, 300);
  const named = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  if (named) {
    const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(named[1].toLowerCase()) + 1;
    return `${named[2]}-${String(month).padStart(2, "0")}`;
  }
  const numeric = text.match(/\b(20\d{2})[-/.](\d{1,2})(?:\b|[^\d])/);
  return numeric ? `${numeric[1]}-${String(numeric[2]).padStart(2, "0")}` : null;
}

function decode(value) {
  return clean(String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))));
}

function safeUrl(value, base = null) {
  try {
    const url = new URL(String(value || ""), base || undefined);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function plain(value, max = 4_000) {
  return decode(decode(value)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function documentRole(label, url) {
  const text = `${label || ""} ${url || ""}`.toLowerCase();
  if (/minutes?|memorandum of meeting|meeting record/.test(text)) return "minutes";
  if (/agenda/.test(text)) return "agenda";
  if (/recording|video|youtube|zoom/.test(text)) return "recording";
  if (/\.(?:pdf|docx?|rtf)(?:$|[?#])/.test(text)) return "materials";
  return null;
}

function eventPageParticipation(html, baseUrl) {
  const links = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchor)) {
    const url = safeUrl(decode(match[2]), baseUrl);
    const label = plain(match[3], 160);
    if (!url || !label) continue;
    if (!/register|join|attend|participat|zoom|webinar|eventbrite/i.test(`${label} ${url}`)) continue;
    links.push({ label: /zoom|webinar|join/i.test(`${label} ${url}`) ? "Join online" : "Register to attend", url });
  }
  const unique = [...new Map(links.map((link) => [link.url, link])).values()];
  return {
    links: unique.slice(0, 4),
    remote_join_url: unique.find((link) => link.label === "Join online")?.url || null,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attribute(tag, name) {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])([^"']*)\\1`, "i");
  return tag.match(pattern)?.[2] ? decode(tag.match(pattern)[2]) : null;
}

function explicitUrl(source) {
  const value = clean(source?.url || source?.source_url, 2_000);
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function adapterId(source) {
  const requested = clean(source?.adapter || source?.adapter_id || source?.adapter_kind, 80);
  if (requested) return ADAPTER_ALIASES[requested] || requested;
  const role = clean(source?.role || source?.source_role || source?.source_type, 80).toLowerCase();
  const publisherKind = clean(source?.publisher_kind, 80).toLowerCase();
  const url = explicitUrl(source);
  if (role === "upcoming_meetings" && publisherKind === "nyc_official"
    && clean(source?.format, 200).toLowerCase() === "explicit board calendar"
    && /^https:\/\/www\d?\.nyc\.gov\/site\/.+\.page(?:$|[?#])/i.test(url || "")) {
    return "nyc_official_calendar_v1";
  }
  const format = clean(source?.format, 200).toLowerCase();
  if (/airtable/.test(format)) return "airtable_v1";
  if (/ical|i-calendar|google calendar/.test(format)) return "google_calendar_v1";
  if (/video|archive link/.test(format)) return "video_record_v1";
  if (/html|pdf|docx?|calendar|agenda|minutes|archive/.test(format)) return "html_pdf_v1";
  return null;
}

export function communityBoardSourceAdapterId(source = {}) {
  return adapterId(source);
}

export function sourceAdapterContract(source = {}) {
  const id = adapterId(source);
  return id ? COMMUNITY_BOARD_SOURCE_ADAPTER_CONTRACTS[id] || null : null;
}

export function normalizeObservedReceipt(receipt = {}, source = {}, fallback = {}) {
  const observedAt = clean(receipt.observed_at || receipt.observedOn || fallback.observed_at || fallback.observedAt, 80) || null;
  const status = clean(receipt.status || receipt.fetchability || fallback.status, 40).toLowerCase() || "unknown";
  const normalized = {
    schema: COMMUNITY_BOARD_SOURCE_RECEIPT_SCHEMA,
    source_url: explicitUrl(source),
    observed_at: observedAt,
    status: ["ok", "observed", "machine_fetchable", "verified"].includes(status) ? "ok" : "unknown",
    fetch_status: clean(receipt.fetch_status || receipt.http_status || fallback.fetch_status, 40) || null,
    content_type: clean(receipt.content_type || fallback.content_type, 120) || null,
    content_length: Number.isFinite(Number(receipt.content_length || fallback.content_length))
      ? Number(receipt.content_length || fallback.content_length)
      : null,
    parser: clean(receipt.parser || fallback.parser || adapterId(source), 80) || null,
    reason: clean(receipt.reason || fallback.reason, 240) || null,
  };
  return normalized;
}

function bodyEvidence(source, value = null) {
  const bodyId = clean(value || source?.body_id || source?.board_id, 100) || null;
  return bodyId ? { board_id: bodyId, basis: value ? "publisher_record" : "explicit_source_descriptor" } : null;
}

function publisherIds(fields = {}) {
  const values = [
    fields.publisher_identifier,
    fields.publisher_event_id,
    fields.event_id,
    fields.document_id,
    fields.video_id,
    ...(Array.isArray(fields.publisher_matter_ids) ? fields.publisher_matter_ids : []),
    ...(Array.isArray(fields.matter_ids) ? fields.matter_ids : []),
  ];
  return [...new Set(values.map((value) => clean(value, 240)).filter(Boolean))];
}

function record(source, fields = {}, receipt = {}) {
  const sourceUrl = explicitUrl(source);
  const recordId = clean(fields.record_id || fields.source_record_id || fields.event_id || fields.document_id || fields.video_id, 240) || null;
  const kind = clean(fields.record_kind || fields.kind, 40) || "document";
  const date = dateFromText(fields.date || fields.meeting_date || fields.start_at || fields.published_at || "");
  const bodyId = clean(fields.board_id || fields.body_id || source?.board_id || source?.body_id, 100) || null;
  const publisherMatterIds = [...new Set([
    ...(Array.isArray(fields.publisher_matter_ids) ? fields.publisher_matter_ids : []),
    ...(Array.isArray(fields.matter_ids) ? fields.matter_ids : []),
  ].map((value) => clean(value, 240)).filter(Boolean))];
  const ids = publisherIds({ ...fields, record_id: recordId, publisher_matter_ids: publisherMatterIds });
  const normalizedReceipt = normalizeObservedReceipt(receipt, source, { parser: adapterId(source) });
  const normalized = {
    schema: COMMUNITY_BOARD_SOURCE_RECORD_SCHEMA,
    source_url: sourceUrl,
    board_id: bodyId,
    body_id: bodyId,
    body: clean(fields.body || fields.body_name || source?.body_name || bodyId, 240) || null,
    body_name: clean(fields.body_name || source?.body_name, 240) || null,
    body_evidence: fields.body_evidence || bodyEvidence(source, fields.board_id || fields.body_id),
    record_kind: kind,
    record_id: recordId,
    source_record_id: recordId,
    event_id: kind === "event" ? recordId : clean(fields.event_id, 240) || null,
    document_id: kind === "document" ? recordId : clean(fields.document_id, 240) || null,
    video_id: kind === "video" ? recordId : clean(fields.video_id, 240) || null,
    date,
    meeting_date: date,
    start_at: clean(fields.start_at, 80) || null,
    category: clean(fields.category || fields.type || fields.role, 120) || null,
    title: clean(fields.title || fields.summary || fields.name, 500) || null,
    address: clean(fields.address || fields.location, 500) || null,
    format: clean(fields.format || source?.format || kind, 80) || kind,
    publisher_identifier: ids[0] || null,
    publisher_identifiers: ids,
    publisher_matter_ids: publisherMatterIds,
    record_url: clean(fields.record_url || fields.document_url || fields.video_url || fields.url, 2_000) || null,
    observed_receipt: normalizedReceipt,
  };
  const endAt = clean(fields.end_at, 80);
  const venueName = clean(fields.venue_name || fields.location_name, 300);
  const description = plain(fields.description, 4_000);
  const committee = fields.committee && typeof fields.committee === "object"
    ? { name: clean(fields.committee.name, 300) || null, url: safeUrl(fields.committee.url, sourceUrl) }
    : (clean(fields.committee, 300) ? { name: clean(fields.committee, 300), url: null } : null);
  if (endAt) normalized.end_at = endAt;
  if (venueName) normalized.venue_name = venueName;
  if (clean(fields.mode, 40)) normalized.mode = clean(fields.mode, 40);
  if (description) normalized.description = description;
  if (committee?.name) normalized.committee = committee;
  if (fields.participation && typeof fields.participation === "object") normalized.participation = fields.participation;
  if (fields.organizer && typeof fields.organizer === "object") normalized.organizer = fields.organizer;
  const publisherEventId = clean(fields.publisher_event_id || fields.event_id, 240) || null;
  const meetingKey = clean(fields.meeting_key || fields.meeting_id || fields.canonical_meeting_id, 2_000) || null;
  if (publisherEventId) normalized.publisher_event_id = publisherEventId;
  if (meetingKey) normalized.meeting_key = meetingKey;
  return normalized;
}

function htmlRecords(html, source, receipt = {}) {
  const sourceUrl = explicitUrl(source);
  if (!sourceUrl || !clean(source?.board_id || source?.body_id, 100)) return [];
  const found = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchor)) {
    const tag = match[0];
    let url;
    try { url = new URL(decode(match[2]), sourceUrl); } catch { continue; }
    if (url.protocol !== "https:") continue;
    const title = decode(match[3]);
    const format = (url.pathname.match(/\.([a-z0-9]+)$/i)?.[1] || clean(attribute(tag, "data-format"), 20) || "html").toLowerCase();
    if (!["html", "pdf", "doc", "docx"].includes(format)) continue;
    const explicitRecordId = attribute(tag, "data-record-id") || attribute(tag, "data-document-id") || attribute(tag, "data-event-id");
    const meetingKey = attribute(tag, "data-meeting-id") || attribute(tag, "data-meeting-key");
    const bodyId = attribute(tag, "data-board-id") || attribute(tag, "data-body-id");
    const date = dateFromText(attribute(tag, "data-date") || attribute(tag, "datetime") || `${title} ${url.pathname}`);
    if (!date) continue;
    const role = clean(attribute(tag, "data-category") || attribute(tag, "data-role") || source.role, 120) || null;
    const recordKind = role === "upcoming_meetings" || role === "calendar" ? "event" : "document";
    // A linked document URL is an explicit publisher document identity. It is
    // safe for minutes/documents, but never becomes an event identity.
    const recordId = explicitRecordId || (recordKind === "document" ? url.href : null);
    found.push(record(source, {
      record_kind: recordKind,
      record_id: recordId,
      publisher_identifier: explicitRecordId ? null : (recordKind === "document" ? url.href : null),
      meeting_key: meetingKey,
      board_id: bodyId || source.board_id || source.body_id,
      body_evidence: bodyId ? { board_id: bodyId, basis: "publisher_record" } : bodyEvidence(source),
      date,
      category: role,
      title,
      format,
      record_url: url.href,
    }, receipt));
  }
  return found;
}

function htmlDocumentRecords(html, source, receipt = {}) {
  const sourceUrl = explicitUrl(source);
  const meetingKey = clean(source.meeting_key || source.meeting_id || source.event_id, 2_000) || null;
  const meetingDate = dateFromText(source.meeting_date || source.date || "");
  if (!sourceUrl || !meetingKey) return [];
  const found = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchor)) {
    const url = safeUrl(decode(match[2]), sourceUrl);
    const label = plain(match[3], 300);
    const role = documentRole(label, url);
    if (!url || !role || !/\.(?:pdf|docx?|rtf)(?:$|[?#])/i.test(url)) continue;
    found.push(record(source, {
      record_kind: "document",
      record_id: url,
      document_id: url,
      meeting_key: meetingKey,
      board_id: source.board_id || source.body_id,
      date: meetingDate,
      category: role,
      title: label || role,
      format: url.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1] || "document",
      record_url: url,
    }, receipt));
  }
  return found;
}

function jsonLdEvents(html, source, receipt = {}) {
  const found = [];
  const scripts = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html || "").matchAll(scripts)) {
    let payload;
    try { payload = JSON.parse(match[2].trim()); } catch { continue; }
    const entries = Array.isArray(payload) ? payload : [payload];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const types = Array.isArray(entry["@type"]) ? entry["@type"] : [entry["@type"]];
      if (!types.some((type) => String(type || "").toLowerCase() === "event")) continue;
      const recordUrl = explicitUrl({ url: entry.url || entry["@id"] });
      const publisherIdentifier = clean(
        typeof entry.identifier === "object" ? entry.identifier.value || entry.identifier.name : entry.identifier,
        240,
      ) || recordUrl;
      const location = entry.location && typeof entry.location === "object" ? entry.location : {};
      const address = location.address && typeof location.address === "object"
        ? [location.address.streetAddress, location.address.addressLocality, location.address.addressRegion, location.address.postalCode]
          .filter(Boolean).join(", ")
        : location.address;
      const date = dateFromText(entry.startDate || entry.start_date || "");
      if (!recordUrl || !publisherIdentifier || !date) continue;
      const rawDescription = decode(String(entry.description || ""));
      const pageDescription = source.event_detail
        ? String(html || "").match(/<div\b[^>]*\btribe-events-single-event-description\b[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>|<\/div>)/i)?.[1] || ""
        : "";
      const description = plain(pageDescription || rawDescription, 4_000);
      const describedUrls = [...rawDescription.matchAll(/https:\/\/[^\s<>"]+/gi)].map((match) => match[0].replace(/[),.;]+$/, ""));
      const participationUrls = [...new Set([recordUrl, ...describedUrls])];
      const pageParticipation = source.event_detail ? eventPageParticipation(html, recordUrl) : { links: [], remote_join_url: null };
      const remoteJoinUrl = pageParticipation.remote_join_url
        || participationUrls.find((url) => /zoom|webex|teams|meet\.google|webinar/i.test(url)) || null;
      found.push(record(source, {
        record_kind: "event",
        record_id: publisherIdentifier,
        event_id: publisherIdentifier,
        board_id: source.board_id || source.body_id,
        body_evidence: bodyEvidence(source),
        date,
        start_at: entry.startDate,
        end_at: entry.endDate || entry.end_date,
        mode: /online|video conference|zoom|webex|teams|hybrid/i.test(`${description} ${location.name || ""}`)
          ? "hybrid" : (address ? "in-person" : "not-stated"),
        category: source.role || "upcoming_meetings",
        title: decode(entry.name || entry.headline),
        address: decode(address),
        venue_name: decode(location.name),
        description,
        organizer: entry.organizer,
        participation: {
          links: [...pageParticipation.links, ...participationUrls.slice(0, 4).map((url) => ({ label: /zoom|webex|teams|meet\.google|webinar/i.test(url) ? "Join online" : "Meeting information", url }))]
            .filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index)
            .slice(0, 4),
          remote_join_url: remoteJoinUrl,
          emails: [location.email, entry.organizer?.email].filter(Boolean),
          phones: [location.telephone, entry.organizer?.telephone].filter(Boolean),
          source_url: recordUrl,
        },
        format: "html",
        publisher_identifier: publisherIdentifier,
        meeting_key: entry.meetingId || entry.meeting_id || entry.meetingKey || entry.meeting_key,
        record_url: recordUrl,
      }, receipt));
    }
  }
  return found;
}

export function parseHtmlPdfSource(html, source = {}, options = {}) {
  const descriptor = { ...source, adapter: adapterId(source) || "html_pdf_v1" };
  const receipt = normalizeObservedReceipt(options.receipt || source.observed_receipt || {}, descriptor, { parser: "html_pdf_v1", observed_at: options.observedAt });
  const records = [
    ...jsonLdEvents(html, descriptor, receipt),
    ...(descriptor.event_detail ? htmlDocumentRecords(html, descriptor, receipt) : []),
    ...htmlRecords(html, descriptor, receipt),
  ];
  const seen = new Set();
  return records.filter((row) => row.record_id && row.date).filter((row) => {
    const key = `${row.record_kind}:${row.record_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function explicitCalendarDate(value, pageYear) {
  const withYear = monthDate(value);
  if (withYear) return withYear;
  const match = clean(value, 500).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i);
  if (!match || !/^20\d{2}$/.test(String(pageYear || ""))) return null;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1].toLowerCase()) + 1;
  return iso(`${pageYear}-${month}-${match[2]}`);
}

function calendarStartAt(date, value) {
  const time = clean(value, 500).match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!date || !time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2] || 0);
  const meridiem = time[3].replace(/\./g, "").toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
    hour: "2-digit",
  }).formatToParts(new Date(`${date}T12:00:00Z`)).find((part) => part.type === "timeZoneName")?.value;
  const offset = String(zone || "").match(/^GMT([+-]\d{2}:\d{2})$/)?.[1];
  return offset ? `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}` : null;
}

function htmlLines(value) {
  return String(value || "").split(/<br\b[^>]*>/i).map((part) => plain(part, 800)).filter(Boolean);
}

function calendarVenue(lines = []) {
  const first = lines[0] || "";
  const afterSeparator = first.match(/\s--\s(.+)$/)?.[1];
  if (afterSeparator) return clean(afterSeparator, 500);
  const next = lines[1] || "";
  return /^(?:limited seating|this is|members of|online|registration|by phone|you must)/i.test(next)
    ? null
    : clean(next, 500) || null;
}

function calendarRecordId(source, date, title) {
  const slug = clean(title, 300).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
  const boardId = clean(source?.board_id || source?.body_id, 100);
  return boardId && date && slug ? `nyc-calendar:${boardId}:${date}:${slug}` : null;
}

function officialCalendarTitleFromProse(text) {
  const value = clean(text, 500);
  const stripped = value
    .replace(/\s+[–—-]\s+\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b[\s\S]*$/i, "")
    .replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}[\s\S]*$/i, "")
    .replace(/,?\s+\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\s*$/i, "")
    .trim();
  return stripped || null;
}

function officialCalendarBlocks(html, pageYear) {
  const calendarHtml = String(html || "").match(/<div\b[^>]*\babout-description\b[^>]*>([\s\S]*?)<\/div>/i)?.[1]
    || String(html || "");
  const blocks = [];
  const headings = /<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|$)/gi;
  for (const match of calendarHtml.matchAll(headings)) {
    const title = plain(match[1], 500);
    const paragraph = match[2].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    const lines = htmlLines(paragraph);
    const logistics = lines[0] || "";
    blocks.push({
      title,
      logistics,
      lines,
      bodyHtml: match[2],
    });
  }
  if (blocks.some((block) => {
    const date = explicitCalendarDate(block.logistics, pageYear);
    return Boolean(block.title && date && calendarStartAt(date, block.logistics));
  })) {
    return blocks;
  }
  // Some NYC-hosted calendars publish one dated meeting in a paragraph
  // rather than an h3. Require a meeting word and a clock time so a
  // next-hearing sentence without publisher event identity stays out.
  const paragraphs = [...calendarHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const text = plain(paragraphs[index][1], 500);
    if (!/\bmeetings?\b|\bhearings?\b|\bsessions?\b/i.test(text)) continue;
    const date = explicitCalendarDate(text, pageYear);
    if (!date || !calendarStartAt(date, text)) continue;
    const title = officialCalendarTitleFromProse(text);
    if (!title) continue;
    const following = paragraphs.slice(index, index + 4).map((row) => row[0]).join("");
    blocks.push({
      title,
      logistics: text,
      lines: htmlLines(paragraphs[index][1]),
      bodyHtml: following,
    });
  }
  return blocks;
}

export function parseNycOfficialCalendarSource(html, source = {}, options = {}) {
  const descriptor = { ...source, adapter: "nyc_official_calendar_v1" };
  const sourceUrl = explicitUrl(descriptor);
  const receipt = normalizeObservedReceipt(options.receipt || source.observed_receipt || {}, descriptor, {
    parser: "nyc_official_calendar_v1",
    observed_at: options.observedAt,
  });
  if (!sourceUrl || !clean(descriptor.board_id || descriptor.body_id, 100)) return [];
  const pageYear = String(html || "").match(/Calendar\s+of\s+Meetings[\s\S]{0,120}?\b(20\d{2})\b/i)?.[1] || null;
  const found = [...jsonLdEvents(html, descriptor, receipt)];
  for (const block of officialCalendarBlocks(html, pageYear)) {
    const date = explicitCalendarDate(block.logistics, pageYear);
    const startAt = calendarStartAt(date, block.logistics);
    const recordId = calendarRecordId(descriptor, date, block.title);
    if (!block.title || !date || !startAt || !recordId) continue;
    const participation = eventPageParticipation(block.bodyHtml, sourceUrl);
    found.push(record(descriptor, {
      record_kind: "event",
      record_id: recordId,
      board_id: descriptor.board_id || descriptor.body_id,
      date,
      start_at: startAt,
      category: descriptor.role || descriptor.source_role || "upcoming_meetings",
      title: block.title,
      address: calendarVenue(block.lines),
      mode: participation.remote_join_url ? "hybrid" : "not-stated",
      participation: { ...participation, emails: [], phones: [], source_url: sourceUrl },
      format: "html",
      record_url: sourceUrl,
    }, receipt));
  }
  const seen = new Set();
  return found.filter((row) => row.record_id && row.date).filter((row) => {
    const key = `${row.record_kind}:${row.record_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unfoldIcs(value) {
  return String(value || "").replace(/\r?\n[ \t]/g, "");
}

function icsDateParts(value) {
  const raw = clean(value, 80).replace(/^.*:/, "");
  return raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
}

function icsDate(value) {
  const match = icsDateParts(value);
  return match ? iso(`${match[1]}-${match[2]}-${match[3]}`) : null;
}

function icsStartAt(value) {
  const match = icsDateParts(value);
  if (!match || !match[4]) return null;
  const date = iso(`${match[1]}-${match[2]}-${match[3]}`);
  const clock = `${match[4]}:${match[5]}:${match[6]}`;
  if (match[7]) return `${date}T${clock}Z`;
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
    hour: "2-digit",
  }).formatToParts(new Date(`${date}T12:00:00Z`)).find((part) => part.type === "timeZoneName")?.value;
  const offset = String(zone || "").match(/^GMT([+-]\d{2}:\d{2})$/)?.[1];
  return offset ? `${date}T${clock}${offset}` : `${date}T${clock}`;
}

function icsValue(line) {
  const text = String(line || "");
  const colon = text.indexOf(":");
  return colon >= 0 ? decode(text.slice(colon + 1).replace(/\\n/g, "\n").replace(/\\,/g, ",")) : null;
}

function icsField(block, name) {
  const line = block.split(/\r?\n/).find((entry) => entry.toUpperCase().startsWith(`${name.toUpperCase()}:`) || entry.toUpperCase().startsWith(`${name.toUpperCase()};`));
  return line ? icsValue(line) : null;
}

function icsInstanceId(uid, date) {
  const id = clean(uid, 240);
  return id && date ? `${id}::${date}` : id || null;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#038;/g, "&")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function decodeBase64(value) {
  const raw = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  if (!raw) return null;
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return null;
  try {
    const binary = typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("latin1");
    return binary || null;
  } catch {
    return null;
  }
}

function isGoogleCalendarId(value) {
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(clean(value, 300));
}

export function normalizeGoogleCalendarId(value) {
  const raw = clean(decodeHtmlEntities(value), 500);
  if (!raw) return null;
  let candidate = raw;
  try { candidate = decodeURIComponent(raw); } catch { candidate = raw; }
  if (isGoogleCalendarId(candidate)) return candidate;
  const decoded = decodeBase64(candidate);
  return isGoogleCalendarId(decoded) ? decoded : null;
}

export function googleCalendarPublicIcsUrl(calendarId) {
  const id = normalizeGoogleCalendarId(calendarId);
  return id ? `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics` : null;
}

export function googleCalendarIdsFromHtml(html) {
  const text = decodeHtmlEntities(html);
  const ids = new Set();
  const snippets = text.match(/https?:\/\/(?:www\.)?calendar\.google\.com\/[^"'<\s]+/gi) || [];
  for (const snippet of snippets) {
    let url;
    try { url = new URL(snippet); } catch { continue; }
    for (const key of ["src", "cid"]) {
      for (const value of url.searchParams.getAll(key)) {
        const id = normalizeGoogleCalendarId(value);
        if (id) ids.add(id);
      }
    }
    const ical = url.pathname.match(/\/calendar\/ical\/([^/]+)\/public\/basic\.ics/i);
    if (ical) {
      const id = normalizeGoogleCalendarId(decodeURIComponent(ical[1]));
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function looksLikeIcalendar(text, contentType) {
  return /BEGIN:VCALENDAR/i.test(String(text || "")) || /text\/calendar/i.test(String(contentType || ""));
}

function dedupeSourceRecords(records) {
  const seen = new Set();
  return records.filter((row) => {
    const key = `${row.record_kind}:${row.record_id}`;
    if (!row.record_id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function upcomingCalendarFloor(source, options = {}) {
  const role = clean(source?.role || source?.source_role || source?.source_type, 80).toLowerCase();
  if (role !== "upcoming_meetings") return null;
  const asOf = dateFromText(options.observedAt || options.receipt?.observed_at || source?.observed_receipt?.observed_at);
  if (!asOf) return null;
  const floor = new Date(`${asOf}T00:00:00Z`);
  if (Number.isNaN(floor.getTime())) return null;
  floor.setUTCDate(floor.getUTCDate() - 90);
  return floor.toISOString().slice(0, 10);
}

export function parseGoogleCalendarSource(ics, source = {}, options = {}) {
  const receipt = normalizeObservedReceipt(options.receipt || source.observed_receipt || {}, source, { parser: "google_calendar_v1", observed_at: options.observedAt });
  const floor = upcomingCalendarFloor(source, { ...options, receipt });
  const seen = new Set();
  return unfoldIcs(ics).split(/BEGIN:VEVENT/i).slice(1).flatMap((chunk) => {
    const block = chunk.split(/END:VEVENT/i)[0];
    const uid = icsField(block, "UID");
    const date = icsDate(icsField(block, "DTSTART"));
    const instanceId = icsInstanceId(uid, date);
    if (!uid || !date || !instanceId) return [];
    if (floor && date < floor) return [];
    if (seen.has(instanceId)) return [];
    seen.add(instanceId);
    const bodyId = icsField(block, "X-BOARD-ID") || icsField(block, "X-BODY-ID") || source.board_id || source.body_id;
    return [record(source, {
      record_kind: "event",
      record_id: instanceId,
      event_id: instanceId,
      board_id: bodyId,
      body_evidence: bodyId ? { board_id: bodyId, basis: icsField(block, "X-BOARD-ID") || icsField(block, "X-BODY-ID") ? "publisher_record" : "explicit_source_descriptor" } : null,
      date,
      start_at: icsStartAt(icsField(block, "DTSTART")),
      category: icsField(block, "CATEGORIES"),
      title: icsField(block, "SUMMARY"),
      address: icsField(block, "LOCATION"),
      description: icsField(block, "DESCRIPTION"),
      participation: {
        links: icsField(block, "URL") ? [{ label: "Meeting information", url: icsField(block, "URL") }] : [],
        remote_join_url: null,
        emails: [],
        phones: [],
        source_url: source.record_url || source.url || source.source_url,
      },
      format: "ics",
      publisher_identifier: instanceId,
      publisher_event_id: uid,
      record_url: source.record_url || source.url || source.source_url,
    }, receipt)];
  });
}

const PDF_MONTHS = Object.freeze([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]);
const PDF_WEEKDAYS = Object.freeze(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
const PDF_MEETING_IDENTITY = /\b(?:full board|general board|public hearing|executive board|executive committee|board meeting)\b/i;
const PDF_TIME_QUALIFIER = /\b(?:usually|generally|typically|unless otherwise|if necessary)\b/i;
const PDF_NON_MEETING = /\b(?:office closed|labor day|columbus day|election day|veterans['’]? day|thanksgiving|yom kippur|rosh hashanah|nypd|precinct council|book exchange|pantry)\b/i;
const MAX_PDF_CALENDARS = 8;

function pdfNewYorkDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return dateFromText(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function pdfUpcomingFloor(source, options = {}) {
  const role = clean(source?.role || source?.source_role || source?.source_type, 80).toLowerCase();
  if (role !== "upcoming_meetings") return null;
  return pdfNewYorkDate(options.observedAt || options.receipt?.observed_at || source?.observed_receipt?.observed_at || "");
}

function pdfMonthIndex(value) {
  const month = PDF_MONTHS.indexOf(clean(value, 40).toLowerCase());
  return month >= 0 ? month + 1 : null;
}

function pdfMonthYear(text) {
  const titled = String(text || "").match(/\b(?:tentative\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\s*(?:calendar)?\b/i)
    || String(text || "").match(/\b(20\d{2})\s+board meeting schedule\b/i);
  if (!titled) return null;
  if (titled[1] && /^20\d{2}$/.test(titled[1]) && !titled[2]) return { year: Number(titled[1]), month: null };
  const month = pdfMonthIndex(titled[1]);
  const year = Number(titled[2]);
  return month && year ? { month, year } : (year ? { month: null, year } : null);
}

function pdfMeetingTitle(value) {
  const text = clean(value, 400);
  if (!text || PDF_NON_MEETING.test(text)) return null;
  const match = text.match(PDF_MEETING_IDENTITY);
  if (!match) return null;
  const start = Math.max(0, text.toLowerCase().indexOf(match[0].toLowerCase()) - 24);
  const slice = text.slice(start, start + 160)
    .replace(/\bclick here\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
  const named = slice.match(/\b((?:full board|general board|public hearing|executive board|executive committee|board meeting)(?:\s*(?:and|&)\s*(?:full board|public hearing))?)\b/i);
  const title = clean(named?.[1] || match[0], 160);
  return title || null;
}

function pdfRecordId(source, date, title) {
  const slug = clean(title, 300).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
  const boardId = clean(source?.board_id || source?.body_id, 100);
  return boardId && date && slug ? `pdf-calendar:${boardId}:${date}:${slug}` : null;
}

function pdfCivilWeekday(date) {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

function pdfIsoDate(year, month, day) {
  if (!year || !month || !day || day < 1 || day > 31) return null;
  return iso(`${year}-${month}-${day}`);
}

function decodePdfString(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)))
    .replace(/\\([()\\])/g, "$1");
}

export function extractPdfTextFromBytes(bytes) {
  const raw = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : bytes instanceof Uint8Array
      ? bytes
      : new TextEncoder().encode(String(bytes || ""));
  if (raw.length < 5) return "";
  const latin = new TextDecoder("latin1").decode(raw);
  if (!latin.startsWith("%PDF")) return "";
  const strings = [];
  for (const token of latin.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|\[(?:\s*\((?:\\.|[^\\)])*\)\s*-?\d*)+\]\s*TJ/g)) {
    for (const part of token[0].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      strings.push(decodePdfString(part[0].slice(1, -1)));
    }
  }
  return strings.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function pdfCalendarLinksFromHtml(html, sourceUrl) {
  const found = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchor)) {
    const url = safeUrl(decode(match[2]), sourceUrl);
    const label = plain(match[3], 200);
    if (!url || !/\.pdf(?:$|[?#])/i.test(url)) continue;
    const blob = `${label} ${url}`.toLowerCase();
    if (/\bminutes?\b|memorandum of meeting/.test(blob)) continue;
    const score = pdfCalendarLinkScore(blob);
    if (score <= 0) continue;
    found.push({ url, label, score });
  }
  return [...new Map(found.sort((left, right) => right.score - left.score || left.url.localeCompare(right.url)).map((row) => [row.url, row])).values()]
    .slice(0, MAX_PDF_CALENDARS);
}

function pdfCalendarLinkScore(blob) {
  const text = String(blob || "");
  if (/\bminutes?\b|memorandum of meeting/.test(text)) return -10;
  let score = 0;
  if (/calendar|schedule/.test(text)) score += 5;
  if (/agenda/.test(text)) score += 3;
  if (/full.?board|monthly|meeting/.test(text)) score += 2;
  const year = text.match(/\b(202[6-9]|203\d)\b/);
  if (year) score += 4;
  const month = PDF_MONTHS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(text));
  if (month >= 0) score += month >= 7 ? 8 + month : 2 + month;
  if (!score && /\.pdf(?:$|[?#])/.test(text)) score = 1;
  return score;
}

function pdfWeekdayColumns(line) {
  const lower = String(line || "").toLowerCase();
  const cols = [];
  let cursor = 0;
  for (const name of PDF_WEEKDAYS) {
    const index = lower.indexOf(name, cursor);
    if (index < 0) return null;
    cols.push({ name, index, weekday: cols.length });
    cursor = index + name.length;
  }
  return cols.length === 7 ? cols : null;
}

function pdfColumnBounds(cols, width) {
  return cols.map((col, index) => {
    const start = index === 0 ? 0 : Math.floor((cols[index - 1].index + col.index) / 2);
    const end = index === cols.length - 1 ? Math.max(width, col.index + 12) : Math.floor((col.index + cols[index + 1].index) / 2);
    return { ...col, start, end };
  });
}

function pdfDayNumberLine(cells) {
  const days = cells.filter((cell) => /^\s*(?:[1-9]|[12]\d|3[01])\s*$/.test(cell) || /^\s*(?:[1-9]|[12]\d|3[01])\b/.test(cell));
  const times = cells.filter((cell) => /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*[ap]\.?m\.?\b/i.test(cell));
  return days.length >= 3 && times.length === 0;
}

function pdfCellDay(cell) {
  const match = String(cell || "").match(/^\s*([1-9]|[12]\d|3[01])\b/);
  return match ? Number(match[1]) : null;
}

function pdfGridMeetings(text, monthYear) {
  if (!monthYear?.month || !monthYear?.year) return [];
  const lines = String(text || "").split(/\n/);
  let bounds = null;
  const weeks = [];
  let current = null;
  const flush = () => {
    if (current) weeks.push(current);
    current = null;
  };
  for (const line of lines) {
    const cols = pdfWeekdayColumns(line);
    if (cols) {
      flush();
      bounds = pdfColumnBounds(cols, Math.max(line.length, 120));
      continue;
    }
    if (!bounds) continue;
    const padded = line.padEnd(bounds[bounds.length - 1].end, " ");
    const cells = bounds.map((col) => padded.slice(col.start, col.end));
    if (pdfDayNumberLine(cells)) {
      flush();
      current = cells.map((cell, index) => ({ weekday: index, parts: [cell] }));
      continue;
    }
    if (current) current.forEach((column, index) => column.parts.push(cells[index]));
  }
  flush();
  const found = [];
  for (const week of weeks) {
    for (const column of week) {
      const body = column.parts.join("\n");
      const day = pdfCellDay(column.parts[0]) || pdfCellDay(body);
      const date = pdfIsoDate(monthYear.year, monthYear.month, day);
      if (!date || pdfCivilWeekday(date) !== column.weekday) continue;
      const title = pdfMeetingTitle(body);
      const startAt = calendarStartAt(date, body);
      if (!title || !startAt || PDF_TIME_QUALIFIER.test(body)) continue;
      found.push({ date, startAt, title, address: calendarVenue(body.split(/\n/).map((line) => clean(line, 200)).filter(Boolean)) });
    }
  }
  return found;
}

function pdfLinearMeetings(text, monthYear) {
  const lines = String(text || "").split(/\n/);
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + 8).join("\n");
    if (PDF_TIME_QUALIFIER.test(window)) continue;
    const date = monthDate(window) || (monthYear?.year ? explicitCalendarDate(window, String(monthYear.year)) : null);
    const title = pdfMeetingTitle(window);
    const startAt = calendarStartAt(date, window);
    if (!date || !title || !startAt) continue;
    found.push({
      date,
      startAt,
      title,
      address: calendarVenue(window.split(/\n/).map((line) => clean(line, 200)).filter(Boolean)),
    });
  }
  return found;
}

function looksLikePdfBytes(payload, contentType) {
  if (/application\/pdf/i.test(String(contentType || ""))) return true;
  const head = typeof payload === "string"
    ? payload.slice(0, 5)
    : new TextDecoder("latin1").decode((payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload).slice(0, 5));
  return head === "%PDF-";
}

export function parsePdfCalendarSource(text, source = {}, options = {}) {
  const descriptor = { ...source, adapter: "pdf_calendar_v1" };
  const sourceUrl = explicitUrl(descriptor);
  const receipt = normalizeObservedReceipt(options.receipt || source.observed_receipt || {}, descriptor, {
    parser: "pdf_calendar_v1",
    observed_at: options.observedAt,
  });
  if (!sourceUrl || !clean(descriptor.board_id || descriptor.body_id, 100) || !String(text || "").trim()) return [];
  const monthYear = pdfMonthYear(text);
  const floor = pdfUpcomingFloor(descriptor, { ...options, receipt });
  const candidates = [
    ...pdfLinearMeetings(text, monthYear),
    ...pdfGridMeetings(text, monthYear),
  ];
  const found = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (floor && candidate.date < floor) continue;
    const recordId = pdfRecordId(descriptor, candidate.date, candidate.title);
    if (!recordId || seen.has(recordId)) continue;
    seen.add(recordId);
    found.push(record(descriptor, {
      record_kind: "event",
      record_id: recordId,
      event_id: recordId,
      board_id: descriptor.board_id || descriptor.body_id,
      date: candidate.date,
      start_at: candidate.startAt,
      category: descriptor.role || descriptor.source_role || "upcoming_meetings",
      title: candidate.title,
      address: candidate.address,
      format: "pdf",
      publisher_identifier: recordId,
      publisher_event_id: recordId,
      record_url: descriptor.record_url || sourceUrl,
    }, receipt));
  }
  return found;
}

async function harvestPdfCalendarRecords(payload, contentType, source, { fetchImpl, observedAt, receipt, limit, extractPdfText } = {}) {
  const extract = typeof extractPdfText === "function" ? extractPdfText : extractPdfTextFromBytes;
  const records = [];
  const ingest = async (bytes, recordUrl) => {
    const text = await extract(bytes);
    if (!clean(text, 80)) return;
    records.push(...parsePdfCalendarSource(text, { ...source, record_url: recordUrl }, { observedAt, receipt }));
  };
  if (looksLikePdfBytes(payload, contentType)) {
    const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    await ingest(bytes, source.record_url || source.url);
    return dedupeSourceRecords(records);
  }
  const html = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  for (const link of pdfCalendarLinksFromHtml(html, explicitUrl(source))) {
    if (typeof fetchImpl !== "function") continue;
    try {
      const response = await fetchImpl(link.url, { method: "GET", credentials: "omit", redirect: "follow" });
      if (!response?.ok) continue;
      const bytes = response.arrayBuffer ? await response.arrayBuffer() : new TextEncoder().encode(await response.text()).buffer;
      if (bytes.byteLength > (limit || 3_000_000)) continue;
      await ingest(bytes, link.url);
    } catch {
      continue;
    }
  }
  return dedupeSourceRecords(records);
}

function jsonInput(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" ? value : null;
}

function fieldValue(fields, map, key) {
  const field = map?.[key] || key;
  return fields?.[field];
}

export function parseAirtableSource(payload, source = {}, options = {}) {
  const receipt = normalizeObservedReceipt(options.receipt || source.observed_receipt || {}, source, { parser: "airtable_v1", observed_at: options.observedAt });
  const input = jsonInput(payload);
  const records = Array.isArray(input) ? input : Array.isArray(input?.records) ? input.records : [];
  const map = source.field_map || source.fieldMap || {};
  return records.flatMap((entry) => {
    const fields = entry?.fields && typeof entry.fields === "object" ? entry.fields : entry;
    const id = clean(entry?.id || fieldValue(fields, map, "record_id"), 240);
    const date = dateFromText(fieldValue(fields, map, "date") || fieldValue(fields, map, "meeting_date"));
    if (!id || !date) return [];
    const bodyId = clean(fieldValue(fields, map, "board_id") || source.board_id || source.body_id, 100) || null;
    return [record(source, {
      record_kind: clean(fieldValue(fields, map, "record_kind") || source.record_kind, 40) || "document",
      record_id: id,
      board_id: bodyId,
      body_evidence: bodyId ? { board_id: bodyId, basis: fieldValue(fields, map, "board_id") ? "publisher_record" : "explicit_source_descriptor" } : null,
      date,
      category: fieldValue(fields, map, "category"),
      title: fieldValue(fields, map, "title"),
      address: fieldValue(fields, map, "address"),
      venue_name: fieldValue(fields, map, "venue_name"),
      description: fieldValue(fields, map, "description"),
      end_at: fieldValue(fields, map, "end_at"),
      committee: fieldValue(fields, map, "committee"),
      publisher_identifier: fieldValue(fields, map, "publisher_identifier"),
      publisher_event_id: fieldValue(fields, map, "publisher_event_id"),
      meeting_key: fieldValue(fields, map, "meeting_id") || fieldValue(fields, map, "meeting_key"),
      publisher_matter_ids: Array.isArray(fieldValue(fields, map, "publisher_matter_ids")) ? fieldValue(fields, map, "publisher_matter_ids") : [],
      format: "airtable",
      record_url: fieldValue(fields, map, "record_url") || source.url || source.source_url,
    }, receipt)];
  });
}

export function parseVideoRecordSource(payload, source = {}, options = {}) {
  const receipt = normalizeObservedReceipt(options.receipt || source.observed_receipt || {}, source, { parser: "video_record_v1", observed_at: options.observedAt });
  const input = jsonInput(payload);
  const records = Array.isArray(input) ? input : Array.isArray(input?.records) ? input.records : [];
  return records.flatMap((entry) => {
    const id = clean(entry?.video_id || entry?.record_id || entry?.id, 240);
    const date = dateFromText(entry?.date || entry?.meeting_date || entry?.published_at);
    const bodyId = clean(entry?.board_id || entry?.body_id || source.board_id || source.body_id, 100) || null;
    if (!id || !date) return [];
    return [record(source, {
      record_kind: "video",
      record_id: id,
      video_id: id,
      board_id: bodyId,
      body_evidence: bodyId ? { board_id: bodyId, basis: entry?.board_id || entry?.body_id ? "publisher_record" : "explicit_source_descriptor" } : null,
      date,
      category: entry?.category || "Board meeting video",
      title: entry?.title || entry?.name,
      venue_name: entry?.venue_name || entry?.location_name,
      description: entry?.description,
      end_at: entry?.end_at || entry?.end_date,
      committee: entry?.committee,
      publisher_identifier: entry?.publisher_identifier || entry?.event_id,
      publisher_event_id: entry?.publisher_event_id || entry?.event_id,
      format: "video",
      record_url: entry?.url || entry?.video_url || source.url || source.source_url,
    }, receipt)];
  });
}

export function parseCommunityBoardSource(payload, source = {}, options = {}) {
  const adapter = adapterId(source);
  if (adapter === "html_pdf_v1") return parseHtmlPdfSource(payload, source, options);
  if (adapter === "nyc_official_calendar_v1") return parseNycOfficialCalendarSource(payload, source, options);
  if (adapter === "google_calendar_v1") return parseGoogleCalendarSource(payload, source, options);
  if (adapter === "pdf_calendar_v1") return parsePdfCalendarSource(payload, source, options);
  if (adapter === "airtable_v1") return parseAirtableSource(payload, source, options);
  if (adapter === "video_record_v1") return parseVideoRecordSource(payload, source, options);
  return [];
}

async function harvestGoogleCalendarRecords(text, contentType, source, { fetchImpl, observedAt, receipt, limit } = {}) {
  if (looksLikeIcalendar(text, contentType)) {
    return parseGoogleCalendarSource(text, source, { observedAt, receipt });
  }
  const records = [];
  for (const calendarId of googleCalendarIdsFromHtml(text)) {
    const icsUrl = googleCalendarPublicIcsUrl(calendarId);
    if (!icsUrl || typeof fetchImpl !== "function") continue;
    try {
      const response = await fetchImpl(icsUrl, { method: "GET", credentials: "omit", redirect: "follow" });
      if (!response?.ok || Number(response.status) === 404) continue;
      const bytes = response.arrayBuffer
        ? await response.arrayBuffer()
        : new TextEncoder().encode(await response.text()).buffer;
      if (bytes.byteLength > (limit || 1_000_000)) continue;
      const icsText = new TextDecoder().decode(bytes);
      if (!looksLikeIcalendar(icsText, response?.headers?.get?.("content-type"))) continue;
      records.push(...parseGoogleCalendarSource(icsText, { ...source, record_url: icsUrl }, { observedAt, receipt }));
    } catch {
      continue;
    }
  }
  return dedupeSourceRecords(records);
}

export async function fetchCommunityBoardSource(source = {}, { fetchImpl = globalThis.fetch, observedAt = new Date().toISOString(), maxBytes = null, extractPdfText = null } = {}) {
  const contract = sourceAdapterContract(source);
  const url = explicitUrl(source);
  const limit = Math.min(Number(maxBytes) || contract?.max_bytes || 1_000_000, contract?.max_bytes || 1_000_000);
  const baseReceipt = { observed_at: observedAt, parser: adapterId(source), source_url: url };
  if (!contract || !url || typeof fetchImpl !== "function") {
    return { records: [], receipt: normalizeObservedReceipt({ ...baseReceipt, reason: "source_contract_unavailable" }, source) };
  }
  const fetchUrls = [url];
  if ((adapterId(source) === "nyc_official_calendar_v1" || adapterId(source) === "pdf_calendar_v1") && /^https:\/\/www\.nyc\.gov\//i.test(url)) {
    fetchUrls.push(url.replace(/^https:\/\/www\.nyc\.gov\//i, "https://www1.nyc.gov/"));
  }
  let lastReceipt = null;
  for (const fetchUrl of fetchUrls) {
    try {
      const response = await fetchImpl(fetchUrl, { method: "GET", credentials: "omit", redirect: "follow" });
      const contentType = response?.headers?.get?.("content-type") || null;
      const bytes = response?.arrayBuffer
        ? await response.arrayBuffer()
        : new TextEncoder().encode(await response.text()).buffer;
      const length = bytes.byteLength;
      const text = new TextDecoder().decode(bytes);
      const accessDenied = /<h1>\s*Access Denied\s*<\/h1>/i.test(text);
      const receipt = normalizeObservedReceipt({
        ...baseReceipt,
        status: response.ok && length <= limit && !accessDenied ? "ok" : "unknown",
        fetch_status: String(response.status || ""),
        content_type: contentType,
        content_length: length,
        reason: !response.ok ? "http_error" : length > limit ? "byte_limit_exceeded" : accessDenied ? "access_denied" : null,
      }, source);
      lastReceipt = receipt;
      if (!response.ok || length > limit || accessDenied) continue;
      const adapter = adapterId(source);
      const records = adapter === "google_calendar_v1"
        ? await harvestGoogleCalendarRecords(text, contentType, source, { fetchImpl, observedAt, receipt, limit })
        : adapter === "pdf_calendar_v1"
          ? await harvestPdfCalendarRecords(looksLikePdfBytes(bytes, contentType) ? bytes : text, contentType, source, {
            fetchImpl, observedAt, receipt, limit, extractPdfText,
          })
        : parseCommunityBoardSource(text, source, { observedAt, receipt });
      return { records, receipt };
    } catch (error) {
      lastReceipt = normalizeObservedReceipt({ ...baseReceipt, reason: clean(error?.name || "fetch_error", 80) }, source);
    }
  }
  return { records: [], receipt: lastReceipt || normalizeObservedReceipt({ ...baseReceipt, reason: "fetch_error" }, source) };
}

export function sourceRecordStatus(record, { asOf = new Date().toISOString(), maxAgeDays = 120 } = {}) {
  const receipt = record?.observed_receipt;
  if (!receipt || receipt.status !== "ok" || !receipt.observed_at) return { state: "unknown", reason: "receipt_unavailable" };
  const observed = new Date(receipt.observed_at);
  const current = new Date(asOf);
  if (Number.isNaN(observed.getTime()) || Number.isNaN(current.getTime())) return { state: "unknown", reason: "receipt_date_invalid" };
  const age = Math.floor((current - observed) / 86400000);
  if (age < 0 || age > maxAgeDays) return { state: "unknown", reason: "source_stale" };
  return { state: "observed", reason: null };
}

export const normalizeSourceRecord = record;
export const parseHtmlPdfIndex = parseHtmlPdfSource;
export const parseNycOfficialCalendarRecords = parseNycOfficialCalendarSource;
export const parseGoogleCalendarRecords = parseGoogleCalendarSource;
export const parsePdfCalendarRecords = parsePdfCalendarSource;
export const parseAirtableRecords = parseAirtableSource;
export const parseVideoRecords = parseVideoRecordSource;
