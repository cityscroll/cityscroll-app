import { normalizePublicBodyCalendarMeeting } from "./public_body_calendar_contract.mjs";

export const NYCPS_PEP_CALENDAR_SCHEMA = "cityscroll.nycps_pep_calendar.v1";
export const NYCPS_PEP_SOURCE_CONTRACT_ID = "nycps_pep";
export const NYCPS_PEP_SOURCE_URL = "https://www.schools.nyc.gov/get-involved/families/panel-for-education-policy/panel-meetings";
export const NYCPS_PEP_CALENDAR_PARSER = "nycps_pep_calendar_acquisition.v1";
export const NYCPS_PEP_TIMEZONE = "America/New_York";

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});

function clean(value, max = 6_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromHtml(value) {
  return clean(decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " ")));
}

function hrefs(value, sourceUrl) {
  return [...String(value ?? "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .flatMap((match) => {
      try {
        const url = new URL(decodeEntities(match[1]), sourceUrl);
        if (!["http:", "https:"].includes(url.protocol)) return [];
        return [{ href: url.href, label: textFromHtml(match[2]) }];
      } catch {
        return [];
      }
    });
}

function dateFromHeading(value) {
  const source = textFromHtml(value);
  const named = source.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  const numeric = source.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  const parts = named
    ? [Number(named[3]), MONTHS[named[1].toLowerCase()], Number(named[2])]
    : numeric ? [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])] : null;
  if (!parts || !parts.every(Number.isInteger)) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function timeFromBody(value) {
  const source = textFromHtml(value);
  const match = source.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\s*\(([^)]+)\)/i);
  if (!match) return null;
  let hour = Number(match[1].match(/^\d+/)[0]);
  const minute = Number(match[1].match(/:(\d{2})/)[1]);
  const suffix = match[1].match(/(AM|PM)$/i)[1].toUpperCase();
  if (hour > 12 || minute > 59) return null;
  if (suffix === "AM" && hour === 12) hour = 0;
  if (suffix === "PM" && hour < 12) hour += 12;
  return {
    raw_time: match[1],
    raw_timezone: clean(match[2], 80),
    clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
  };
}

function venueFromBody(value, timeMatch) {
  const source = textFromHtml(value);
  const afterTime = source.slice((timeMatch?.index || 0) + (timeMatch?.[0]?.length || 0));
  const match = afterTime.match(/\bat\s+(.+?)\s*\(([^()]*)\)\s*\.\s*All documents\b/i)
    || afterTime.match(/\bat\s+(.+?)\s*\.\s*All documents\b/i);
  if (!match) return null;
  return {
    name: clean(match[1], 500),
    address: clean(match[2], 500) || null,
  };
}

function headingMatch(block) {
  return String(block).match(/<h3\b[^>]*>\s*PEP\s+Meeting\s*(?:—|–|-)?\s*([^<]*?)\s*<\/h3>/i);
}

