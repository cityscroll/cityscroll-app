/** BSA native agenda projection.
 *
 * The City Record notice is a container for the dated agenda, not the daily
 * session identity. This adapter keeps each dated section and its case items
 * separate while retaining an explicit, evidence-bearing contains_schedule
 * relation back to the notice.
 */

import { normalizeBsaCalendarMeeting } from "./meeting_object_contract.mjs";

export const BSA_CALENDAR_SCHEMA = "cityscroll.bsa_calendar.v1";
export const BSA_CONTAINS_SCHEDULE_RELATION = "contains_schedule";
export const BSA_AGENDA_DOCUMENT_URL = "https://www.nyc.gov/assets/bsa/downloads/pdf/lineup/september_14_15_2026_public_hearing.pdf";

const MONTHS = Object.freeze({ january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 });
const CASE_ID = /\b\d{4}-\d{1,3}-(?:BZ(?:I{0,4})?|A(?:I{0,4})?)\b/g;

function clean(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
}

function dateFromHeading(value) {
  const match = clean(value).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
  if (!match || !match[3]) return null;
  return `${match[3]}-${String(MONTHS[match[1].toLowerCase()]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
}

const MONTH_DAY_YEAR = "(January|February|March|April|May|June|July|August|September|October|November|December)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})";
const WEEKDAY_PREFIX = "(?:Monday|Tuesday|Wednesday|Thursday|Friday)?\\s*,?\\s*";
const CLOCK_TIME = "\\d{1,2}:\\d{2}\\s*(?:A\\.?M\\.?|P\\.?M\\.?)";

/**
 * Prefer the hearing-header date (Month Day, Year followed by a clock time).
 * Skip "Notice published …" evidence times and page-footer publication dates
 * that lack a session clock (e.g. "September 9, 2026  22 READE STREET").
 */
function sessionDateMatch(text) {
  const cleaned = clean(text);
  const timed = new RegExp(`${WEEKDAY_PREFIX}${MONTH_DAY_YEAR}(?=\\s*,?\\s*${CLOCK_TIME})`, "gi");
  for (const match of cleaned.matchAll(timed)) {
    const prefix = cleaned.slice(Math.max(0, match.index - 48), match.index);
    if (/Notice\s+published\b[^.;]*$/i.test(prefix)) continue;
    const clock = cleaned.slice(match.index + match[0].length).match(new RegExp(`^\\s*,?\\s*(${CLOCK_TIME})`, "i"));
    return { date_text: match[0], index: match.index, session_clock: clock?.[1]?.trim() || null };
  }
  const bare = new RegExp(`${WEEKDAY_PREFIX}${MONTH_DAY_YEAR}`, "gi");
  for (const match of cleaned.matchAll(bare)) {
    const prefix = cleaned.slice(Math.max(0, match.index - 48), match.index);
    const suffix = cleaned.slice(match.index + match[0].length, match.index + match[0].length + 48);
    if (/Notice\s+published\b/i.test(prefix)) continue;
    if (/22\s+READE\s+STREET/i.test(suffix)) continue;
    if (/^\s*\d+\s*\/\s*\d+\b/.test(suffix)) continue;
    return { date_text: match[0], index: match.index, session_clock: null };
  }
  return null;
}

function normalizeClock(value) {
  const normalized = clean(value);
  if (/^\d{2}:\d{2}:\d{2}$/.test(normalized)) return normalized;
  const match = normalized.replace(/\./g, "").match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[3].toUpperCase() === "AM" && hour === 12) hour = 0;
  if (match[3].toUpperCase() === "PM" && hour < 12) hour += 12;
  if (hour > 23 || Number(match[2]) > 59) return null;
  return `${String(hour).padStart(2, "0")}:${match[2]}:00`;
}

function sectionRole(value) {
  const text = clean(value).toUpperCase();
  if (/ADJOURN/.test(text)) return "adjournments";
  if (/APPEALS/.test(text)) return "appeals_calendar";
  if (/SPECIAL ORDER/.test(text)) return "special_order_calendar";
  if (/ZONING/.test(text)) return "zoning_calendar";
  return "agenda";
}

function caseItem(text, caseId, section, sourceSpan) {
  const start = text.indexOf(caseId);
  const nextIndex = text.slice(start + caseId.length).search(CASE_ID);
  const excerpt = text.slice(start, nextIndex >= 0 ? start + caseId.length + nextIndex : start + 1_200).trim();
  const address = excerpt.match(/PREMISES AFFECTED\s*[–-]?\s*(.+?)(?=COMMUNITY BOARD|$)/i)?.[1]?.trim() || null;
  const board = excerpt.match(/COMMUNITY BOARD\s*#?\s*(\d{1,2})(BK|BX|MN|QN|SI)/i);
  const boroughCode = { BK: "K", BX: "X", MN: "M", QN: "Q", SI: "R" }[board?.[2]?.toUpperCase()];
  const communityDistrict = board && boroughCode ? `${boroughCode}${String(board[1]).padStart(2, "0")}` : null;
  const status = section === "adjournments" ? "adjourned" : "scheduled";
  return {
    item_id: `bsa:item:${caseId}`,
    case_id: caseId,
    section,
    lifecycle: { state: status, basis: status === "adjourned" ? "published_agenda_section" : "published_agenda_item" },
    disposition: null,
    affected_area: {
      addresses: address ? [address.replace(/\s+/g, " ").replace(/[,.]$/, "")] : [],
      community_boards: board ? [`${board[1]}${board[2].toUpperCase()}`] : [],
      community_districts: communityDistrict ? [communityDistrict] : [],
    },
    source_span: sourceSpan,
  };
}

function sectionBefore(text, offset) {
  const headings = [...text.slice(0, offset).matchAll(/\b(ADJOURNMENTS|DEFERRALS|WITHDRAWALS|DECISIONS|SPECIAL ORDER CALENDAR|CONTINUED HEARINGS|NEW CASES|APPEALS \(A\) CALENDAR|ZONING \(BZ\) CALENDAR)\b/gi)];
  return sectionRole(headings.at(-1)?.[1] || "agenda");
}

export function createBsaContainsScheduleRelation(notice, sessions = []) {
  const source = notice?.source_url || (notice?.request_id ? `https://a856-cityrecord.nyc.gov/RequestDetail/${notice.request_id}` : null);
  return {
    relation: BSA_CONTAINS_SCHEDULE_RELATION,
    from: notice?.request_id ? `meeting:city_record:${notice.request_id}` : null,
    to: sessions.map((session) => session.meeting_id),
    source,
    source_spans: sessions.map((session) => session.source_span).filter(Boolean),
    method: "explicit_dated_agenda_sections",
  };
}

