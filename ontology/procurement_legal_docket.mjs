// Change docket for NYC procurement law: what is ABOUT to change, as data.
//
// Prototype location: this file imports its sibling register module by relative path
// ("../register/legal_register.mjs"). In cityscroll-app it lands as
// ontology/procurement_legal_docket.mjs and the single import below becomes
// "./procurement_legal_register.mjs". Node built-ins only.
//
// A docket entry never changes the register. Adoption is a separate, reviewed register change
// that the docket entry then references through `adopted_as` (id@version).
import { readFileSync } from "node:fs";
import { normalizeLegalText } from "./procurement_legal_register.mjs";

export const PROCUREMENT_LEGAL_DOCKET_SCHEMA = "cityscroll.procurement_legal_change_docket.v1";
export const PROCUREMENT_LEGAL_DOCKET_RELATIVE = "ontology/procurement_legal_change_docket.v1.json";

export const DOCKET_STATUSES = Object.freeze([
  "proposed",
  "passed_uncertified",
  "enacted_not_effective",
  "pending_signature",
  "in_force_unmodelled",
  "adopted_into_register",
  "withdrawn",
]);
/** Statuses that no longer produce due or awaiting-event rows. */
export const DOCKET_CLOSED_STATUSES = Object.freeze(["adopted_into_register", "withdrawn"]);
export const DOCKET_CLOCK_NAMES = Object.freeze(["legal_effect", "agency_rollout", "source_publication", "cityscroll_display"]);
export const DOCKET_CLOCK_STATES = Object.freeze(["pending", "reached", "not_applicable", "unknown"]);
export const DOCKET_CLOCK_TRIGGERS = Object.freeze(["date", "event"]);
export const DOCKET_INSTRUMENTS = Object.freeze(["charter_amendment", "local_law", "state_bill", "ppb_rule"]);
export const DOCKET_JURISDICTIONS = Object.freeze(["nyc", "nys", "federal"]);
export const DOCKET_REVIEW_STATUSES = Object.freeze(["unreviewed", "source_checked", "practitioner_reviewed"]);

const ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const ADOPTED_PATTERN = /^[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/;

function fail(message) {
  throw new TypeError(`change docket: ${message}`);
}
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dayNumber(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export function loadProcurementLegalDocket(
  path = new URL("./procurement_legal_change_docket.v1.json", import.meta.url),
) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateEvidence(where, clockName, evidence) {
  if (!Array.isArray(evidence)) fail(`${where} clock ${clockName} evidence must be an array`);
  for (const item of evidence) {
    if (!item || typeof item !== "object") fail(`${where} clock ${clockName} evidence item must be an object`);
    if (!nonEmpty(item.url) || !/^https:\/\//.test(item.url)) fail(`${where} clock ${clockName} evidence requires an https url`);
    if (!validDate(item.retrieved_on)) fail(`${where} clock ${clockName} evidence requires retrieved_on date`);
    if (item.quote !== undefined && !nonEmpty(item.quote)) fail(`${where} clock ${clockName} evidence quote must be non-empty when present`);
  }
}

function validateClock(where, name, clock) {
  if (!clock || typeof clock !== "object") fail(`${where} is missing clock ${name}`);
  if (!DOCKET_CLOCK_TRIGGERS.includes(clock.trigger)) fail(`${where} clock ${name} has unknown trigger ${clock.trigger}`);
  if (!DOCKET_CLOCK_STATES.includes(clock.state)) fail(`${where} clock ${name} has unknown state ${clock.state}`);
  const evidence = clock.evidence ?? [];
  validateEvidence(where, name, evidence);
  if (clock.trigger === "date") {
    if (!validDate(clock.date)) fail(`${where} clock ${name} is date-triggered and requires a valid date`);
    if (clock.event != null) fail(`${where} clock ${name} is date-triggered and must not carry an event`);
  } else {
    if (!nonEmpty(clock.event)) fail(`${where} clock ${name} is event-triggered and requires an event description`);
    if (clock.date != null) {
      if (!validDate(clock.date)) fail(`${where} clock ${name} has an invalid date`);
      if (evidence.length === 0) fail(`${where} clock ${name} is event-triggered with a date but no evidence establishing it`);
    }
  }
  if (clock.state === "reached" && evidence.length === 0) fail(`${where} clock ${name} is reached without evidence`);
}

/**
 * Validate a docket. With `register`, also checks that every `affects` id and every `adopted_as`
 * resolves in it, and that every register known_divergence has a register_review_item.
 */
export function validateChangeDocket(docket, { register } = {}) {
  if (!docket || typeof docket !== "object") fail("must be an object");
  if (docket.schema !== PROCUREMENT_LEGAL_DOCKET_SCHEMA) fail(`expected schema ${PROCUREMENT_LEGAL_DOCKET_SCHEMA}`);
  if (!nonEmpty(docket.version)) fail("requires version");
  if (!Array.isArray(docket.entries) || docket.entries.length === 0) fail("entries must be a non-empty array");
  if (!Array.isArray(docket.register_review_items)) fail("register_review_items must be an array");

  const registerIds = register ? new Set(register.entries.map((entry) => entry.id)) : null;
  const registerRefs = register ? new Set(register.entries.map((entry) => `${entry.id}@${entry.record_version}`)) : null;
  const seen = new Set();

  for (const entry of docket.entries) {
    const where = `entry ${entry?.id}`;
    if (!ID_PATTERN.test(entry?.id || "")) fail(`${where} id must be dotted lower-case`);
    if (seen.has(entry.id)) fail(`duplicate entry id ${entry.id}`);
    seen.add(entry.id);
    if (!nonEmpty(entry.title)) fail(`${where} requires a title`);
    if (!DOCKET_STATUSES.includes(entry.status)) fail(`${where} has unknown status ${entry.status}`);
    if (!DOCKET_JURISDICTIONS.includes(entry.jurisdiction)) fail(`${where} has unknown jurisdiction ${entry.jurisdiction}`);
    if (!DOCKET_INSTRUMENTS.includes(entry.instrument)) fail(`${where} has unknown instrument ${entry.instrument}`);
    if (!nonEmpty(entry.citation)) fail(`${where} requires a citation`);
    if (!nonEmpty(entry.summary)) fail(`${where} requires a summary`);
    if (!validDate(entry.recorded_at)) fail(`${where} requires recorded_at date`);

    if (!Array.isArray(entry.affects)) fail(`${where} affects must be an array`);
    if (entry.affects.length === 0 && !nonEmpty(entry.affects_note)) fail(`${where} has empty affects and requires affects_note`);
    for (const id of entry.affects) {
      if (registerIds && !registerIds.has(id)) fail(`${where} affects ${id} which is not in the register`);
    }

    const clocks = entry.clocks;
    if (!clocks || typeof clocks !== "object" || Array.isArray(clocks)) fail(`${where} requires clocks`);
    for (const name of DOCKET_CLOCK_NAMES) {
      if (!(name in clocks)) fail(`${where} is missing clock ${name}`);
    }
    for (const name of Object.keys(clocks)) {
      if (!DOCKET_CLOCK_NAMES.includes(name)) fail(`${where} has unknown clock ${name}`);
    }
    for (const name of DOCKET_CLOCK_NAMES) validateClock(where, name, clocks[name]);

    if (!Array.isArray(entry.sources) || entry.sources.length === 0) fail(`${where} requires sources`);
    for (const source of entry.sources) {
      if (!nonEmpty(source?.url) || !/^https:\/\//.test(source.url)) fail(`${where} source requires an https url`);
      if (!validDate(source.retrieved_on)) fail(`${where} source requires retrieved_on date`);
    }

    const review = entry.review;
    if (!review || typeof review !== "object") fail(`${where} requires review`);
    if (!DOCKET_REVIEW_STATUSES.includes(review.status)) fail(`${where} has unknown review status ${review.status}`);
    if (review.status === "unreviewed" && !nonEmpty(review.reason)) fail(`${where} unreviewed requires a review.reason`);
    if (review.status !== "unreviewed") {
      if (!nonEmpty(review.by)) fail(`${where} ${review.status} requires a named reviewer`);
      if (!validDate(review.on)) fail(`${where} ${review.status} requires a review date`);
    }

    if (entry.status === "adopted_into_register") {
      if (!nonEmpty(entry.adopted_as)) fail(`${where} adopted_into_register requires adopted_as`);
    } else if (entry.adopted_as != null) {
      fail(`${where} has adopted_as but status is ${entry.status}`);
    }
    if (entry.adopted_as != null) {
      if (!ADOPTED_PATTERN.test(entry.adopted_as)) fail(`${where} adopted_as must be id@version`);
      if (registerRefs && !registerRefs.has(entry.adopted_as)) fail(`${where} adopted_as ${entry.adopted_as} is not in the register`);
    }
    if (entry.status === "withdrawn" && !nonEmpty(entry.closed_note)) fail(`${where} withdrawn requires closed_note`);
  }

  const itemIds = new Set();
  for (const item of docket.register_review_items) {
    if (!nonEmpty(item?.id) || !nonEmpty(item.summary) || !nonEmpty(item.owner_slice)) {
      fail("register_review_item requires id, summary and owner_slice");
    }
    if (itemIds.has(item.id)) fail(`duplicate register_review_item ${item.id}`);
    itemIds.add(item.id);
    if (!nonEmpty(item.register_divergence_id)) fail(`register_review_item ${item.id} requires register_divergence_id`);
  }
  if (register) {
    const divergenceIds = new Set(register.known_divergences.map((item) => item.id));
    for (const item of docket.register_review_items) {
      if (!divergenceIds.has(item.register_divergence_id)) {
        fail(`register_review_item ${item.id} names unknown divergence ${item.register_divergence_id}`);
      }
    }
    for (const id of divergenceIds) {
      if (!docket.register_review_items.some((item) => item.register_divergence_id === id)) {
        fail(`known divergence ${id} has no register_review_item`);
      }
    }
  }
  return true;
}

function openEntries(docket) {
  return docket.entries.filter((entry) => !DOCKET_CLOSED_STATUSES.includes(entry.status));
}

/**
 * Entries with a dated, pending clock that falls on or before today + withinDays. Overdue clocks
 * (date before today, still pending) are included and flagged until marked reached with evidence.
 */
export function docketDue(docket, { today, withinDays = 60 } = {}) {
  if (!validDate(today)) fail("docketDue requires today as YYYY-MM-DD");
  if (!Number.isInteger(withinDays) || withinDays < 0) fail("docketDue requires withinDays as a non-negative integer");
  const horizon = dayNumber(today) + withinDays;
  const rows = [];
  for (const entry of openEntries(docket)) {
    const due = [];
    for (const name of DOCKET_CLOCK_NAMES) {
      const clock = entry.clocks[name];
      if (clock.state !== "pending" || !clock.date) continue;
      const days = dayNumber(clock.date) - dayNumber(today);
      if (dayNumber(clock.date) <= horizon) {
        due.push({ clock: name, date: clock.date, days_until: days, overdue: days < 0 });
      }
    }
    if (due.length) {
      due.sort((a, b) => a.date.localeCompare(b.date) || a.clock.localeCompare(b.clock));
      rows.push({ id: entry.id, title: entry.title, status: entry.status, affects: [...entry.affects], due });
    }
  }
  return rows.sort((a, b) => a.due[0].date.localeCompare(b.due[0].date) || a.id.localeCompare(b.id));
}

/** Pending event-triggered clocks that have no date yet: the docket is waiting for something to happen. */
export function docketAwaitingEvents(docket) {
  const rows = [];
  for (const entry of openEntries(docket)) {
    for (const name of DOCKET_CLOCK_NAMES) {
      const clock = entry.clocks[name];
      if (clock.trigger === "event" && clock.state === "pending" && !clock.date) {
        rows.push({ id: entry.id, title: entry.title, status: entry.status, clock: name, event: clock.event, date: null });
      }
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id) || a.clock.localeCompare(b.clock));
}

/** Every docket entry (open or closed) that names a register entry, by `affects` or `adopted_as`. */
export function docketForRegisterEntry(docket, entryId) {
  return docket.entries.filter((entry) => entry.affects.includes(entryId)
    || (typeof entry.adopted_as === "string" && entry.adopted_as.startsWith(`${entryId}@`)));
}

/** Whitespace-normalised quote check, shared with the source watch. */
export function quoteOccurs(text, quote) {
  return normalizeLegalText(text).includes(normalizeLegalText(quote));
}
