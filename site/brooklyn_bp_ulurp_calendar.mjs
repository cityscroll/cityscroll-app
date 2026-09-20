import {
  normalizePublicBodyCalendarMeeting,
  publicBodyCalendarIdentity,
} from "./public_body_calendar_contract.mjs";

export const BROOKLYN_BP_ULURP_CALENDAR_SCHEMA = "cityscroll.brooklyn_bp_ulurp_calendar.v1";
export const BROOKLYN_BP_ULURP_SOURCE_CONTRACT_ID = "brooklyn_bp_ulurp";
export const BROOKLYN_BP_ULURP_SOURCE_URL = "https://www.brooklynbp.nyc.gov/events/list/";
export const BROOKLYN_BP_ULURP_CALENDAR_SOURCE_URL = BROOKLYN_BP_ULURP_SOURCE_URL;
export const BROOKLYN_BP_ULURP_LAND_USE_URL = "https://www.brooklynbp.nyc.gov/land-use/";
export const BROOKLYN_BP_ULURP_LAND_USE_SOURCE_URL = BROOKLYN_BP_ULURP_LAND_USE_URL;
export const BROOKLYN_BP_ULURP_CALENDAR_PARSER = "brooklyn_bp_ulurp_calendar_v1";
export const BROOKLYN_BP_ULURP_INSTITUTION_REF = "borough-president:brooklyn:land-use";
export const BROOKLYN_BP_ULURP_TIMEZONE = "America/New_York";
export const BROOKLYN_BP_ULURP_CLASSIFICATION = "ulurp_public_hearing";
export const BROOKLYN_BP_ULURP_VENUE = Object.freeze({
  name: "Brooklyn Borough Hall",
  address: "209 Joralemon Street, Brooklyn, New York 11201",
});

const MONTHS = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
});
const MONTH_PATTERN = Object.keys(MONTHS).join("|");
const DATE_PATTERN = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "i");
const ISO_DATE_PATTERN = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/;
const TIME_PATTERN = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
const TIME_RANGE_PATTERN = new RegExp(
  `(\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?))\\s*(?:-|–|—|to)\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?))`,
  "i",
);
const EVENT_BLOCK_PATTERN = /<(article|li)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HEADING_PATTERN = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const ANCHOR_PATTERN = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const TAG_ATTRIBUTE_PATTERN = /([\w:-]+)\s*=\s*["']([^"']*)["']/gi;