export function parseBsaAgendaPages({ pages = [], notice = {}, publication_date = null } = {}) {
  const sections = [];
  let active = null;
  for (const page of pages) {
    const rawText = page?.text || page?.html;
    const text = clean(rawText);
    const match = sessionDateMatch(rawText);
    if (match) {
      const date = dateFromHeading(match.date_text);
      if (date && !sections.some((section) => section.date === date)) {
        active = { date, text: "", pages: [], date_phrase: clean(match.date_text), start_time: normalizeClock(match.session_clock), time_phrase: match.session_clock, source_span: { page: page.page || page.number || null, start: match.index, end: text.length }, source_url: page.source_url || null };
        sections.push(active);
      } else {
        active = sections.find((section) => section.date === date) || active;
        if (active && !active.start_time) {
          active.date_phrase = clean(match.date_text);
          active.start_time = normalizeClock(match.session_clock);
          active.time_phrase = match.session_clock;
        }
      }
    }
    if (active) {
      active.text += ` ${text}`;
      active.pages.push(page);
      active.source_span.end = text.length;
    }
  }
  sections.sort((a, b) => a.date.localeCompare(b.date));
  return sections.map((section, index) => {
    const caseIds = [...section.text.matchAll(CASE_ID)].map((match) => match[0]);
    const uniqueCaseIds = [...new Set(caseIds)];
    const items = uniqueCaseIds.map((caseId) => caseItem(section.text, caseId, sectionBefore(section.text, section.text.indexOf(caseId)), section.source_span));
    const remote = [...section.text.matchAll(/https:\/\/[^\s<>"']*(?:register|registration)[^\s<>"']*/gi)].map((match) => match[0].replace(/[),.;]+$/, ""))[0] || null;
    const registration = pageRegistration(section.pages, section.date) || remote;
    return buildBsaSession({
      session_id: `bsa-${section.date}`,
      date: section.date,
      date_phrase: section.date_phrase,
      start_time: section.start_time,
      time_phrase: section.time_phrase,
      source_url: section.source_url || notice.agenda_url || BSA_AGENDA_DOCUMENT_URL,
      remote_registration_url: registration,
      notice,
      items,
      source_span: section.source_span,
      publication_date,
      sequence: index,
    });
  });
}

function pageRegistration(pages, date) {
  const page = pages.find((candidate) => candidate?.date === date);
  return page?.remote_registration_url || null;
}

export function buildBsaSession({ session_id, date, date_phrase = null, start_time = null, time_phrase = null, source_url, remote_registration_url, notice = {}, items = [], source_span = null, publication_date = null, sequence = null } = {}) {
  const phases = [
    { id: `${session_id}:executive-review`, kind: "executive_review", state: "observation", access: "watch" },
    { id: `${session_id}:public-hearing`, kind: "public_hearing", state: "applicant_response_and_public_testimony", access: "register_to_testify" },
  ];
  const clock = normalizeClock(start_time);
  const eventDate = clock ? `${date}T${clock}` : date;
  const timeEvidence = clock && source_url ? {
    locator: { type: "agenda_session_header", date, time: time_phrase || start_time },
    excerpt: `${date_phrase || date}${time_phrase ? `, ${time_phrase}` : ` ${start_time}`}`,
    source_url,
  } : null;
  const row = normalizeBsaCalendarMeeting({
    bsa_session_id: session_id,
    event_date: eventDate,
    temporal_basis: clock ? "publisher_document" : null,
    title: `Board of Standards and Appeals hearing — ${date}`,
    source_url,
    agenda_url: source_url,
    venue: { name: "Spector Hall", address: "22 Reade Street, New York, NY 10007", role: "venue" },
    activity: "observe",
    observer_access: { watch_url: "https://www.youtube.com/@NYCBSA", remote_join_url: remote_registration_url },
    participation: { links: [{ label: "BSA attendance procedures", url: "https://www.nyc.gov/site/bsa/public-hearings/procedures-for-attendance.page" }] },
    access_steps: [{ kind: "observer_instructions", destination: "https://www.nyc.gov/site/bsa/public-hearings/public-hearing-format.page", source_url: "https://www.nyc.gov/site/bsa/public-hearings/public-hearing-format.page" }],
    agenda_items: items,
    phases,
    source_record_id: session_id,
    source_receipt: { schema: "cityscroll.document_processing_receipt.v1", status: "ok", parser: "bsa_agenda_sections_v1", publication_date, source_url },
    provenance: { basis: "explicit_dated_agenda_section", source_span },
  });
  return { ...row, schema: BSA_CALENDAR_SCHEMA, sequence, source_span, publication_date, agenda_items: items, phases, notice_id: notice.request_id || null, source_url, remote_registration_url, ...(timeEvidence ? { source_entry_evidence: timeEvidence } : {}) };
}

export { bsaCalendarOccurrences } from "./observer_calendar_occurrences.mjs";
