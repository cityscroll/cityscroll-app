import {
  normalizePublicBodyCalendarMeeting,
  publicBodyCalendarIdentity,
} from "./public_body_calendar_contract.mjs";

export const BROOKLYN_BOROUGH_BOARD_CALENDAR_SCHEMA = "cityscroll.brooklyn_borough_board_calendar.v1";
export const BROOKLYN_BOROUGH_BOARD_SOURCE_CONTRACT_ID = "brooklyn_borough_board";
export const BROOKLYN_BOROUGH_BOARD_SOURCE_URL = "https://www.brooklynbp.nyc.gov/borough-boards/";
export const BROOKLYN_BOROUGH_BOARD_CALENDAR_PARSER = "brooklyn_borough_board_calendar_v1";
export const BROOKLYN_BOROUGH_BOARD_INSTITUTION_REF = "borough-president:brooklyn:borough-board";
export const BROOKLYN_BOROUGH_BOARD_TIMEZONE = "America/New_York";
export const BROOKLYN_BOROUGH_HALL = Object.freeze({
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
const MONTH_NAMES = Object.freeze(Object.keys(MONTHS));
const MONTH_PATTERN = MONTH_NAMES.join("|");
const YEAR_PATTERN = /\b(20\d{2})\b/;
const TIME_PATTERN = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
const HEADING_PATTERN = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const LIST_ITEM_PATTERN = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;

function clean(value, max = 4_000) {
  return String(value ?? "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function officialUrl(value, base = BROOKLYN_BOROUGH_BOARD_SOURCE_URL) {
  try {
    const url = new URL(String(value || ""), base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function validDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDate(value, contextYear = null) {
  const raw = clean(value, 300);
  const named = raw.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "i"));
  if (named) {
    const year = Number(named[3] || contextYear);
    const iso = validDate(year, MONTHS[named[1].toLowerCase()], Number(named[2]));
    return { iso, raw: named[0], reason: iso ? null : "malformed_date" };
  }
  const isoLike = raw.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoLike) {
    const iso = validDate(Number(isoLike[1]), Number(isoLike[2]), Number(isoLike[3]));
    return { iso, raw: isoLike[0], reason: iso ? null : "malformed_date" };
  }
  if (new RegExp(`\\b(?:${MONTH_PATTERN})\\b`, "i").test(raw)) {
    return { iso: null, raw, reason: "malformed_date" };
  }
  return null;
}

function parseTime(value) {
  const raw = clean(value, 400);
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

function headings(html) {
  return [...String(html || "").matchAll(HEADING_PATTERN)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    text: clean(match[2], 300),
  }));
}

function yearAt(index, yearHeadings) {
  const heading = [...yearHeadings].reverse().find((candidate) => candidate.index < index);
  const match = heading?.text.match(/^20\d{2}$/);
  return match ? Number(match[0]) : null;
}

function listEntries(html, yearHeadings) {
  return [...String(html || "").matchAll(LIST_ITEM_PATTERN)].map((match, index) => ({
    index,
    sourceIndex: match.index,
    text: clean(match[1], 500),
    year: yearAt(match.index, yearHeadings),
  }));
}

function sharedLocationText(pageText) {
  const match = pageText.match(/\bat\s+((?:Brooklyn\s+)?Borough\s+Hall)\b/i);
  return match ? match[1] : BROOKLYN_BOROUGH_HALL.name;
}

function rejection(reason, details = {}) {
  return { adapter: BROOKLYN_BOROUGH_BOARD_CALENDAR_PARSER, reason, ...details };
}

function receiptFor(sourceUrl, observedAt, supplied) {
  if (supplied) {
    return {
      ...supplied,
      source_url: supplied.source_url || sourceUrl,
      parser: supplied.parser || BROOKLYN_BOROUGH_BOARD_CALENDAR_PARSER,
    };
  }
  return {
    schema: "cityscroll.meeting_source_receipt.v1",
    source_url: sourceUrl,
    observed_at: observedAt,
    status: "ok",
    fetch_status: "snapshot",
    parser: BROOKLYN_BOROUGH_BOARD_CALENDAR_PARSER,
  };
}

function rowFor({ date, sourceUrl, sourceReceipt, sourceRevision, sharedTime, sharedLocation, rawDate }) {
  const publisherIdentifier = date;
  const meetingId = publicBodyCalendarIdentity({
    source_contract_id: BROOKLYN_BOROUGH_BOARD_SOURCE_CONTRACT_ID,
    publisher_identifier: publisherIdentifier,
  });
  return normalizePublicBodyCalendarMeeting({
    source_contract_id: BROOKLYN_BOROUGH_BOARD_SOURCE_CONTRACT_ID,
    publisher_identifier: publisherIdentifier,
    title: "Brooklyn Borough Board meeting",
    event_date: date,
    raw_date: rawDate,
    raw_time: sharedTime.raw,
    timezone: BROOKLYN_BOROUGH_BOARD_TIMEZONE,
    schedule: {
      basis: "publisher_event",
      raw_date: date,
      raw_time: sharedTime.raw,
    },
    source_url: sourceUrl,
    official_source_url: sourceUrl,
    source_receipt: sourceReceipt,
    source_revision: sourceRevision,
    temporal_basis: "explicit_instance",
    schedule_basis: "publisher_event",
    basis: "publisher_event",
    institution_ref: BROOKLYN_BOROUGH_BOARD_INSTITUTION_REF,
    venue: { ...BROOKLYN_BOROUGH_HALL },
    participation: {
      links: [],
      remote_join_url: null,
      source_url: sourceUrl,
      evidence: "Other attendees may view the proceedings virtually.",
    },
    speaking_rights: "unknown",
    activity: "attend",
    meeting_origin: "official_brooklyn_borough_board_schedule",
    source_raw_values: {
      enumerated_date: rawDate,
      shared_time: sharedTime.raw,
      shared_location: sharedLocation,
      venue: BROOKLYN_BOROUGH_HALL.name,
      institution_ref: BROOKLYN_BOROUGH_BOARD_INSTITUTION_REF,
    },
    meeting_id: meetingId,
  });
}

/**
 * Parse only explicitly enumerated Borough Board dates. The page-level time
 * and location are shared evidence; no occurrence is generated from the
 * publisher's recurrence sentence or from weekday arithmetic.
 */
export function parseBrooklynBoroughBoardScheduleHtml(html, {
  sourceUrl = BROOKLYN_BOROUGH_BOARD_SOURCE_URL,
  observedAt = null,
  receipt = null,
  sourceRevision = null,
} = {}) {
  const pageHtml = String(html || "");
  const officialSourceUrl = officialUrl(sourceUrl) || BROOKLYN_BOROUGH_BOARD_SOURCE_URL;
  const pageText = clean(pageHtml, 16_000);
  const sourceReceipt = receiptFor(officialSourceUrl, observedAt, receipt);
  const yearHeadings = headings(pageHtml).filter((heading) => /^20\d{2}$/.test(heading.text));
  const entries = listEntries(pageHtml, yearHeadings);
  const sharedTime = parseTime(pageText);
  const sharedLocation = sharedLocationText(pageText);
  const quarantined = [];
  const rejected = [];
  const rowsByDate = new Map();
  const duplicateDates = new Set();

  if (!sharedTime) {
    const issue = rejection("missing_shared_time", { detail: "The page does not state a shared meeting clock." });
    rejected.push(issue);
    quarantined.push(issue);
  }
  if (!entries.length) rejected.push(rejection("missing_enumerated_dates"));

  if (sharedTime) {
    for (const entry of entries) {
      const parsed = parseDate(entry.text, entry.year);
      if (!parsed) continue;
      if (!parsed.iso) {
        quarantined.push(rejection(parsed.reason || "malformed_date", {
          date_text: parsed.raw,
          year: entry.year,
        }));
        continue;
      }
      if (!entry.year && !/\b20\d{2}\b/.test(parsed.raw)) {
        quarantined.push(rejection("missing_year", { date_text: parsed.raw }));
        continue;
      }
      const row = rowFor({
        date: parsed.iso,
        rawDate: parsed.raw,
        sourceUrl: officialSourceUrl,
        sourceReceipt,
        sourceRevision,
        sharedTime,
        sharedLocation,
      });
      if (rowsByDate.has(parsed.iso)) {
        rowsByDate.delete(parsed.iso);
        duplicateDates.add(parsed.iso);
        quarantined.push(rejection("duplicate_date_key", { date: parsed.iso, date_text: parsed.raw }));
        continue;
      }
      if (duplicateDates.has(parsed.iso)) {
        quarantined.push(rejection("duplicate_date_key", { date: parsed.iso, date_text: parsed.raw }));
        continue;
      }
      rowsByDate.set(parsed.iso, row);
    }
  }

  const rows = [...rowsByDate.values()].sort((left, right) => left.event_date.localeCompare(right.event_date));
  const coverage = [{
    source_contract_id: BROOKLYN_BOROUGH_BOARD_SOURCE_CONTRACT_ID,
    status: rows.length ? "fresh" : "fresh-empty",
    row_count: rows.length,
    observed_at: observedAt,
  }];
  return {
    schema: BROOKLYN_BOROUGH_BOARD_CALENDAR_SCHEMA,
    source_contract_id: BROOKLYN_BOROUGH_BOARD_SOURCE_CONTRACT_ID,
    source_url: officialSourceUrl,
    generated_at: observedAt,
    source_receipt: sourceReceipt,
    coverage,
    rows,
    records: rows,
    documents: [],
    quarantined,
    quarantine: quarantined,
    rejected,
    population: {
      input_list_item_count: entries.length,
      admitted_meeting_count: rows.length,
      quarantined_count: quarantined.length,
    },
  };
}

export const parseBrooklynBoroughBoardPage = parseBrooklynBoroughBoardScheduleHtml;
export const parseBrooklynBoroughBoardSchedule = parseBrooklynBoroughBoardScheduleHtml;
export const buildBrooklynBoroughBoardCalendarIndex = parseBrooklynBoroughBoardScheduleHtml;