function clean(value, max = 6_000) {
  return String(value ?? "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function officialUrl(value, base = BROOKLYN_BP_ULURP_SOURCE_URL) {
  try {
    const url = new URL(String(value || ""), base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function attributes(openingTag) {
  return Object.fromEntries([...String(openingTag || "").matchAll(TAG_ATTRIBUTE_PATTERN)]
    .map((match) => [match[1].toLowerCase(), match[2]]));
}

function validDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateValue(value, contextYear = null) {
  const raw = clean(value, 300);
  const named = raw.match(DATE_PATTERN);
  if (named) {
    const year = Number(named[3] || contextYear);
    const iso = validDate(year, MONTHS[named[1].toLowerCase()], Number(named[2]));
    return { iso, raw: named[0], reason: iso ? null : "malformed_date" };
  }
  const numeric = raw.match(ISO_DATE_PATTERN);
  if (numeric) {
    const iso = validDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
    return { iso, raw: numeric[0], reason: iso ? null : "malformed_date" };
  }
  return null;
}

function clockValue(value) {
  const raw = clean(value, 100);
  const match = raw.match(TIME_PATTERN);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || "00");
  const suffix = match[3].replace(/\./g, "").toUpperCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (suffix === "AM" && hour === 12) hour = 0;
  if (suffix === "PM" && hour < 12) hour += 12;
  return {
    raw: match[0].replace(/\s+/g, " ").trim(),
    clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
  };
}

function timeValues(value) {
  const raw = clean(value, 500);
  const range = raw.match(TIME_RANGE_PATTERN);
  if (range) return { start: clockValue(range[1]), end: clockValue(range[2]), raw: range[0] };
  const single = clockValue(raw);
  return single ? { start: single, end: null, raw: single.raw } : null;
}

function parseDateTime(value) {
  const raw = clean(value, 200).replace(" ", "T");
  const match = raw.match(/^(20\d{2}-\d{2}-\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const date = dateValue(match[1]);
  if (!date?.iso) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] || "00");
  if (hour > 23 || minute > 59 || second > 59) return null;
  return {
    date: date.iso,
    clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
  };
}

function textFromHtml(value) {
  return clean(value, 16_000);
}

function hrefs(html, base) {
  return [...String(html || "").matchAll(ANCHOR_PATTERN)]
    .map((match) => ({
      url: officialUrl(match[2], base),
      label: clean(match[3], 400),
    }))
    .filter((link) => link.url);
}

function headings(html) {
  return [...String(html || "").matchAll(HEADING_PATTERN)]
    .map((match) => ({ index: match.index, text: clean(match[2], 300) }));
}

function yearBefore(index, pageHeadings) {
  const heading = [...pageHeadings].reverse().find((candidate) => candidate.index < index
    && /\b20\d{2}\b/.test(candidate.text));
  const match = heading?.text.match(/\b(20\d{2})\b/);
  return match ? Number(match[0]) : null;
}

function eventBlocks(html) {
  const source = String(html || "");
  const matches = [...source.matchAll(EVENT_BLOCK_PATTERN)];
  return matches.length
    ? matches.map((match) => ({ html: match[0], index: match.index }))
    : [{ html: source, index: 0 }];
}

function firstAttribute(block, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of String(block).match(/<[^>]+>/g) || []) {
    const attrs = attributes(tag);
    for (const name of wanted) {
      if (attrs[name]) return clean(attrs[name], 500);
    }
  }
  return null;
}

function publisherIdentity(block, links, sourceUrl) {
  const permalink = links.find((link) => /event|hearing|ulurp/i.test(`${link.label} ${link.url}`))?.url
    || links[0]?.url
    || null;
  const eventId = firstAttribute(block, [
    "data-event-id", "data-event_id", "data-eventid", "data-tribe-event-id", "data-post-id",
  ]);
  if (eventId) return { value: eventId, kind: "publisher_event_id", permalink };
  const classMatch = String(block).match(/\bpost-(\d+)\b/i);
  if (classMatch) return { value: classMatch[1], kind: "publisher_event_id", permalink };
  return permalink
    ? { value: permalink, kind: "permalink_fallback", permalink }
    : { value: null, kind: null, permalink: null };
}

function titleValue(block, links) {
  const heading = String(block).match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
  const titleLink = links.find((link) => /ulurp|hearing|event/i.test(link.label));
  return clean(heading?.[1] || titleLink?.label || "", 500);
}

function classificationFor(title, blockText, attrs) {
  const value = `${title} ${blockText} ${attrs.classification || ""} ${attrs["data-category"] || ""}`;
  if (/\bulurp\b/i.test(value) && /\bpublic\s+hearing\b/i.test(value)) {
    return BROOKLYN_BP_ULURP_CLASSIFICATION;
  }
  if (/uniform\s+land\s+use\s+review\s+procedure/i.test(value)
    && /\bpublic\s+hearing\b/i.test(value)) {
    return BROOKLYN_BP_ULURP_CLASSIFICATION;
  }
  return null;
}

function dateAndTimes(block, blockText, contextYear) {
  const startDateTime = firstAttribute(block, ["data-start-datetime", "data-start-date-time", "data-start"]);
  const endDateTime = firstAttribute(block, ["data-end-datetime", "data-end-date-time", "data-end"]);
  const datetimeValues = [...String(block).matchAll(/\bdatetime\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1]);
  const startExact = parseDateTime(startDateTime) || parseDateTime(datetimeValues[0]);
  const endExact = parseDateTime(endDateTime) || parseDateTime(datetimeValues[1]);
  const date = startExact?.date
    ? { iso: startExact.date, raw: startExact.date }
    : dateValue(blockText, contextYear);
  if (!date?.iso) return { date, start: null, end: null, rawTime: null };
  const range = timeValues(blockText.match(TIME_RANGE_PATTERN)?.[0] || "")
    || (startExact ? { start: { raw: startDateTime, clock: startExact.clock }, end: null, raw: startDateTime } : null);
  const start = startExact ? { raw: startDateTime, clock: startExact.clock } : range?.start;
  const end = endExact ? { raw: endDateTime, clock: endExact.clock } : range?.end;
  return { date, start, end, rawTime: range?.raw || null };
}

function venueFrom(text) {
  if (/brooklyn\s+borough\s+hall/i.test(text)) return { ...BROOKLYN_BP_ULURP_VENUE };
  const address = text.match(/\b(\d+\s+Joralemon\s+(?:Street|St\.?)[^.;<]*)/i)?.[1];
  return address ? { name: "Brooklyn Borough Hall", address: clean(address, 300) } : null;
}

function landUseEvidence(html, sourceUrl) {
  const text = textFromHtml(html);
  const links = hrefs(html, sourceUrl);
  const evidence = text.match(/[^.]{0,180}(?:participate|testif|testimony|Webex|public hearing)[^.]{0,260}\.?/i)?.[0]?.trim() || null;
  const remote = links.find((link) => /webex|join|remote/i.test(`${link.label} ${link.url}`)) || null;
  const hasTestimony = /\b(testif\w*|testimony|public comment|speak\w*)\b/i.test(text);
  const hasAccess = /\b(participate|join|webex|remote|in person)\b/i.test(text);
  if (!text && !links.length) return null;
  return {
    source_url: sourceUrl,
    evidence,
    links: [
      { label: "Brooklyn land-use hearing information", url: sourceUrl },
      ...links.filter((link) => link.url !== sourceUrl).slice(0, 3),
    ],
    remote_join_url: remote?.url || null,
    speaking_rights: hasTestimony ? "allowed" : "unknown",
    has_access_evidence: hasAccess,
  };
}

function rejection(reason, details = {}) {
  return { adapter: BROOKLYN_BP_ULURP_CALENDAR_PARSER, reason, ...details };
}

function receiptFor(sourceUrl, observedAt, supplied) {
  if (supplied) {
    return {
      ...supplied,
      source_url: supplied.source_url || sourceUrl,
      parser: supplied.parser || BROOKLYN_BP_ULURP_CALENDAR_PARSER,
    };
  }
  return {
    schema: "cityscroll.meeting_source_receipt.v1",
    source_url: sourceUrl,
    observed_at: observedAt,
    status: "ok",
    fetch_status: "snapshot",
    parser: BROOKLYN_BP_ULURP_CALENDAR_PARSER,
  };
}

function rowFor({ block, blockText, title, classification, identity, timing, sourceUrl, landUseUrl, receipt, sourceRevision, evidence }) {
  const meetingId = publicBodyCalendarIdentity({
    source_contract_id: BROOKLYN_BP_ULURP_SOURCE_CONTRACT_ID,
    publisher_identifier: identity.value,
  });
  const startAt = `${timing.date.iso}T${timing.start.clock}`;
  const endAt = timing.end ? `${timing.date.iso}T${timing.end.clock}` : null;
  const eventUrl = identity.permalink || sourceUrl;
  const accessEvidence = evidence || {
    source_url: landUseUrl,
    evidence: null,
    links: [{ label: "Brooklyn land-use hearing information", url: landUseUrl }],
    remote_join_url: null,
    speaking_rights: "unknown",
    has_access_evidence: false,
  };
  const participation = {
    links: accessEvidence.links,
    remote_join_url: accessEvidence.remote_join_url,
    source_url: accessEvidence.source_url,
  };
  return normalizePublicBodyCalendarMeeting({
    source_contract_id: BROOKLYN_BP_ULURP_SOURCE_CONTRACT_ID,
    publisher_identifier: identity.value,
    title,
    description: blockText,
    event_date: startAt,
    event_end: endAt,
    timezone: BROOKLYN_BP_ULURP_TIMEZONE,
    schedule: {
      basis: "publisher_event",
      raw_date: timing.date.iso,
      raw_time: timing.start.raw,
    },
    source_url: eventUrl,
    official_source_url: landUseUrl,
    source_receipt: receipt,
    source_revision: sourceRevision,
    temporal_basis: "explicit_instance",
    schedule_basis: "publisher_event",
    basis: "publisher_event",
    institution_ref: BROOKLYN_BP_ULURP_INSTITUTION_REF,
    venue: venueFrom(blockText),
    participation,
    observer_access: accessEvidence.has_access_evidence || accessEvidence.remote_join_url
      ? { remote_join_url: accessEvidence.remote_join_url, watch_url: landUseUrl }
      : null,
    access_steps: [
      accessEvidence.has_access_evidence && { kind: "hearing_access", destination: landUseUrl, source_url: landUseUrl },
      accessEvidence.speaking_rights === "allowed" && { kind: "testimony", destination: landUseUrl, source_url: landUseUrl },
    ].filter(Boolean),
    activity: accessEvidence.speaking_rights === "allowed" ? "speak" : "attend",
    speaking_rights: accessEvidence.speaking_rights,
    meeting_origin: "official_brooklyn_bp_ulurp_schedule",
    source_raw_values: {
      publisher_identifier: identity.value,
      publisher_identity_kind: identity.kind,
      publisher_permalink: identity.permalink,
      classification,
      raw_start: timing.start.raw,
      raw_end: timing.end?.raw || null,
      raw_time: timing.rawTime,
      record_text: blockText,
      participation_evidence: accessEvidence.evidence,
      participation_source_url: accessEvidence.source_url,
    },
    meeting_id: meetingId,
  });
}

function parseEventBlock(block, contextYear, options, evidence) {
  const blockHtml = block.html;
  const blockText = textFromHtml(blockHtml);
  const opening = blockHtml.match(/^<[^>]+>/)?.[0] || "";
  const attrs = attributes(opening);
  const links = hrefs(blockHtml, options.sourceUrl);
  const title = titleValue(blockHtml, links);
  const classification = classificationFor(title, blockText, attrs);
  const identity = publisherIdentity(blockHtml, links, options.sourceUrl);
  if (!classification) {
    return {
      rejected: rejection("classification_not_admitted", {
        title: title || null,
        publisher_identifier: identity.value,
        publisher_time: attrs["data-start"] || attrs["data-datetime"] || null,
      }),
    };
  }
  if (!identity.value) {
    return {
      quarantine: rejection("missing_publisher_identity", { title: title || null, publisher_time: blockText.match(TIME_RANGE_PATTERN)?.[0] || null }),
    };
  }
  const timing = dateAndTimes(blockHtml, blockText, contextYear);
  if (!timing.date?.iso) {
    return { quarantine: rejection("missing_or_malformed_date", { publisher_identifier: identity.value, title, publisher_time: blockText.match(TIME_RANGE_PATTERN)?.[0] || null }) };
  }
  if (!timing.start) {
    return { quarantine: rejection("missing_or_malformed_publisher_time", { publisher_identifier: identity.value, date: timing.date.iso, publisher_time: blockText.match(TIME_PATTERN)?.[0] || null }) };
  }
  const record = rowFor({
    block: blockHtml,
    blockText,
    title: title || "ULURP Public Hearing Meeting",
    classification,
    identity,
    timing,
    sourceUrl: options.sourceUrl,
    landUseUrl: options.landUseUrl,
    receipt: options.receipt,
    sourceRevision: options.sourceRevision,
    evidence,
  });
  return { record };
}

/**
 * Parse the Borough President's broad Events Calendar while admitting only
 * the frozen ULURP/public-hearing classification. Missing or anomalous
 * publisher values are returned in quarantine; no date or clock is inferred.
 */
export function parseBrooklynBpUlurpScheduleHtml(html, {
  sourceUrl = BROOKLYN_BP_ULURP_SOURCE_URL,
  landUseUrl = BROOKLYN_BP_ULURP_LAND_USE_URL,
  landUseHtml = "",
  officialLandUseHtml = "",
  observedAt = null,
  receipt = null,
  sourceRevision = null,
} = {}) {
  const officialSourceUrl = officialUrl(sourceUrl) || BROOKLYN_BP_ULURP_SOURCE_URL;
  const officialLandUseUrl = officialUrl(landUseUrl) || BROOKLYN_BP_ULURP_LAND_USE_URL;
  const sourceReceipt = receiptFor(officialSourceUrl, observedAt, receipt);
  const options = {
    sourceUrl: officialSourceUrl,
    landUseUrl: officialLandUseUrl,
    receipt: sourceReceipt,
    sourceRevision,
  };
  const evidence = landUseEvidence(landUseHtml || officialLandUseHtml, officialLandUseUrl);
  const pageHeadings = headings(html);
  const rows = [];
  const documents = [];
  const rejected = [];
  const quarantined = [];
  const seen = new Map();
  for (const block of eventBlocks(html)) {
    const parsed = parseEventBlock(block, yearBefore(block.index, pageHeadings), options, evidence);
    if (parsed.rejected) {
      rejected.push(parsed.rejected);
      continue;
    }
    if (parsed.quarantine) {
      quarantined.push(parsed.quarantine);
      continue;
    }
    const identity = parsed.record.publisher_identifier;
    if (seen.has(identity)) {
      const priorIndex = seen.get(identity);
      const prior = rows[priorIndex];
      rows.splice(priorIndex, 1);
      for (const [key, index] of seen) if (index > priorIndex) seen.set(key, index - 1);
      seen.delete(identity);
      quarantined.push(rejection("duplicate_event_identity", {
        publisher_identifier: identity,
        records: [prior.source_raw_values?.record_text, parsed.record.source_raw_values?.record_text],
      }));
      continue;
    }
    seen.set(identity, rows.length);
    rows.push(parsed.record);
  }
  rows.sort((left, right) => String(left.schedule.starts_at).localeCompare(String(right.schedule.starts_at)));
  return {
    schema: BROOKLYN_BP_ULURP_CALENDAR_SCHEMA,
    source_contract_id: BROOKLYN_BP_ULURP_SOURCE_CONTRACT_ID,
    source_url: officialSourceUrl,
    land_use_source_url: officialLandUseUrl,
    generated_at: observedAt,
    source_receipt: sourceReceipt,
    coverage: [{
      source_contract_id: BROOKLYN_BP_ULURP_SOURCE_CONTRACT_ID,
      status: rows.length ? "fresh" : "fresh-empty",
      row_count: rows.length,
      observed_at: observedAt,
    }],
    rows,
    records: rows,
    documents,
    quarantined,
    quarantine: quarantined,
    rejected,
    population: {
      input_event_count: eventBlocks(html).length,
      admitted_meeting_count: rows.length,
      rejected_count: rejected.length,
      quarantined_count: quarantined.length,
    },
  };
}

export const parseBrooklynBpUlurpCalendarHtml = parseBrooklynBpUlurpScheduleHtml;
export const parseBrooklynBpUlurpEventsHtml = parseBrooklynBpUlurpScheduleHtml;
export const parseBrooklynBpUlurpPage = parseBrooklynBpUlurpScheduleHtml;
export const parseBrooklynBpUlurpCalendar = parseBrooklynBpUlurpScheduleHtml;
export const buildBrooklynBpUlurpCalendarIndex = parseBrooklynBpUlurpScheduleHtml;
