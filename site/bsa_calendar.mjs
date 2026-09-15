/** BSA native agenda projection.
 *
 * The City Record notice is a container for the dated agenda, not the daily
 * session identity. This adapter keeps each dated section and its case items
 * separate while retaining an explicit, evidence-bearing contains_schedule
 * relation back to the notice.
 */

import { createCalendarOccurrence } from "./calendar_occurrence.mjs";
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
    const text = clean(page?.text || page?.html);
    const matches = [...text.matchAll(/(?:Monday|Tuesday|Wednesday|Thursday|Friday)?\s*,?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})/gi)];
    if (matches.length) {
      const date = dateFromHeading(matches.at(-1)[0]);
      if (date && !sections.some((section) => section.date === date)) {
        active = { date, text: "", pages: [], source_span: { page: page.page || page.number || null, start: matches.at(-1).index, end: text.length }, source_url: page.source_url || null };
        sections.push(active);
      } else {
        active = sections.find((section) => section.date === date) || active;
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

export function buildBsaSession({ session_id, date, source_url, remote_registration_url, notice = {}, items = [], source_span = null, publication_date = null, sequence = null } = {}) {
  const phases = [
    { id: `${session_id}:executive-review`, kind: "executive_review", state: "observation", access: "watch" },
    { id: `${session_id}:public-hearing`, kind: "public_hearing", state: "applicant_response_and_public_testimony", access: "register_to_testify" },
  ];
  const row = normalizeBsaCalendarMeeting({
    bsa_session_id: session_id,
    event_date: `${date}T10:00:00`,
    title: `Board of Standards and Appeals hearing — ${date}`,
    source_url,
    agenda_url: source_url,
    venue: { name: "Spector Hall", address: "22 Reade Street, New York, NY 10007", role: "venue" },
    observer_access: { watch_url: "https://www.youtube.com/@NYCBSA", remote_join_url: remote_registration_url },
    participation: { links: [{ label: "BSA attendance procedures", url: "https://www.nyc.gov/site/bsa/public-hearings/procedures-for-attendance.page" }] },
    access_steps: [{ kind: "observer_instructions", destination: "https://www.nyc.gov/site/bsa/public-hearings/public-hearing-format.page", source_url: "https://www.nyc.gov/site/bsa/public-hearings/public-hearing-format.page" }],
    agenda_items: items,
    phases,
    source_record_id: session_id,
    source_receipt: { schema: "cityscroll.document_processing_receipt.v1", status: "ok", parser: "bsa_agenda_sections_v1", publication_date, source_url },
    provenance: { basis: "explicit_dated_agenda_section", source_span },
  });
  return { ...row, schema: BSA_CALENDAR_SCHEMA, sequence, source_span, publication_date, agenda_items: items, phases, notice_id: notice.request_id || null, source_url, remote_registration_url };
}

export function bsaCalendarOccurrences(sessions = []) {
  return sessions.map((session) => createCalendarOccurrence({
    uid: session.meeting_id,
    object_ref: session.meeting_id,
    kind: "event",
    title: session.title,
    starts_at: session.event_date,
    timezone: "America/New_York",
    canonical_url: `https://cityscroll.org/meetings/${encodeURIComponent(session.meeting_id)}/`,
    source: { system: "bsa_calendar", record_id: session.bsa_session_id, url: session.source_url },
    provenance: { basis: "explicit_dated_agenda_section", source_span: session.source_span },
  }));
}