function accordionBlocks(html) {
  return [...String(html ?? "").matchAll(/<div\b[^>]*class=["'][^"']*\baccordion\b[^"']*["'][^>]*>[\s\S]*?(?=<div\b[^>]*class=["'][^"']*\baccordion\b[^"']*["']|$)/gi)]
    .map((match) => match[0]);
}

function sectionAfterHeading(block, headingText) {
  const headings = [...String(block).matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
  const index = headings.findIndex((heading) => new RegExp(headingText, "i").test(textFromHtml(heading[1])));
  if (index < 0) return "";
  const start = headings[index].index + headings[index][0].length;
  const end = headings[index + 1]?.index ?? String(block).length;
  return String(block).slice(start, end);
}

function documentRole(label) {
  const value = clean(label).toLowerCase();
  if (/public notice\s*(?:&|and)\s*agenda/.test(value)) return "agenda";
  if (/minutes?\s+of\s+action/.test(value)) return "minutes";
  if (/contracts?\s+agenda/.test(value)) return "materials";
  if (/pep\s+sharepoint/.test(value)) return "materials";
  return null;
}

function sourceReceipt({ sourceUrl, observedAt, receipt }) {
  return receipt || {
    schema: "cityscroll.meeting_source_receipt.v1",
    source_url: sourceUrl,
    observed_at: observedAt,
    status: "ok",
    fetch_status: "snapshot",
    parser: NYCPS_PEP_CALENDAR_PARSER,
  };
}

function quarantineEntry({ blockIndex, publisherIdentifier = null, reason, detail = null }) {
  return { block_index: blockIndex, source_contract_id: NYCPS_PEP_SOURCE_CONTRACT_ID, publisher_identifier: publisherIdentifier, reason, detail };
}

function parseBlock(block, blockIndex, options) {
  const heading = headingMatch(block);
  if (!heading) return { ignored: true };
  const headingValue = textFromHtml(heading[1]);
  const date = dateFromHeading(headingValue);
  if (!date) return { quarantine: quarantineEntry({ blockIndex, reason: "missing_date", detail: headingValue || "PEP meeting heading has no date" }) };
  const time = timeFromBody(block);
  if (!time) return { quarantine: quarantineEntry({ blockIndex, publisherIdentifier: date, reason: "missing_time", detail: "PEP meeting block has no publisher clock and timezone" }) };
  const bodyText = textFromHtml(block);
  const timeMatch = textFromHtml(block).match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\s*\([^)]+\)/i);
  const venue = venueFromBody(block, timeMatch);
  const accessSection = sectionAfterHeading(block, "Accessing the Meeting and Registering for Public Comment");
  const accessLinks = hrefs(accessSection, options.sourceUrl);
  const remote = accessLinks.find((link) => /remotely|join|access/i.test(accessSection) && /learndoe|zoom|teams|webex|meet\.google/i.test(link.href)) || null;
  const speaker = accessLinks.find((link) => /speaker|sign.?up|public comment/i.test(accessSection) && /form|register|google/i.test(link.href)) || null;
  const written = accessLinks.find((link) => /written public comment/i.test(link.label)) || null;
  const participationLinks = [
    remote && { label: "Join remotely", url: remote.href },
    speaker && { label: "Register for public comment", url: speaker.href },
    written && { label: "Submit written public comment", url: written.href },
  ].filter(Boolean);
  const documentRegion = accessSection ? block.slice(0, block.indexOf(accessSection)) : block;
  const documents = [];
  const unrelated = [];
  for (const link of hrefs(documentRegion, options.sourceUrl)) {
    const role = documentRole(link.label);
    if (!role) {
      if (/sharepoint|agenda|minutes|document|notice|contract/i.test(link.label)) {
        unrelated.push(quarantineEntry({ blockIndex, publisherIdentifier: date, reason: "unrelated_document", detail: link.label }));
      }
      continue;
    }
    documents.push({ role, document_id: link.href, document_url: link.href, source_url: options.sourceUrl });
  }
  const receipt = sourceReceipt(options);
  const record = normalizePublicBodyCalendarMeeting({
    source_contract_id: NYCPS_PEP_SOURCE_CONTRACT_ID,
    publisher_identifier: date,
    title: "Panel for Educational Policy meeting",
    description: bodyText,
    event_date: `${date}T${time.clock}`,
    timezone: NYCPS_PEP_TIMEZONE,
    source_raw_timezone: time.raw_timezone,
    source_raw_values: { heading: headingValue, date, time: time.raw_time, timezone: time.raw_timezone },
    source_url: options.sourceUrl,
    source_receipt: receipt,
    temporal_basis: "explicit_instance",
    schedule_basis: "publisher_event",
    institution_ref: "nycps:panel-for-educational-policy",
    meeting_origin: "official_nycps_pep_schedule",
    activity: "speak",
    speaking_rights: speaker ? "requires_registration" : "unknown",
    venue,
    observer_access: remote ? { remote_join_url: remote.href } : null,
    participation: {
      links: participationLinks,
      remote_join_url: remote?.href || null,
      source_url: options.sourceUrl,
    },
    access_steps: [
      remote && { kind: "remote_access", destination: remote.href, source_url: options.sourceUrl },
      speaker && { kind: "public_comment_registration", destination: speaker.href, source_url: options.sourceUrl },
      written && { kind: "written_public_comment", destination: written.href, source_url: options.sourceUrl },
    ].filter(Boolean),
  });
  const meetingDocuments = documents.map((document) => ({
    ...document,
    meeting_id: record.meeting_id,
    publisher_identifier: date,
    attachment_status: "attached",
    adapter: NYCPS_PEP_CALENDAR_PARSER,
    source_receipt: receipt,
  }));
  return {
    record: { ...record, meeting_documents: meetingDocuments },
    documents: meetingDocuments,
    quarantine: unrelated,
  };
}

/** Parse only headed NYCPS PEP meeting accordions from a frozen HTML snapshot. */
export function parseNycpsPepScheduleHtml(html, {
  sourceUrl = NYCPS_PEP_SOURCE_URL,
  observedAt = null,
  sourceRevision = null,
  receipt = null,
} = {}) {
  const options = { sourceUrl, observedAt, sourceRevision, receipt };
  const rows = [];
  const documents = [];
  const quarantine = [];
  const seen = new Set();
  for (const [blockIndex, block] of accordionBlocks(html).entries()) {
    const parsed = parseBlock(block, blockIndex, options);
    if (parsed.ignored) continue;
    if (!parsed.record) { quarantine.push(parsed.quarantine); continue; }
    if (seen.has(parsed.record.publisher_identifier)) {
      quarantine.push(quarantineEntry({
        blockIndex,
        publisherIdentifier: parsed.record.publisher_identifier,
        reason: "identity_collision",
        detail: "nycps_pep publisher identity is the local meeting date",
      }));
      continue;
    }
    seen.add(parsed.record.publisher_identifier);
    rows.push(parsed.record);
    documents.push(...parsed.documents);
    quarantine.push(...parsed.quarantine);
  }
  return {
    schema: NYCPS_PEP_CALENDAR_SCHEMA,
    source_contract_id: NYCPS_PEP_SOURCE_CONTRACT_ID,
    source_url: sourceUrl,
    generated_at: observedAt || null,
    source_revision: sourceRevision,
    rows,
    records: rows,
    documents,
    quarantine,
    population: {
      input_block_count: accordionBlocks(html).length,
      admitted_meeting_count: rows.length,
      quarantined_count: quarantine.length,
    },
  };
}

export const parseNycpsPepSchedule = parseNycpsPepScheduleHtml;
export const parseNycpsPepMeetingBlocks = parseNycpsPepScheduleHtml;
