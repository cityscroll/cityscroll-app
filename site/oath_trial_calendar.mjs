import { normalizeOathTrialCalendarMeeting } from "./meeting_object_contract.mjs";

export const OATH_TRIAL_CALENDAR_SCHEMA = "cityscroll.oath_trial_calendar.v1";
export const OATH_TRIAL_CALENDAR_SOURCE_URL = "https://www.nyc.gov/site/oath/calendar/calendar.page";
export const OATH_TRIAL_CALENDAR_PARSER = "oath_trial_calendar_acquisition.v1";
export const OATH_OBSERVER_EMAIL = "OATHCalUnit@OATH.nyc.gov";

const clean = (value, max = 2_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, max);

/** Session-id token: no whitespace or controls (digest /meetings/ redirect contract). */
const idToken = (value, max = 2_000) => clean(value, max)
  .replace(/\s+/g, "-")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "");

function csvRows(csv) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < String(csv ?? "").length; i += 1) {
    const char = String(csv ?? "")[i];
    const next = String(csv ?? "")[i + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; i += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { row.push(cell); cell = ""; continue; }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((value) => clean(value))) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  if (cell || row.length) { row.push(cell); if (row.some((value) => clean(value))) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((value) => clean(value, 160).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, clean(values[index] || "")])));
}

function pick(row, names) {
  for (const name of names) if (clean(row?.[name])) return clean(row[name]);
  return null;
}

function dateParts(value) {
  const text = clean(value, 100);
  let match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](20\d{2})$/);
  if (match) return [match[3], match[1], match[2]];
  match = text.match(/^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) return [match[1], match[2], match[3]];
  match = text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})$/i);
  if (!match) return null;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1].toLowerCase()) + 1;
  return [match[3], month, match[2]];
}

function localDateTime(dateValue, timeValue) {
  const date = dateParts(dateValue);
  if (!date) return null;
  const time = clean(timeValue, 80);
  if (!time) return `${date[0]}-${String(date[1]).padStart(2, "0")}-${String(date[2]).padStart(2, "0")}`;
  const match = time.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return `${date[0]}-${String(date[1]).padStart(2, "0")}-${String(date[2]).padStart(2, "0")}`;
  let hour = Number(match[1]);
  const minute = match[2] || "00";
  if ((match[3] || "").toUpperCase() === "PM" && hour < 12) hour += 12;
  if ((match[3] || "").toUpperCase() === "AM" && hour === 12) hour = 0;
  if (hour > 23 || Number(minute) > 59) return null;
  return `${date[0]}-${String(date[1]).padStart(2, "0")}-${String(date[2]).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${minute}:00`;
}

function trialRow(row) {
  const type = pick(row, ["type", "proceeding_type", "event_type", "hearing_type", "about"]);
  return type && /\btrial\b/i.test(type) && !/conference/i.test(type);
}

function sourceFields(row) {
  const name = pick(row, ["name", "title", "case_name"]);
  const match = name?.match(/^\s*([^\s-]+)\s*-\s*(.*)$/);
  return {
    index: pick(row, ["index", "oath_index", "oath_index_number", "index_number", "case_index", "case_index_number", "case_number"]) || match?.[1] || null,
    title: match?.[2] || name || null,
    type: pick(row, ["type", "proceeding_type", "event_type", "hearing_type"]) || pick(row, ["about"]),
  };
}

export function oathTrialSessionId({ index, date, start, type }) {
  return [idToken(index, 120), idToken(date, 40), idToken(start, 40), idToken(type, 80)]
    .filter(Boolean)
    .join(":");
}

export function observerRequestForTrial(record = {}) {
  const index = clean(record.oath_index || record.source_index || record.index, 120) || "not published";
  const date = clean(record.event_date, 80) || "not published";
  const localStart = clean(record.start_time || record.event_date?.slice(11, 19), 40) || "not published";
  return `Hello OATH Calendar Unit,\n\nI would like to observe the OATH trial listed below. Please confirm whether observation is possible and provide the access instructions.\n\nIndex: ${index}\nDate: ${date.slice(0, 10)}\nLocal start time: ${localStart}\n\nThank you.`;
}

export function observerRequestMailto(record = {}) {
  const subject = `Observer access request for OATH trial ${clean(record.oath_index || record.source_index || record.index, 120) || ""}`;
  return `mailto:${OATH_OBSERVER_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(observerRequestForTrial(record))}`;
}

export function parseOathTrialCsv(csv, { sourceUrl = OATH_TRIAL_CALENDAR_SOURCE_URL, observedAt = null, sourceRevision = null, receipt = null } = {}) {
  const rows = csvRows(csv);
  const records = [];
  const seen = new Set();
  let excludedConferenceCount = 0;
  let exactDuplicateCount = 0;
  for (const row of rows) {
    if (!trialRow(row)) {
      const type = pick(row, ["type", "proceeding_type", "event_type", "hearing_type", "about"]);
      if (type && /conference/i.test(type)) excludedConferenceCount += 1;
      continue;
    }
    const fields = sourceFields(row);
    const index = fields.index;
    const dateValue = pick(row, ["date", "trial_date", "event_date", "hearing_date"]);
    const timeValue = pick(row, ["start", "start_time", "time", "trial_time", "hearing_time"]);
    const type = fields.type;
    const eventDate = localDateTime(dateValue, timeValue);
    if (!index || !eventDate) continue;
    const sessionId = oathTrialSessionId({ index, date: eventDate.slice(0, 10), start: eventDate.slice(11) || "", type });
    if (seen.has(sessionId)) {
      exactDuplicateCount += 1;
      continue;
    }
    seen.add(sessionId);
    const sourceReceipt = receipt || {
      schema: "cityscroll.meeting_source_receipt.v1", source_url: sourceUrl, observed_at: observedAt,
      source_revision: sourceRevision, status: "ok", fetch_status: "snapshot", parser: OATH_TRIAL_CALENDAR_PARSER,
    };
    records.push(normalizeOathTrialCalendarMeeting({
      oath_trial_session_id: sessionId, oath_index: index, source_index: index, source_raw_values: row,
      source_revision: sourceRevision, title: `OATH trial ${index}`, event_date: eventDate, source_url: sourceUrl,
      meeting_origin: "official_oath_trial_calendar", source_receipt: sourceReceipt, proceeding_type: type,
      start_time: eventDate.slice(11) || null,
      description: fields.title,
      venue: null, event_end: null,
    }));
  }
  return {
    schema: OATH_TRIAL_CALENDAR_SCHEMA,
    rows: records,
    records,
    documents: [],
    source_revision: sourceRevision,
    generated_at: observedAt || null,
    population: {
      input_row_count: rows.length,
      trial_session_count: records.length,
      excluded_conference_count: excludedConferenceCount,
      exact_duplicate_count: exactDuplicateCount,
    },
  };
}

export { localDateTime };
