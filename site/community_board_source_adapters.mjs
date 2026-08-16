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
    contract: "explicit iCalendar feed; UID, DTSTART, and board evidence are required for a usable event",
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
  const calendarHtml = String(html || "").match(/<div\b[^>]*\babout-description\b[^>]*>([\s\S]*?)<\/div>/i)?.[1]
    || String(html || "");
  const headings = /<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|$)/gi;
  for (const match of calendarHtml.matchAll(headings)) {
    const title = plain(match[1], 500);
    const paragraph = match[2].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    const lines = htmlLines(paragraph);
    const logistics = lines[0] || "";
    const date = explicitCalendarDate(logistics, pageYear);
    const startAt = calendarStartAt(date, logistics);
    const recordId = calendarRecordId(descriptor, date, title);
    if (!title || !date || !startAt || !recordId) continue;
    const participation = eventPageParticipation(match[2], sourceUrl);
    found.push(record(descriptor, {
      record_kind: "event",
      record_id: recordId,
      board_id: descriptor.board_id || descriptor.body_id,
      date,
      start_at: startAt,
      category: descriptor.role || descriptor.source_role || "upcoming_meetings",
      title,
      address: calendarVenue(lines),
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

function icsDate(value) {
  const raw = clean(value, 80).replace(/^.*:/, "");
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  return match ? iso(`${match[1]}-${match[2]}-${match[3]}`) : null;
}

function icsField(block, name) {
  const line = block.split(/\r?\n/).find((entry) => entry.toUpperCase().startsWith(`${name.toUpperCase()}:`) || entry.toUpperCase().startsWith(`${name.toUpperCase()};`));
  return line ? decode(line.slice(line.indexOf(":") + 1).replace(/\\n/g, "\n").replace(/\\,/g, ",")) : null;
}

export function parseGoogleCalendarSource(ics, source = {}, options = {}) {
  const receipt = normalizeObservedReceipt(options.receipt || source.observed_receipt || {}, source, { parser: "google_calendar_v1", observed_at: options.observedAt });
  return unfoldIcs(ics).split(/BEGIN:VEVENT/i).slice(1).flatMap((chunk) => {
    const block = chunk.split(/END:VEVENT/i)[0];
    const uid = icsField(block, "UID");
    const date = icsDate(icsField(block, "DTSTART"));
    if (!uid || !date) return [];
    const bodyId = icsField(block, "X-BOARD-ID") || icsField(block, "X-BODY-ID") || source.board_id || source.body_id;
    return [record(source, {
      record_kind: "event",
      record_id: uid,
      event_id: uid,
      board_id: bodyId,
      body_evidence: bodyId ? { board_id: bodyId, basis: icsField(block, "X-BOARD-ID") || icsField(block, "X-BODY-ID") ? "publisher_record" : "explicit_source_descriptor" } : null,
      date,
      start_at: icsField(block, "DTSTART"),
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
      publisher_identifier: uid,
      record_url: source.record_url || source.url || source.source_url,
    }, receipt)];
  });
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
  if (adapter === "airtable_v1") return parseAirtableSource(payload, source, options);
  if (adapter === "video_record_v1") return parseVideoRecordSource(payload, source, options);
  return [];
}

export async function fetchCommunityBoardSource(source = {}, { fetchImpl = globalThis.fetch, observedAt = new Date().toISOString(), maxBytes = null } = {}) {
  const contract = sourceAdapterContract(source);
  const url = explicitUrl(source);
  const limit = Math.min(Number(maxBytes) || contract?.max_bytes || 1_000_000, contract?.max_bytes || 1_000_000);
  const baseReceipt = { observed_at: observedAt, parser: adapterId(source), source_url: url };
  if (!contract || !url || typeof fetchImpl !== "function") {
    return { records: [], receipt: normalizeObservedReceipt({ ...baseReceipt, reason: "source_contract_unavailable" }, source) };
  }
  const fetchUrls = [url];
  if (adapterId(source) === "nyc_official_calendar_v1" && /^https:\/\/www\.nyc\.gov\//i.test(url)) {
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
      return { records: parseCommunityBoardSource(text, source, { observedAt, receipt }), receipt };
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
export const parseAirtableRecords = parseAirtableSource;
export const parseVideoRecords = parseVideoRecordSource;
