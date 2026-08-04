/**
 * Typed, source-receipted dates from reader-visible Property Disposition prose.
 *
 * Every event keeps an exact character span into its source field. Pattern rules
 * are deliberately narrow: a date-shaped phrase without a matching action/event
 * anchor remains absent instead of being assigned a guessed meaning.
 */

export const PROPERTY_TIMED_EVENT_SCHEMA = "cityscroll.property_timed_event.v1";

export const PROPERTY_TIMED_EVENT_KINDS = Object.freeze([
  "hearing",
  "auction_window",
  "auction",
  "sale",
  "bid_deadline",
  "inspection_showing",
  "accommodation_deadline",
  "objection_deadline",
  "comment_deadline",
  "result_award",
]);

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});
const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
const DAY = "(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?";
const YEAR = "(?:19|20)\\d{2}";
const CLOCK = "(?:\\s*(?:at|,)\\s*|\\s+)(?:0?[1-9]|1[0-2])(?::[0-5]\\d)?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)";
const WORD_DATE_TOKEN = `${MONTH}\\s+${DAY},?\\s+${YEAR}`;
const NUMERIC_DATE_TOKEN = "(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\\d|3[01])[/-](?:\\d{2}|(?:19|20)\\d{2})";
const DATE_TOKEN = `(?:${WORD_DATE_TOKEN}|${NUMERIC_DATE_TOKEN})(?:${CLOCK})?`;
const DATE_RE = new RegExp(`\\b(${DATE_TOKEN})`, "gi");
const PARSE_DATE_RE = new RegExp(
  `^(${MONTH})\\s+(${DAY}),?\\s+(${YEAR})(?:${CLOCK})?$`,
  "i",
);
const BID_DUE_BLOCK_RE = new RegExp(
  `\\b(?:bid due date|all bid proposals? must be received)[\\s\\S]{0,520}?\\bno later than\\b[\\s\\S]{0,70}?${DATE_TOKEN}`,
  "gi",
);
const RESPONSE_DUE_BLOCK_RE = new RegExp(
  `\\bresponses? are due no later than\\b[\\s\\S]{0,120}?${DATE_TOKEN}`,
  "gi",
);
const SHOW_DATES_BLOCK_RE = new RegExp(
  `\\bshow dates?\\s*:[\\s\\S]{0,300}?${DATE_TOKEN}[\\s\\S]{0,100}?${DATE_TOKEN}`,
  "gi",
);
const SHOW_DATE_SINGLE_RE = new RegExp(
  `\\bshow dates?\\s*:[\\s\\S]{0,300}?${DATE_TOKEN}`,
  "gi",
);
const ALL_BIDS_SUBMIT_RE = new RegExp(
  `\\ball bids must be submitted by\\b[\\s\\S]{0,90}?${DATE_TOKEN}`,
  "gi",
);

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Parse an explicit English date without letting Date.parse guess. */
export function parsePropertyDateLiteral(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})/);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    const date = `${year}-${pad(month)}-${pad(day)}`;
    const clock = text.match(/(?:at|,)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
    if (!clock) return date;
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    const meridiem = clock[3].toLowerCase().replace(/\./g, "");
    if (hour === 12) hour = 0;
    if (meridiem === "pm") hour += 12;
    return `${date}T${pad(hour)}:${pad(minute)}:00`;
  }
  const match = text.match(PARSE_DATE_RE);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2].replace(/\D/g, ""));
  const year = Number(match[3]);
  const clock = text.match(/(?:at|,)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i)
    || text.match(/\s(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)$/i);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  if (!clock) return date;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] || 0);
  const meridiem = clock[3].toLowerCase().replace(/\./g, "");
  if (hour === 12) hour = 0;
  if (meridiem === "pm") hour += 12;
  return `${date}T${pad(hour)}:${pad(minute)}:00`;
}

