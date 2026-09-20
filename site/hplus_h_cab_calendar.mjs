import { normalizePublicBodyCalendarMeeting } from "./public_body_calendar_contract.mjs";

export const HPLUS_H_CAB_CALENDAR_SCHEMA = "cityscroll.hplus_h_cab_calendar.v1";
export const HPLUS_H_CAB_SOURCE_CONTRACT_ID = "hplus_h_cab";
export const HPLUS_H_CAB_SOURCE_URL = "https://www.nychealthandhospitals.org/public-meetings-notices/cabmeetings/";
export const HPLUS_H_CAB_CALENDAR_PARSER = "hplus_h_cab_recurrence_v1";
export const HPLUS_H_CAB_TIMEZONE = "America/New_York";
export const HPLUS_H_CAB_TEMPORAL_BASIS = "published_recurrence";

const WEEKDAYS = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});
const WEEKDAY_NAMES = Object.freeze(Object.keys(WEEKDAYS));
const ORDINALS = Object.freeze({
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  "1st": 1,
  "2nd": 2,
  "3rd": 3,
  "4th": 4,
  "5th": 5,
});
const ORDINAL_PATTERN = "(?:first|second|third|fourth|fifth|\\d+(?:st|nd|rd|th)?)";
const WEEKDAY_PATTERN = `(?:${WEEKDAY_NAMES.join("|")})`;
const RECURRENCE_PATTERN = new RegExp(
  `\\b(${ORDINAL_PATTERN})\\s+(${WEEKDAY_PATTERN})\\s+of\\s+(?:each|every)\\s+month\\s*,?\\s*(\\d{1,2}\\s*:\\s*\\d{2}\\s*(?:a\\.?m\\.?|p\\.?m.?))\\b`,
  "ig",
);
const RECURRENCE_CANDIDATE_PATTERN = new RegExp(
  `\\b(${ORDINAL_PATTERN})\\s+(${WEEKDAY_PATTERN})\\b|\\b(${WEEKDAY_PATTERN})\\b[^\\n]{0,100}\\bmonth\\b`,
  "i",
);
const LINK_MARKER = /\[\[link:([^|]*)\|([^\]]*)\]\]/gi;

