import {
  normalizePublicBodyCalendarMeeting,
  publicBodyCalendarIdentity,
} from "./public_body_calendar_contract.mjs";

export const CCRB_BOARD_CALENDAR_SCHEMA = "cityscroll.ccrb_board_calendar.v1";
export const CCRB_BOARD_SOURCE_CONTRACT_ID = "ccrb_board";
export const CCRB_BOARD_SOURCE_URL = "https://www.nyc.gov/site/ccrb/about/news/board-meeting-schedule.page";
export const CCRB_BOARD_CALENDAR_PARSER = "ccrb_board_monthly_record_v1";

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
const MONTH_HEADING = new RegExp(`^(${MONTH_NAMES.join("|")})\\s+(20\\d{2})(?:\\s+(?:CCRB\\s+)?Board\\s+Meetings?)?$`, "i");
const DATE_PATTERN = new RegExp(`\\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\\s*,?\\s*(${MONTH_NAMES.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(20\\d{2})\\b`, "i");
const TIME_PATTERN = /\b(\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?))\b/i;
const MONTH_HEADING_TAG = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const PARAGRAPH_TAG = /<(?:p|li)\b[^>]*>[\s\S]*?<\/(?:p|li)>/gi;
const ANCHOR_TAG = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function clean(value, max = 4_000) {
  return String(value ?? "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function officialUrl(value, base = CCRB_BOARD_SOURCE_URL) {
  try {
    const url = new URL(String(value || ""), base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function headingValue(value) {
  const text = clean(value, 200);
  const match = text.match(MONTH_HEADING);
  if (!match) return null;
  return {
    text,
    month: MONTHS[match[1].toLowerCase()],
    year: Number(match[2]),
  };
}

function dateValue(value) {
  const match = clean(value, 300).match(DATE_PATTERN);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return {
    iso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    raw: match[0].replace(/\s+/g, " ").trim(),
    month,
    year,
  };
}

function timeValue(value) {
  const match = clean(value, 300).match(TIME_PATTERN);
  if (!match) return null;
  const raw = match[1].replace(/\./g, "").replace(/\s+/g, " ").trim();
  const [clock, suffix] = raw.split(/\s+/);
  let [hour, minute] = clock.split(":").map(Number);
  const upperSuffix = suffix.toUpperCase();
  if (hour > 12 || minute > 59 || (upperSuffix === "AM" && hour === 0)) return null;
  if (upperSuffix === "AM" && hour === 12) hour = 0;
  if (upperSuffix === "PM" && hour < 12) hour += 12;
  return {
    raw: match[1].replace(/\s+/g, " ").trim(),
    clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    normalized: `${String(hour > 12 ? hour - 12 : hour || 12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${upperSuffix}`,
  };
}

function headings(html) {
  return [...String(html || "").matchAll(MONTH_HEADING_TAG)]
    .map((match) => ({ index: match.index, end: match.index + match[0].length, heading: headingValue(match[2]) }))
    .filter((entry) => entry.heading);
}

function recordFragments(html) {
  const fragments = [...String(html || "").matchAll(PARAGRAPH_TAG)];
  return fragments.length ? fragments.map((match) => ({ index: match.index, html: match[0], text: clean(match[0]) })) : [{ index: 0, html: String(html || ""), text: clean(html) }];
}

function pageLinks(html, sourceUrl) {
  return [...String(html || "").matchAll(ANCHOR_TAG)].map((match) => ({
    url: officialUrl(match[1], sourceUrl),
    label: clean(match[2], 300),
  })).filter((link) => link.url);
}

function webexLinks(html, sourceUrl) {
  return pageLinks(html, sourceUrl).filter((link) => /webex/i.test(`${link.url} ${link.label}`));
}

function documentLinks(html, sourceUrl, meetingId) {
  return pageLinks(html, sourceUrl)
    .map((link) => {
      const value = `${link.label} ${link.url}`;
      const role = /minute/i.test(value) ? "minutes" : /agenda/i.test(value) ? "agenda" : /report/i.test(value) ? "materials" : null;
      if (!role) return null;
      return {
        role,
        ...(role === "materials" ? { document_type: "monthly_report" } : {}),
        document_id: link.url,
        publisher_document_id: link.url,
        document_url: link.url,
        source_url: sourceUrl,
        title: link.label || role,
        meeting_id: meetingId,
        meeting_date: meetingId.split(":").at(-1),
        attachment_status: "attached",
        adapter: CCRB_BOARD_CALENDAR_PARSER,
      };
    })
    .filter(Boolean);
}

function venueFrom(text) {
  const known = text.match(/\b(Tweed Conference Center)\b/i);
  if (known) return { name: known[1] };
  const generic = text.match(/\b(?:held|taking place|located)\s+(?:at|in)\s+([^.;]+?)(?=\s+(?:and|via|online|virtually)\b|$)/i);
  return generic ? { name: generic[1].trim() } : null;
}

function speakingRightsFor(text) {
  if (/\b(?:public|members of the public)\b[\s\S]{0,120}\b(?:speak|speaking|comment|testif)/i.test(text)
    || /\b(?:speak|speaking|comment|testif)[\s\S]{0,120}\b(?:public|members of the public)\b/i.test(text)) {
    return /\b(?:register|registration|sign up)\b/i.test(text) ? "requires_registration" : "allowed";
  }
  return "unknown";
}

function participationFor(html, pageText, sourceUrl) {
  const links = webexLinks(html, sourceUrl);
  const remote = links[0]?.url || null;
  return {
    links: links.map((link) => ({ label: link.label || "Webex meeting", url: link.url })),
    remote_join_url: remote,
    source_url: sourceUrl,
    evidence: pageText.match(/[^.]{0,140}(?:public|speak|speaking|comment|testif)[^.]{0,180}\.?/i)?.[0]?.trim() || null,
  };
}

function receiptFor(sourceUrl, observedAt, supplied) {
  return supplied || {
    schema: "cityscroll.meeting_source_receipt.v1",
    source_url: sourceUrl,
    observed_at: observedAt,
    status: "ok",
    fetch_status: "snapshot",
    parser: CCRB_BOARD_CALENDAR_PARSER,
  };
}

function rejection(reason, details = {}) {
  return { adapter: CCRB_BOARD_CALENDAR_PARSER, reason, ...details };
}

function rowFor({ fragment, heading, date, time, pageHtml, pageText, sourceUrl, receipt, sourceRevision }) {
  const publisherIdentifier = date.iso;
  const meetingId = publicBodyCalendarIdentity({ source_contract_id: CCRB_BOARD_SOURCE_CONTRACT_ID, publisher_identifier: publisherIdentifier });
  const participation = participationFor(pageHtml, pageText, sourceUrl);
  const documents = documentLinks(fragment.html, sourceUrl, meetingId);
  return normalizePublicBodyCalendarMeeting({
    source_contract_id: CCRB_BOARD_SOURCE_CONTRACT_ID,
    publisher_identifier: publisherIdentifier,
    title: "CCRB Board Meeting",
    event_date: date.iso,
    raw_date: date.iso,
    raw_time: time.normalized,
    timezone: "America/New_York",
    schedule: {
      basis: "publisher_event",
      raw_date: date.iso,
      raw_time: time.normalized,
    },
    source_url: sourceUrl,
    official_source_url: sourceUrl,
    source_receipt: receipt,
    source_revision: sourceRevision,
    temporal_basis: "explicit_instance",
    schedule_basis: "publisher_event",
    basis: "publisher_event",
    venue: venueFrom(fragment.text),
    participation,
    speaking_rights: speakingRightsFor(pageText),
    activity: "attend",
    meeting_documents: documents,
    meeting_origin: "official_ccrb_board_schedule",
    source_raw_values: {
      monthly_heading: heading.text,
      raw_date: date.raw,
      raw_time: time.raw,
      record_text: fragment.text,
      participation_evidence: participation.evidence,
    },
  });
}

function sectionFragments(sourceHtml, section, nextSection) {
  const end = nextSection?.index ?? String(sourceHtml || "").length;
  return recordFragments(String(sourceHtml || "").slice(section.end, end));
}

/**
 * Parse only headed monthly CCRB board records. The parser returns accepted
 * normalized meetings and explicit quarantine records for source-contract
 * defects; it never promotes an un-timed or ambiguously keyed record.
 */
export function parseCcrbBoardScheduleHtml(html, {
  sourceUrl = CCRB_BOARD_SOURCE_URL,
  observedAt = null,
  receipt = null,
  sourceRevision = null,
} = {}) {
  const pageHtml = String(html || "");
  const officialSourceUrl = officialUrl(sourceUrl) || CCRB_BOARD_SOURCE_URL;
  const pageText = clean(pageHtml, 12_000);
  const sourceReceipt = receiptFor(officialSourceUrl, observedAt, receipt);
  const monthSections = headings(pageHtml);
  const rowsByDate = new Map();
  const duplicateDates = new Set();
  const quarantined = [];
  const rejected = [];

  if (!monthSections.length) {
    rejected.push(rejection("missing_month_heading"));
  }

  monthSections.forEach((section, index) => {
    for (const fragment of sectionFragments(pageHtml, section, monthSections[index + 1])) {
      if (!/\b(?:CCRB|civilian complaint review board)\b/i.test(fragment.text)
        || !/\bboard\s+meeting\b/i.test(fragment.text)) continue;
      const date = dateValue(fragment.text);
      if (!date) {
        quarantined.push(rejection("missing_date", { heading: section.heading.text, excerpt: fragment.text }));
        continue;
      }
      const time = timeValue(fragment.text);
      if (!time) {
        quarantined.push(rejection("missing_clock", { date: date.iso, heading: section.heading.text, excerpt: fragment.text }));
        continue;
      }
      if (date.month !== section.heading.month || date.year !== section.heading.year) {
        quarantined.push(rejection("monthly_heading_mismatch", {
          date: date.iso,
          heading: section.heading.text,
          excerpt: fragment.text,
        }));
        continue;
      }
      const row = rowFor({ fragment, heading: section.heading, date, time, pageHtml, pageText, sourceUrl: officialSourceUrl, receipt: sourceReceipt, sourceRevision });
      if (rowsByDate.has(date.iso)) {
        const prior = rowsByDate.get(date.iso);
        rowsByDate.delete(date.iso);
        duplicateDates.add(date.iso);
        quarantined.push(rejection("duplicate_date_key", { date: date.iso, records: [prior.source_raw_values?.record_text, fragment.text] }));
        continue;
      }
      if (duplicateDates.has(date.iso)) {
        quarantined.push(rejection("duplicate_date_key", { date: date.iso, excerpt: fragment.text }));
        continue;
      }
      rowsByDate.set(date.iso, row);
    }
  });

  const rows = [...rowsByDate.values()].sort((left, right) => left.event_date.localeCompare(right.event_date));
  return {
    schema: CCRB_BOARD_CALENDAR_SCHEMA,
    source_contract_id: CCRB_BOARD_SOURCE_CONTRACT_ID,
    source_url: officialSourceUrl,
    generated_at: observedAt,
    source_receipt: sourceReceipt,
    coverage: [{
      source_contract_id: CCRB_BOARD_SOURCE_CONTRACT_ID,
      status: "fresh",
      row_count: rows.length,
      observed_at: observedAt,
    }],
    rows,
    records: rows,
    documents: rows.flatMap((row) => row.meeting_documents || []),
    quarantined,
    rejected,
  };
}

export const parseCcrbBoardPage = parseCcrbBoardScheduleHtml;
export const buildCcrbBoardCalendarIndex = parseCcrbBoardScheduleHtml;