function literalDates(text) {
  const found = [];
  DATE_RE.lastIndex = 0;
  for (const match of String(text || "").matchAll(DATE_RE)) {
    const value = parsePropertyDateLiteral(match[1]);
    if (!value) continue;
    found.push({ value, start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return found;
}

function searchableText(rawValue) {
  const raw = String(rawValue || "");
  let text = "";
  const map = [];
  const append = (value, start, end) => {
    for (const char of value) {
      if (/\s/.test(char)) {
        if (!text || text.endsWith(" ")) continue;
        text += " ";
      } else {
        text += char;
      }
      map.push({ start, end });
    }
  };
  const entities = {
    "&nbsp;": " ", "&#160;": " ", "&amp;": "&", "&quot;": "\"",
    "&#39;": "'", "&apos;": "'", "&ldquo;": "\"", "&rdquo;": "\"",
    "&lsquo;": "'", "&rsquo;": "'", "&ndash;": "–", "&mdash;": "—",
  };
  const tokenRe = /<[^>]*>|&(?:#\d+|[a-z]+);|\s+|[^<&\s]+/gi;
  for (const match of raw.matchAll(tokenRe)) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    if (token.startsWith("<")) append(" ", start, end);
    else if (token.startsWith("&")) append(entities[token.toLowerCase()] || " ", start, end);
    else if (/^\s+$/.test(token)) append(" ", start, end);
    else {
      for (let index = 0; index < token.length; index += 1) append(token[index], start + index, start + index + 1);
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

function sourceFields(row) {
  // Prefer the rendered detail body when the same event is repeated in a title.
  return ["additional_description_1", "short_title"].map((source_field) => {
    const text = String(row?.[source_field] || "");
    const searchable = searchableText(text);
    return { source_field, text, search_text: searchable.text, search_map: searchable.map };
  }).filter((source) => source.search_text.trim());
}

function exactSpan(source, start, end) {
  const first = source.search_map[start];
  const last = source.search_map[Math.max(start, end - 1)];
  const rawStart = first?.start ?? start;
  const rawEnd = last?.end ?? end;
  return { start: rawStart, end: rawEnd, text: source.text.slice(rawStart, rawEnd) };
}

function segmentMatches(source, pattern) {
  const matches = [];
  pattern.lastIndex = 0;
  for (const match of source.search_text.matchAll(pattern)) {
    matches.push({ match, start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return matches;
}

function eventFrom(source, segment, kind, dates, extra = {}) {
  return {
    schema: PROPERTY_TIMED_EVENT_SCHEMA,
    kind,
    start: null,
    end: null,
    deadline: null,
    source_field: source.source_field,
    source_span: exactSpan(source, segment.start, segment.end),
    confidence: "high",
    date_source: "literal",
    ...dates,
    ...extra,
  };
}

function addUnique(events, event) {
  const key = [event.kind, event.start, event.end, event.deadline].join("|");
  const existing = events.findIndex((item) => [item.kind, item.start, item.end, item.deadline].join("|") === key);
  if (existing < 0) events.push(event);
  else if (events[existing].source_field === "short_title" && event.source_field === "additional_description_1") events[existing] = event;
}

function structuredEventDate(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  return match[2] ? `${match[1]}T${match[2]}:${match[3]}:${match[4] || "00"}` : match[1];
}

function businessDaysBefore(isoValue, count) {
  const day = String(isoValue || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(count) || count < 1) return null;
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  let remaining = count;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() - 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

function relativeBusinessDays(text) {
  const match = String(text || "").match(/no later than\s+(?:(one|two|three|four|five|six|seven|eight|nine|ten)\s*)?(?:\((\d{1,2})\)|(\d{1,2}))?\s*business days? prior/i);
  if (!match) return null;
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return words[match[1]?.toLowerCase()] || Number(match[2] || match[3]) || null;
}

/**
 * Extract typed events from one Property notice.
 * @returns {Array<object>}
 */
export function extractPropertyTimedEvents(row = {}) {
  const events = [];

  for (const source of sourceFields(row)) {
    // Online auction windows: start/end are one event; the end is also the bid deadline.
    for (const segment of segmentMatches(source, /\b(?:online bids|online public lease auction)[\s\S]{0,320}?(?:from|begin(?:ning)?|opens?)[\s\S]{0,220}?(?:until|through|ending|closes?)[\s\S]{0,90}/gi)) {
      const dates = literalDates(segment.text);
      if (dates.length < 2) continue;
      addUnique(events, eventFrom(source, segment, "auction_window", { start: dates[0].value, end: dates[1].value }));
      if (/online bids|bids? (?:will be )?accepted/i.test(segment.text)) {
        addUnique(events, eventFrom(source, segment, "bid_deadline", { deadline: dates[1].value }));
      }
    }

    // Forest/timber showings commonly list two dates in a single Show Dates block.
    const showSegments = [
      ...segmentMatches(source, SHOW_DATES_BLOCK_RE),
      ...segmentMatches(source, SHOW_DATE_SINGLE_RE),
    ];
    for (const segment of showSegments) {
      for (const date of literalDates(segment.text).slice(0, 4)) {
        addUnique(events, eventFrom(source, segment, "inspection_showing", { start: date.value }));
      }
    }

    // Bid/proposal scope is mandatory. A free-standing "no later than" never qualifies.
    for (const segment of segmentMatches(source, BID_DUE_BLOCK_RE)) {
      const dates = literalDates(segment.text);
      if (!dates.length) continue;
      const deadline = dates.at(-1).value;
      addUnique(events, eventFrom(source, segment, "bid_deadline", { deadline }));
    }
    for (const segment of segmentMatches(source, /\bbids? will be received no later than\b[^.]{0,220}/gi)) {
      const date = literalDates(segment.text).at(-1);
      if (date) addUnique(events, eventFrom(source, segment, "bid_deadline", { deadline: date.value }));
    }
    for (const segment of segmentMatches(source, ALL_BIDS_SUBMIT_RE)) {
      const date = literalDates(segment.text).at(-1);
      if (date) addUnique(events, eventFrom(source, segment, "bid_deadline", { deadline: date.value }));
    }
    for (const segment of segmentMatches(source, RESPONSE_DUE_BLOCK_RE)) {
      const date = literalDates(segment.text).at(-1);
      if (date) addUnique(events, eventFrom(source, segment, "bid_deadline", { deadline: date.value }));
    }
    for (const segment of segmentMatches(source, /\b(?:RFP|request for proposals?)[\s\S]{0,160}?\bdue\s+[\s\S]{0,100}/gi)) {
      const dates = literalDates(segment.text);
      if (!dates.length) continue;
      addUnique(events, eventFrom(source, segment, "bid_deadline", { deadline: dates.at(-1).value }));
    }

    // Hearings need a date in the same local clause; mere references to a Hearing Section stay empty.
    for (const segment of segmentMatches(source, /\b(?:voluntary\s+)?public hearing\b[\s\S]{0,190}/gi)) {
      const date = literalDates(segment.text)[0];
      if (!date) continue;
      addUnique(events, eventFrom(source, segment, "hearing", { start: date.value }));
    }
    if (/\bpublic hearing\b/i.test(source.search_text)) {
      for (const date of literalDates(source.search_text.slice(0, 100))) {
        const end = Math.min(source.search_text.length, Math.max(100, date.end + 40));
        const segment = { start: 0, end, text: source.search_text.slice(0, end) };
        addUnique(events, eventFrom(source, segment, "hearing", { start: date.value }));
      }
    }

    // A relative accommodation rule becomes an exact weekday-derived deadline only
    // when the same notice supplies a typed hearing anchor.
    for (const segment of segmentMatches(source, /\bindividuals requesting sign language interpreters?[\s\S]{0,360}?business days? prior to the public hearing/gi)) {
      const relative = relativeBusinessDays(segment.text);
      const hearing = events.find((event) => event.kind === "hearing" && event.start);
      const deadline = hearing && relative ? businessDaysBefore(hearing.start, relative) : null;
      if (!deadline) continue;
      addUnique(events, eventFrom(source, segment, "accommodation_deadline", { deadline }, {
        date_source: "derived_from_relative_rule",
        relative_business_days_before: relative,
        relative_to: "hearing",
      }));
    }

    // Direct real-property sales use sale; result notices may still source a past auction date.
    for (const segment of segmentMatches(source, /\bpropert(?:y|ies) will be offered at public auction[\s\S]{0,90}/gi)) {
      const date = literalDates(segment.text)[0];
      if (date) addUnique(events, eventFrom(source, segment, "sale", { start: date.value }));
    }
    for (const segment of segmentMatches(source, /\b(?:medallion )?auction held\s+[\s\S]{0,70}/gi)) {
      const date = literalDates(segment.text)[0];
      if (date) addUnique(events, eventFrom(source, segment, "auction", { start: date.value }, { context: "result_notice" }));
    }

    // Result/award must name when the result is identified/announced—not merely when an auction occurred.
    for (const segment of segmentMatches(source, /\b(?:apparent highest bidders?|winning bidders?|results?) (?:will be |were |are )?(?:identified|announced|posted|selected) by[\s\S]{0,90}/gi)) {
      const date = literalDates(segment.text)[0];
      if (date) addUnique(events, eventFrom(source, segment, "result_award", { deadline: date.value }));
    }

    // Reserved action types: both the act and a literal date must be in the same clause.
    for (const [kind, pattern] of [
      ["objection_deadline", /\b(?:file|mail|send|submit|serve|interpose)[^.]{0,60}?objections?[^.]{0,180}/gi],
      ["comment_deadline", /\b(?:mail|email|send|submit)[^.]{0,60}?(?:written )?comments?[^.]{0,180}/gi],
    ]) {
      for (const segment of segmentMatches(source, pattern)) {
        const date = literalDates(segment.text).at(-1);
        if (date) addUnique(events, eventFrom(source, segment, kind, { deadline: date.value }));
      }
    }
  }

  // Structured event_date is only promoted after a deterministic pattern gives
  // it sale/auction semantics. It is never treated as a generic action deadline.
  const eventDate = structuredEventDate(row.event_date);
  const titleAndBody = sourceFields(row).map((source) => source.search_text).join(" ");
  if (eventDate && /public sale of residential property|sale\/assignment of mortgage|sale of city mort?gage and note/i.test(titleAndBody)) {
    addUnique(events, {
      schema: PROPERTY_TIMED_EVENT_SCHEMA,
      kind: "sale",
      start: eventDate,
      end: null,
      deadline: null,
      source_field: "event_date",
      source_span: { start: 0, end: String(row.event_date).length, text: String(row.event_date) },
      confidence: "medium",
      date_source: "structured_field",
    });
  } else if (eventDate && /real estate public auction/i.test(titleAndBody)) {
    addUnique(events, {
      schema: PROPERTY_TIMED_EVENT_SCHEMA,
      kind: "auction",
      start: eventDate,
      end: null,
      deadline: null,
      source_field: "event_date",
      source_span: { start: 0, end: String(row.event_date).length, text: String(row.event_date) },
      confidence: "medium",
      date_source: "structured_field",
    });
  }

  return events.sort((a, b) => {
    const ad = a.deadline || a.start || a.end || "";
    const bd = b.deadline || b.start || b.end || "";
    return ad.localeCompare(bd) || PROPERTY_TIMED_EVENT_KINDS.indexOf(a.kind) - PROPERTY_TIMED_EVENT_KINDS.indexOf(b.kind);
  });
}

function eventDay(value) {
  const day = value ? String(value).slice(0, 10) : null;
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function propertyEventState(event, today) {
  const current = eventDay(today);
  if (!current || !event) return "unknown";
  const start = eventDay(event.start || event.deadline || event.end);
  const end = eventDay(event.end || event.deadline || event.start);
  if (!start || !end) return "unknown";
  if (current > end) return "past";
  if (event.kind === "auction_window" && current >= start) return "open";
  return "upcoming";
}

/** Approved shared bands: imminent <=14 days, approaching <=90, otherwise far. */
export function propertyEventBand(event, today) {
  const state = propertyEventState(event, today);
  if (state === "past" || state === "unknown") return null;
  const boundary = eventDay(state === "open" ? event.end : (event.deadline || event.start || event.end));
  const current = eventDay(today);
  if (!boundary || !current) return null;
  const days = Math.round((Date.parse(`${boundary}T12:00:00Z`) - Date.parse(`${current}T12:00:00Z`)) / 86400000);
  if (days < 0) return null;
  if (days <= 14) return "imminent";
  if (days <= 90) return "approaching";
  return "far";
}

export function propertyEventDisplayDate(event) {
  if (!event) return null;
  if (event.kind === "auction_window") return event.end || event.start || null;
  return event.deadline || event.start || event.end || null;
}

export function primaryPropertyActionDate(events) {
  const list = Array.isArray(events) ? events : [];
  for (const kind of ["bid_deadline", "auction_window", "sale", "auction", "hearing", "result_award"]) {
    const event = list.find((item) => item?.kind === kind);
    const value = propertyEventDisplayDate(event);
    if (value) return eventDay(value);
  }
  return null;
}