function text(value, max = 4_000) {
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
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function officialUrl(value, base = HPLUS_H_CAB_SOURCE_URL) {
  try {
    const url = new URL(decodeEntities(String(value || "")), base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function slug(value) {
  return text(value, 240)
    .replace(/^NYC\s+Health\s*\+\s*Hospitals\s*[/:-]?\s*/i, "")
    .replace(/^Community\s+Advisory\s+Board\s*[:\-]?\s*/i, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sourceLines(html) {
  const marked = String(html ?? "")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_match, href, label) => `[[link:${officialUrl(href) || ""}|${decodeEntities(label).replace(/<[^>]*>/g, " ")}]]`)
    .replace(/<\/?(?:br|p|div|li|h[1-6]|tr|td|dt|dd|section|article|ul|ol)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const rawLines = decodeEntities(marked)
    .split(/\n+/)
    .map((line) => text(line, 4_000))
    .filter(Boolean);
  const lines = [];
  for (const line of rawLines) {
    const prior = lines.at(-1);
    if (prior && /\[\[link:[^\]]*\]\]\s*$/i.test(prior)
      && !/\[\[link:/i.test(line)) {
      lines[lines.length - 1] = text(`${prior} ${line}`, 4_000);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function lineWithoutMarkers(value) {
  return text(String(value).replace(LINK_MARKER, (_match, _href, label) => label));
}

function facilityFromLine(line, matchIndex) {
  const before = String(line).slice(0, matchIndex);
  const links = [...before.matchAll(LINK_MARKER)];
  if (links.length) {
    const link = links.at(-1);
    return {
      name: text(link[2], 240),
      source_url: officialUrl(link[1]),
    };
  }
  const candidate = lineWithoutMarkers(before)
    .split(/\s+(?:[-–—:]|•)\s+|\s+—\s+|\s+-\s+/)
    .at(-1);
  const name = text(candidate)
    .replace(/^(?:cab|community\s+advisory\s+board)\s*[:\-]?\s*/i, "")
    .replace(/\s+(?:cab|community\s+advisory\s+board)\s*$/i, "")
    .trim();
  return name ? { name, source_url: null } : null;
}

function parseOrdinal(value) {
  const normalized = text(value).toLowerCase();
  if (Object.hasOwn(ORDINALS, normalized)) return ORDINALS[normalized];
  const numeric = normalized.match(/^(\d+)(?:st|nd|rd|th)?$/);
  return numeric ? Number(numeric[1]) : null;
}

function parseClock(value) {
  const raw = text(value, 100).replace(/\s*:\s*/g, ":").replace(/\./g, "");
  const match = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3].toUpperCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (suffix === "AM" && hour === 12) hour = 0;
  if (suffix === "PM" && hour < 12) hour += 12;
  return {
    raw: text(value, 100),
    clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    display: `${String(hour > 12 ? hour - 12 : hour || 12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${suffix}`,
  };
}

function recurrenceReceipt({ sourceUrl, observedAt, receipt }) {
  return receipt || {
    schema: "cityscroll.meeting_source_receipt.v1",
    source_url: sourceUrl,
    observed_at: observedAt || null,
    status: "ok",
    fetch_status: "snapshot",
    parser: HPLUS_H_CAB_CALENDAR_PARSER,
  };
}

function quarantine(reason, details = {}) {
  return { adapter: HPLUS_H_CAB_CALENDAR_PARSER, source_contract_id: HPLUS_H_CAB_SOURCE_CONTRACT_ID, reason, ...details };
}

function normalizedRule({ facility, ordinal, weekday, clock, line, sourceUrl }) {
  const facilitySlug = slug(facility.name);
  return {
    facility_name: facility.name,
    facility_slug: facilitySlug,
    facility_url: facility.source_url || null,
    ordinal,
    ordinal_label: Object.entries(ORDINALS).find(([, value]) => value === ordinal)?.[0] || `${ordinal}th`,
    weekday: weekday.toLowerCase(),
    weekday_number: WEEKDAYS[weekday.toLowerCase()],
    time: clock.clock,
    raw_time: clock.raw,
    source_url: sourceUrl,
    source_text: text(line, 1_000),
    temporal_basis: HPLUS_H_CAB_TEMPORAL_BASIS,
  };
}

function dateOnly(value) {
  const candidate = text(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const date = new Date(`${candidate}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === candidate ? candidate : null;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonths(value, months) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months, 1);
  return date.toISOString().slice(0, 10);
}

function horizonFor({ observedAt, horizonStart, horizonEnd, from, through, startDate, endDate, horizon } = {}) {
  const observedDate = dateOnly(observedAt) || dateOnly(String(observedAt || "").slice(0, 10));
  const explicitStart = dateOnly(horizonStart || from || startDate || horizon?.start);
  // determinism-lint: allow clock default rolling horizon begins at observation time or today when neither is supplied
  const today = new Date().toISOString().slice(0, 10);
  const start = explicitStart || observedDate || today;
  const end = dateOnly(horizonEnd || through || endDate || horizon?.end) || addDays(addMonths(start, 12), -1);
  if (end < start) throw new RangeError("H+H CAB recurrence horizon_end must not precede horizon_start");
  return { start, end };
}

function nthWeekdayInMonth(year, month, ordinal, weekday) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (ordinal - 1) * 7;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCMonth() === month - 1 ? candidate.toISOString().slice(0, 10) : null;
}

function monthlyDates(rule, start, end) {
  const dates = [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  const final = new Date(`${end.slice(0, 7)}-01T00:00:00Z`);
  while (cursor <= final) {
    const date = nthWeekdayInMonth(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, rule.ordinal, rule.weekday_number);
    if (date && date >= start && date <= end) dates.push(date);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
  }
  return dates;
}

function explicitIdentity(value) {
  const row = value && typeof value === "object" ? value : {};
  const facility = row.facility_slug
    || row.source_raw_values?.facility_slug
    || row.facility_ref
    || row.publisher_identifier?.split(":")[0];
  const date = text(row.event_date || row.date || row.schedule?.raw_date || row.schedule?.starts_at)?.slice(0, 10);
  return facility && date ? `${slug(facility)}:${date}` : null;
}

function projectionRow(rule, date, receipt, sourceUrl, observedAt, sourceRevision) {
  const publisherIdentifier = `${rule.facility_slug}:${date}`;
  const meeting = normalizePublicBodyCalendarMeeting({
    source_contract_id: HPLUS_H_CAB_SOURCE_CONTRACT_ID,
    publisher_identifier: publisherIdentifier,
    title: `${rule.facility_name} Community Advisory Board meeting`,
    description: "Monthly Community Advisory Board meeting projected from the facility's published recurrence.",
    event_date: `${date}T${rule.time}`,
    raw_date: date,
    raw_time: rule.raw_time,
    timezone: HPLUS_H_CAB_TIMEZONE,
    schedule: {
      basis: HPLUS_H_CAB_TEMPORAL_BASIS,
      raw_date: date,
      raw_time: rule.raw_time,
      source_url: sourceUrl,
      observed_at: receipt?.observed_at || observedAt || null,
    },
    source_url: sourceUrl,
    official_source_url: sourceUrl,
    source_receipt: receipt,
    source_revision: sourceRevision,
    temporal_basis: HPLUS_H_CAB_TEMPORAL_BASIS,
    schedule_basis: HPLUS_H_CAB_TEMPORAL_BASIS,
    institution_ref: "health-and-hospitals:community-advisory-boards",
    relationship_classification: "facility_associated_advisory_board",
    activity: "observe",
    speaking_rights: "unknown",
    meeting_origin: "official_hplus_h_cab_recurrence",
    facility_slug: rule.facility_slug,
    facility_name: rule.facility_name,
    source_raw_values: {
      facility_name: rule.facility_name,
      facility_slug: rule.facility_slug,
      ordinal: rule.ordinal,
      weekday: rule.weekday,
      raw_time: rule.raw_time,
      recurrence: `${rule.ordinal_label} ${rule.weekday} of each month`,
      source_text: rule.source_text,
      derived: true,
      temporal_basis: HPLUS_H_CAB_TEMPORAL_BASIS,
    },
  });
  return {
    ...meeting,
    facility_slug: rule.facility_slug,
    facility_name: rule.facility_name,
  };
}

function optionValue(options, names) {
  for (const name of names) {
    if (options[name] != null) return options[name];
  }
  return null;
}

/** Parse facility-specific monthly CAB recurrences from a frozen official page. */
export function parseHplusHCabScheduleHtml(html, options = {}) {
  const sourceUrl = officialUrl(options.sourceUrl || options.source_url) || HPLUS_H_CAB_SOURCE_URL;
  const observedAt = options.observedAt || options.observed_at || null;
  const receipt = recurrenceReceipt({ sourceUrl, observedAt, receipt: options.receipt || options.sourceReceipt || options.source_receipt });
  const lines = sourceLines(html);
  const rulesByFacility = new Map();
  const duplicateFacilities = new Set();
  const quarantined = [];

  for (const line of lines) {
    const matches = [...line.matchAll(RECURRENCE_PATTERN)];
    if (!matches.length) {
      if (RECURRENCE_CANDIDATE_PATTERN.test(line) && /\b(?:each|every)\s+month\b/i.test(line)) {
        quarantined.push(quarantine("malformed_recurrence", { excerpt: line }));
      }
      continue;
    }
    for (const match of matches) {
      const facility = facilityFromLine(line, match.index);
      const ordinal = parseOrdinal(match[1]);
      const weekday = match[2].toLowerCase();
      const clock = parseClock(match[3]);
      if (!facility) {
        quarantined.push(quarantine("missing_facility", { excerpt: line }));
        continue;
      }
      if (!ordinal || ordinal < 1 || ordinal > 5) {
        quarantined.push(quarantine("malformed_ordinal", { facility_name: facility.name, value: match[1], excerpt: line }));
        continue;
      }
      if (!Object.hasOwn(WEEKDAYS, weekday)) {
        quarantined.push(quarantine("malformed_weekday", { facility_name: facility.name, value: match[2], excerpt: line }));
        continue;
      }
      if (!clock) {
        quarantined.push(quarantine("malformed_time", { facility_name: facility.name, value: match[3], excerpt: line }));
        continue;
      }
      const rule = normalizedRule({ facility, ordinal, weekday, clock, line, sourceUrl });
      if (!rule.facility_slug) {
        quarantined.push(quarantine("missing_facility", { excerpt: line }));
        continue;
      }
      if (rulesByFacility.has(rule.facility_slug)) {
        const prior = rulesByFacility.get(rule.facility_slug);
        rulesByFacility.delete(rule.facility_slug);
        duplicateFacilities.add(rule.facility_slug);
        quarantined.push(quarantine("duplicate_facility_rule", {
          facility_slug: rule.facility_slug,
          records: [prior.source_text, rule.source_text],
        }));
        continue;
      }
      if (duplicateFacilities.has(rule.facility_slug)) {
        quarantined.push(quarantine("duplicate_facility_rule", { facility_slug: rule.facility_slug, excerpt: line }));
        continue;
      }
      rulesByFacility.set(rule.facility_slug, rule);
    }
  }

  const rules = [...rulesByFacility.values()].sort((left, right) => left.facility_slug.localeCompare(right.facility_slug));
  const projected = projectHplusHCabRecurrences({
    rules,
    ...options,
    sourceUrl,
    observedAt,
    receipt,
  });
  return {
    schema: HPLUS_H_CAB_CALENDAR_SCHEMA,
    source_contract_id: HPLUS_H_CAB_SOURCE_CONTRACT_ID,
    source_url: sourceUrl,
    generated_at: observedAt,
    source_revision: options.sourceRevision || options.source_revision || null,
    source_receipt: receipt,
    rules,
    rule_count: rules.length,
    horizon: projected.horizon,
    rows: projected.rows,
    records: projected.rows,
    projected_rows: projected.projected_rows,
    historical_rows: projected.historical_rows,
    retired_rules: projected.retired_rules,
    superseded: projected.superseded,
    quarantined,
    quarantine: quarantined,
    rejected: quarantined,
    coverage: [{
      source_contract_id: HPLUS_H_CAB_SOURCE_CONTRACT_ID,
      status: "fresh",
      row_count: projected.rows.length,
      observed_at: receipt?.observed_at || observedAt || null,
    }],
    population: {
      input_line_count: lines.length,
      parsed_rule_count: rules.length,
      admitted_occurrence_count: projected.rows.length,
      quarantined_count: quarantined.length,
    },
  };
}

/** Project valid recurrence rules into an inclusive, date-bounded local horizon. */
export function projectHplusHCabRecurrences(input = {}, options = {}) {
  const config = Array.isArray(input) ? { rules: input, ...options } : { ...input, ...options };
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const horizon = horizonFor(config);
  const sourceUrl = officialUrl(config.sourceUrl || config.source_url) || HPLUS_H_CAB_SOURCE_URL;
  const observedAt = config.observedAt || config.observed_at || null;
  const receipt = recurrenceReceipt({ sourceUrl, observedAt, receipt: config.receipt || config.sourceReceipt || config.source_receipt });
  const sourceRevision = config.sourceRevision || config.source_revision || null;
  const explicitRows = optionValue(config, ["explicitInstances", "explicit_instances", "explicitRows", "explicit_rows"]) || [];
  const explicitKeys = new Map(explicitRows.map((row) => [explicitIdentity(row), row]).filter(([key]) => key));
  const projectedRows = [];
  const superseded = [];
  for (const rule of rules) {
    for (const date of monthlyDates(rule, horizon.start, horizon.end)) {
      const row = projectionRow(rule, date, receipt, sourceUrl, observedAt, sourceRevision);
      const explicit = explicitKeys.get(`${rule.facility_slug}:${date}`);
      if (explicit) {
        superseded.push({
          derived_meeting_id: row.meeting_id,
          explicit_meeting_id: explicit.meeting_id || explicit.publisher_identifier || null,
          facility_slug: rule.facility_slug,
          date,
          relation: "explicit_instance_supersedes_published_recurrence",
          evidence: { source_url: explicit.source_url || explicit.official_source_url || null },
        });
        continue;
      }
      projectedRows.push(row);
    }
  }
  const previous = config.previousIndex || config.previous_index || {};
  const previousRows = Array.isArray(config.previousRows || config.previous_rows)
    ? (config.previousRows || config.previous_rows)
    : Array.isArray(previous.rows) ? previous.rows : [];
  const historicalRows = previousRows.filter((row) => {
    const date = text(row.event_date || row.schedule?.starts_at || row.date)?.slice(0, 10);
    return date && date < horizon.start;
  });
  const previousRules = Array.isArray(config.previousRules || config.previous_rules)
    ? (config.previousRules || config.previous_rules)
    : Array.isArray(previous.rules) ? previous.rules : [];
  const currentRuleSlugs = new Set(rules.map((rule) => rule.facility_slug));
  const retiredRules = previousRules
    .filter((rule) => rule?.facility_slug && !currentRuleSlugs.has(rule.facility_slug))
    .map((rule) => ({ ...rule, retired_at: receipt?.observed_at || observedAt || null, disposition: "future_derivations_retired" }));
  return {
    horizon,
    rows: [...historicalRows, ...projectedRows].sort((left, right) => String(left.event_date).localeCompare(String(right.event_date)) || String(left.meeting_id).localeCompare(String(right.meeting_id))),
    projected_rows: projectedRows,
    historical_rows: historicalRows,
    retired_rules: retiredRules,
    superseded,
  };
}

export const parseHplusHCabSchedule = parseHplusHCabScheduleHtml;
export const parseHplusHCabMeetingRules = parseHplusHCabScheduleHtml;
export const buildHplusHCabCalendarIndex = parseHplusHCabScheduleHtml;
export const buildHplusHCabRecurrenceIndex = parseHplusHCabScheduleHtml;
