/**
 * Property domain explorer — list ontology over disposition process stages.
 *
 * Groups multi-notice disposition spines into one list entry, filters by
 * process stage (hearing → auction_or_rfp → award_or_conveyance), and stamps
 * next-action keys for feed cards. Pure: no DOM, no fetch.
 *
 * Temporal list filters (proposed/soon/upcoming/past) stay in site/index.html
 * (propStage / PROP_STAGES) — they are date-window chips, not process stages.
 */

import {
  PROPERTY_DISPOSITION_PHASES,
  PROPERTY_PHASE_META,
  dispositionStageToPhase,
} from "./property_phase_spine.mjs";
import {
  civicTodayIso,
  commercialCloseDate,
  commercialMatchesFilters,
  commercialPriceAmount,
  isCloseDatePast,
  normalizePropertySort,
} from "./property_commercial.mjs";
import { propertyEventState } from "./property_timed_events.mjs";
import { resolvePropertyActionLifecycle } from "./property_reader_actions.mjs";
import { classifyPropertyActionCharacter, stampPropertyActionCharacters } from "./property_action_character.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
export { stampPropertyActionCharacters, propertyActionCharacterLead } from "./property_action_character.mjs";

export const PROPERTY_EXPLORER_SCHEMA_VERSION = 1;

// Passive record-reading remains valuable in archive/search, but it is not a reason
// for a record to lead the default feed. These are the source-grounded actions a
// reader can still take in the world.
export const PROPERTY_DEFAULT_ACTION_KINDS = Object.freeze(new Set([
  "bid",
  "inspect",
  "attend",
  "comment",
  "object",
  "inquire_claim",
  "request_accommodation",
]));

/** Process-stage filter chips for the Property domain rail (ops ontology). */
export const PROP_PROCESS_STAGES = Object.freeze([
  ["all", "stage_all"],
  ["hearing", "disposition_stage_hearing"],
  ["auction_or_rfp", "disposition_stage_auction_or_rfp"],
  ["award_or_conveyance", "disposition_stage_award_or_conveyance"],
  ["unstaged", "disposition_stage_unstaged"],
]);

const PROCESS_ORDER = new Map(
  PROPERTY_DISPOSITION_PHASES.map((id, i) => [id, i]),
);

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

/**
 * Resolve the canonical agency pivot carried by a disposition row.
 * Materialized edge fields win; the City Record name is the bounded fallback.
 * @param {object} row
 * @returns {{ canonical_id: string, canonical_name: string }|null}
 */
export function propertyAgencyIdentity(row) {
  const direct = row?.agency_identity || row?.agency || null;
  const canonicalId = clean(row?.agency_ref || row?.agency_id || direct?.canonical_id);
  const canonicalName = clean(row?.agency_canonical_name || direct?.canonical_name);
  if (canonicalId) return { canonical_id: canonicalId, canonical_name: canonicalName || clean(row?.agency_name) || canonicalId };
  const raw = clean(row?.agency_name);
  return raw ? resolveAgencyIdentity(raw) : null;
}

/**
 * Derive the current property's agency facet from its disposition entries.
 * Counts are entry counts, matching the grouped explorer scope rather than raw notices.
 * @param {object[]} entries
 * @returns {Array<{id: string, name: string, count: number}>}
 */
export function propertyAgencyOptions(entries = []) {
  const options = new Map();
  for (const entry of entries) {
    const identities = new Map();
    for (const row of entry?.members || [entry?.primary]) {
      const identity = propertyAgencyIdentity(row);
      if (identity?.canonical_id) identities.set(identity.canonical_id, identity);
    }
    for (const identity of identities.values()) {
      const option = options.get(identity.canonical_id) || { id: identity.canonical_id, name: identity.canonical_name, count: 0 };
      option.count += 1;
      options.set(identity.canonical_id, option);
    }
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Process stage for a notice row (from materialization; null → unstaged).
 * @param {object} row
 * @returns {string|null}
 */
export function propertyProcessStage(row) {
  return dispositionStageToPhase(row?.disposition_stage) || null;
}

/**
 * Filter key for process rail counts (includes "unstaged").
 * @param {object} row
 */
export function propertyProcessFilterKey(row) {
  return propertyProcessStage(row) || "unstaged";
}

/**
 * Action i18n key for a process stage (next-action affordance on list cards).
 * @param {string|null} stage
 */
export function propertyProcessActionKey(stage) {
  const id = dispositionStageToPhase(stage);
  if (!id) return "property_action_open_notice";
  return PROPERTY_PHASE_META[id]?.action_key || "property_action_open_notice";
}

/**
 * Primary BBL from a property_location bag when present.
 * @param {object|null} location
 */
export function primaryBblFromLocation(location) {
  if (!location || typeof location !== "object") return null;
  const bbls = Array.isArray(location.bbls) ? location.bbls : [];
  for (const b of bbls) {
    const s = String(b || "").replace(/\D/g, "");
    if (/^\d{10}$/.test(s)) return s;
  }
  const lots = Array.isArray(location.tax_lots) ? location.tax_lots : [];
  for (const lot of lots) {
    if (lot && lot.bbl && /^\d{10}$/.test(String(lot.bbl))) return String(lot.bbl);
  }
  const addrs = Array.isArray(location.addresses) ? location.addresses : [];
  for (const a of addrs) {
    if (a && a.bbl && /^\d{10}$/.test(String(a.bbl))) return String(a.bbl);
  }
  return null;
}

/**
 * Index disposition spines by subject_ref and by member request_id.
 * @param {object[]} spines
 */
export function indexDispositionSpines(spines) {
  const bySubject = new Map();
  const byRequestId = new Map();
  for (const spine of spines || []) {
    if (!spine || typeof spine !== "object") continue;
    const subject = clean(spine.subject_ref);
    if (subject) bySubject.set(subject, spine);
    const stages = Array.isArray(spine.stages) ? spine.stages : [];
    for (const stage of stages) {
      for (const id of stage?.request_ids || []) {
        if (id) byRequestId.set(String(id), spine);
      }
    }
    for (const event of spine.events || []) {
      if (event?.request_id) byRequestId.set(String(event.request_id), spine);
    }
  }
  return { bySubject, byRequestId };
}

/**
 * Latest process stage present on a multi-notice spine (last matched in order).
 * @param {object} spine
 */
export function spineCurrentProcessStage(spine) {
  if (!spine || !Array.isArray(spine.stages)) return null;
  let best = null;
  let bestOrder = -1;
  for (const stage of spine.stages) {
    if (!stage?.matched) continue;
    const id = dispositionStageToPhase(stage.kind);
    if (!id) continue;
    const order = PROCESS_ORDER.has(id) ? PROCESS_ORDER.get(id) : -1;
    if (order >= bestOrder) {
      bestOrder = order;
      best = id;
    }
  }
  return best;
}

function sortNoticesNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    const da = isoDate(a?.start_date) || isoDate(a?.event_date) || "";
    const db = isoDate(b?.start_date) || isoDate(b?.event_date) || "";
    return String(db).localeCompare(String(da));
  });
}

/**
 * Build list entries for the Property explorer.
 * Multi-notice disposition subjects collapse to one entry (primary = newest notice);
 * singleton / unjoined notices remain individual cards.
 *
 * @param {object[]} properties — /property-locations properties rows
 * @param {object[]} spines — disposition_spines from the same payload
 * @returns {object[]}
 */
export function buildPropertyExplorerEntries(properties, spines) {
  const rows = Array.isArray(properties) ? properties.filter(Boolean) : [];
  const { bySubject, byRequestId } = indexDispositionSpines(spines);

  // subject_ref → notices in current window
  const membersBySubject = new Map();
  for (const row of rows) {
    const subject =
      clean(row.disposition_subject_ref)
      || (byRequestId.get(String(row.request_id || ""))?.subject_ref || null);
    if (!subject) continue;
    if (!membersBySubject.has(subject)) membersBySubject.set(subject, []);
    membersBySubject.get(subject).push(row);
  }

  // Multi-notice only when spine join says so, or ≥2 notices share the subject in-window.
  const multiSubjects = new Set();
  for (const [subject, members] of membersBySubject) {
    const spine = bySubject.get(subject);
    const joinCount = spine?.join?.notice_count || 0;
    if (joinCount > 1 || members.length > 1) multiSubjects.add(subject);
  }

  const emittedSubjects = new Set();
  const entries = [];

  for (const row of rows) {
    const subject =
      clean(row.disposition_subject_ref)
      || (byRequestId.get(String(row.request_id || ""))?.subject_ref || null);
    const spine = subject ? bySubject.get(subject) : byRequestId.get(String(row.request_id || ""));

    if (subject && multiSubjects.has(subject)) {
      if (emittedSubjects.has(subject)) continue;
      emittedSubjects.add(subject);
      const members = sortNoticesNewestFirst(membersBySubject.get(subject) || [row]);
      const primary = members[0] || row;
      const processStage =
        spineCurrentProcessStage(spine) || propertyProcessStage(primary) || null;
      const bbl =
        primaryBblFromLocation(primary.property_location || primary._location)
        || (Array.isArray(spine?.join?.keys)
          ? (spine.join.keys.find((k) => String(k).startsWith("bbl:")) || "").replace(/^bbl:/, "") || null
          : null);
      entries.push({
        kind: "disposition",
        schema_version: PROPERTY_EXPLORER_SCHEMA_VERSION,
        subject_ref: subject,
        primary,
        members,
        notice_count: members.length,
        spine: spine || null,
        process_stage: processStage,
        process_filter: processStage || "unstaged",
        action_key: propertyProcessActionKey(processStage),
        bbl: bbl && /^\d{10}$/.test(String(bbl)) ? String(bbl) : null,
        join_method: spine?.join?.method || null,
        matched_phases: (spine?.stages || [])
          .filter((s) => s?.matched)
          .map((s) => s.kind)
          .filter(Boolean),
      });
      continue;
    }

    // Singleton notice card
    const processStage = propertyProcessStage(row);
    const bbl = primaryBblFromLocation(row.property_location || row._location);
    entries.push({
      kind: "notice",
      schema_version: PROPERTY_EXPLORER_SCHEMA_VERSION,
      subject_ref: subject || (row.request_id ? `notice:${row.request_id}` : null),
      primary: row,
      members: [row],
      notice_count: 1,
      spine: spine || null,
      process_stage: processStage,
      process_filter: processStage || "unstaged",
      action_key: propertyProcessActionKey(processStage),
      bbl: bbl && /^\d{10}$/.test(String(bbl)) ? String(bbl) : null,
      join_method: spine?.join?.method || "single_notice",
      matched_phases: processStage ? [processStage] : [],
    });
  }

  return entries;
}

/**
 * Filter explorer entries by process stage, asset type, commercial fields, and temporal key.
 * Temporal classifier is injected so this module stays free of DOM date helpers.
 * Commercial filter matching is pure (commercialMatchesFilters) — sale-method and
 * price filters drop non-sales, while item type remains a domain facet that can
 * intentionally select non-sale classes such as seized / unclaimed property.
 *
 * @param {object[]} entries
 * @param {object} opts
 * @param {string} [opts.process="all"]
 * @param {string} [opts.asset="all"]
 * @param {string} [opts.saleMethod="all"]
 * @param {string} [opts.priceBand="all"]
 * @param {string} [opts.temporal="all"]
 * @param {(row: object) => string|null} [opts.temporalOf]
 * @param {(row: object) => string|null} [opts.assetOf]
 * @param {(row: object) => object|null} [opts.commercialOf]
 * @param {string|null} [opts.borough]
 * @param {string|null} [opts.neighborhood]
 * @param {string[]} [opts.communityDistricts]
 * @param {string|null} [opts.agency]
 */
export function filterPropertyExplorerEntries(entries, opts = {}) {
  const process = opts.process || "all";
  const asset = opts.asset || "all";
  const saleMethod = opts.saleMethod || "all";
  const priceBand = opts.priceBand || "all";
  const temporal = opts.temporal || "all";
  const temporalOf = typeof opts.temporalOf === "function" ? opts.temporalOf : null;
  const assetOf = typeof opts.assetOf === "function" ? opts.assetOf : null;
  const commercialOf = typeof opts.commercialOf === "function"
    ? opts.commercialOf
    : (row) => row?.commercial || null;
  const borough = clean(opts.borough);
  const neighborhood = clean(opts.neighborhood)?.toLowerCase() || null;
  const agency = clean(opts.agency);
  const communityDistricts = new Set(
    (Array.isArray(opts.communityDistricts) ? opts.communityDistricts : [])
      .map((value) => String(value || "").toUpperCase())
      .filter((value) => /^(?:M|X|K|Q|R)\d{2}$/.test(value)),
  );
  const commercialActive = saleMethod !== "all" || priceBand !== "all";

  return (entries || []).filter((entry) => {
    if (!entry || !entry.primary) return false;
    if (agency) {
      const hit = (entry.members || [entry.primary]).some((member) =>
        propertyAgencyIdentity(member)?.canonical_id === agency);
      if (!hit) return false;
    }
    if (process !== "all") {
      // Match current process stage OR any member notice still tagged with that stage
      // so multi-notice chains remain findable under earlier phases.
      if (process === "unstaged") {
        if (entry.process_filter !== "unstaged") return false;
      } else {
        const memberHit = (entry.members || [entry.primary]).some(
          (m) => propertyProcessStage(m) === process,
        );
        if (!memberHit && entry.process_filter !== process) return false;
      }
    }

    if (asset !== "all" && assetOf) {
      // Keep disposition group if any member matches asset bucket.
      const hit = (entry.members || [entry.primary]).some((m) => assetOf(m) === asset);
      if (!hit) return false;
    }

    // Commercial organize filters (method / price / sale gate when any commercial filter on).
    if (commercialActive) {
      const hit = (entry.members || [entry.primary]).some((m) => {
        const commercial = commercialOf(m);
        // Asset already gated above via assetOf; re-check sale_method/price/sale_eligible.
        return commercialMatchesFilters(commercial, {
          asset: "all", // already applied
          saleMethod,
          priceBand,
          commercialOnly: true,
        });
      });
      if (!hit) return false;
    }

    if (temporal !== "all" && temporalOf) {
      const hit = (entry.members || [entry.primary]).some((m) => temporalOf(m) === temporal);
      if (!hit) return false;
    }

    if (borough) {
      const locs = (entry.members || [entry.primary]).map(
        (m) => m._location || m.property_location || null,
      );
      const hit = locs.some((loc) => (loc?.boroughs || []).includes(borough));
      if (!hit) return false;
    }

    if (communityDistricts.size) {
      const hit = (entry.members || [entry.primary]).some((member) =>
        communityDistricts.has(String(member?._communityDistrict || "").toUpperCase()));
      if (!hit) return false;
    }

    if (neighborhood) {
      const hit = (entry.members || [entry.primary]).some((m) => {
        const loc = m._location || m.property_location || {};
        const bag = [
          ...(loc.neighborhoods || []),
          ...(loc.addresses || []).map((a) => a?.label),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return bag.includes(neighborhood);
      });
      if (!hit) return false;
    }

    return true;
  });
}

/**
 * Close ISO day for an explorer entry (or null).
 * @param {object} entry
 * @param {(row: object) => object|null} getCommercial
 */
export function entryCloseDate(entry, getCommercial) {
  const row = entry?.primary;
  return commercialCloseDate(row, typeof getCommercial === "function" ? getCommercial(row) : row?.commercial);
}

/**
 * Stamp open/closed temporal status + honesty action key on explorer entries.
 * Closed = published close/event day strictly before today. No live bid/attend
 * action on a decade-closed sale.
 *
 * @param {object[]} entries
 * @param {{
 *   today?: string|Date,
 *   commercialOf?: (row: object) => object|null,
 * }} [opts]
 * @returns {object[]}
 */
export function stampPropertyExplorerTemporal(entries, opts = {}) {
  const today = opts.today instanceof Date || typeof opts.today === "number"
    ? civicTodayIso(opts.today)
    : (opts.today ? String(opts.today).slice(0, 10) : civicTodayIso());
  const getCommercial = typeof opts.commercialOf === "function"
    ? opts.commercialOf
    : (row) => row?.commercial || null;
  const characterStamp = stampPropertyActionCharacters(entries);
  return characterStamp.entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const rows = rowsForPropertyEntry(entry);
    const lifecycles = rows.map((row) => resolvePropertyActionLifecycle(row, {
      today,
      commercial: getCommercial(row),
    }));
    const superseded = lifecycles.length > 0
      && lifecycles.every((lifecycle) => lifecycle.program_state === "superseded");
    const hasUndatedDefaultAction = (entry?.default_qualification?.exposed_actions || [])
      .some((action) => action?.status === "undated");
    const closed = !superseded
      && !hasUndatedDefaultAction
      && lifecycles.length > 0
      && lifecycles.every((lifecycle) => lifecycle.state === "closed");
    const open = lifecycles.some((lifecycle) => lifecycle.state === "open");
    const close = lifecycles.map((lifecycle) => lifecycle.action_by).filter(Boolean).sort().at(-1)
      || entryCloseDate(entry, getCommercial);
    const openAction = entry.action_key && entry.action_key !== "property_action_closed"
      ? entry.action_key
      : propertyProcessActionKey(entry.process_stage);
    return {
      ...entry,
      close_date: close,
      temporal_status: superseded ? "superseded" : (closed ? "closed" : (open ? "open" : "undated")),
      // Honesty: closed sales never keep a live bid/attend CTA.
      action_key: closed ? "property_action_closed" : openAction,
      program_state: lifecycles.length && lifecycles.every((lifecycle) => lifecycle.program_state === "active")
        ? "active"
        : (superseded ? "superseded" : null),
      program_valid_through: lifecycles.map((lifecycle) => lifecycle.program_valid_through).filter(Boolean).sort().at(-1) || null,
      instance_state: lifecycles.length && lifecycles.every((lifecycle) => lifecycle.instance_state === "closed")
        ? "closed"
        : (lifecycles.some((lifecycle) => lifecycle.instance_state === "current") ? "current" : "undated"),
      action_character: entry.action_character || null,
      action_character_receipt: entry.action_character_receipt || null,
    };
  });
}

function rowsForPropertyEntry(entry) {
  if (!entry || typeof entry !== "object") return [];
  if (entry.kind === "cluster") {
    return (entry.members || []).flatMap(rowsForPropertyEntry);
  }
  if (Array.isArray(entry.members) && entry.members.length) return entry.members.filter(Boolean);
  return entry.primary ? [entry.primary] : [];
}

/** Raw notice cardinality represented by explorer entries (before or after clustering). */
export function propertyExplorerCensusCount(entries) {
  return (Array.isArray(entries) ? entries : [])
    .reduce((total, entry) => total + rowsForPropertyEntry(entry).length, 0);
}

function rowTimedEvents(row, opts) {
  if (typeof opts.eventOf === "function") return opts.eventOf(row) || [];
  return row?.property_timed_events
    || row?.property_events
    || row?.timed_events
    || row?.commercial?.timed_events
    || [];
}

function rowReaderActions(row, opts) {
  if (typeof opts.actionsOf === "function") return opts.actionsOf(row) || [];
  const supplied = row?.property_reader_actions;
  if (Array.isArray(supplied)) return supplied;
  if (Array.isArray(supplied?.actions)) return supplied.actions;
  return [];
}

function livePropertyEvent(event, today) {
  const state = propertyEventState(event, today);
  return state === "open" || state === "upcoming";
}

function exposedPropertyAction(action) {
  if (!action || !PROPERTY_DEFAULT_ACTION_KINDS.has(action.kind)) return false;
  return action.status !== "historical";
}

/**
 * Default-feed qualification: at least one member has a live typed event or a
 * source-grounded participatory action. Result/document review stays available in
 * archive/search but cannot make a closed record lead the feed.
 */
export function propertyEntryDefaultQualification(entry, opts = {}) {
  const today = opts.today instanceof Date || typeof opts.today === "number"
    ? civicTodayIso(opts.today)
    : (opts.today ? String(opts.today).slice(0, 10) : civicTodayIso());
  const rows = rowsForPropertyEntry(entry);
  const lifecycles = rows.map((row) => resolvePropertyActionLifecycle(row, {
    ...opts,
    today,
    commercial: typeof opts.commercialOf === "function" ? opts.commercialOf(row) : row?.commercial,
  }));
  const liveEvents = [];
  const exposedActions = [];
  for (const [index, row] of rows.entries()) {
    // The recurring City Record announcement is provenance for the live fleet
    // stream, not evidence that this old notice is itself an open bid.
    if (row?.commercial?.source_role === "provenance_pointer") continue;
    const actions = rowReaderActions(row, opts);
    if (lifecycles[index]?.program_state === "superseded") continue;
    if (lifecycles[index]?.state === "closed") {
      for (const action of actions) {
        if (action?.kind === "inquire_claim" && exposedPropertyAction(action)) {
          exposedActions.push({ request_id: row?.request_id || null, kind: action.kind, status: action.status });
        }
      }
      continue;
    }
    for (const event of rowTimedEvents(row, opts)) {
      if (livePropertyEvent(event, today)) {
        liveEvents.push({ request_id: row?.request_id || null, kind: event?.kind || null });
      }
    }
    for (const action of actions) {
      if (exposedPropertyAction(action)) {
        exposedActions.push({ request_id: row?.request_id || null, kind: action.kind, status: action.status });
      }
    }
  }
  return {
    qualified: liveEvents.length > 0 || exposedActions.length > 0,
    lifecycle_state: lifecycles.length && lifecycles.every((lifecycle) => lifecycle.program_state === "superseded")
      ? "superseded"
      : lifecycles.length && lifecycles.every((lifecycle) => lifecycle.state === "closed")
      ? "closed"
      : lifecycles.some((lifecycle) => lifecycle.state === "open") ? "open" : "undated",
    lifecycles,
    live_events: liveEvents,
    exposed_actions: exposedActions,
  };
}

/** Throw when a proposed archive contains anything that still qualifies for default. */
export function assertPropertyArchiveSafety(archiveEntries, opts = {}) {
  const violations = [];
  for (const entry of archiveEntries || []) {
    const qualification = propertyEntryDefaultQualification(entry, opts);
    if (!qualification.qualified) continue;
    const ids = rowsForPropertyEntry(entry).map((row) => row?.request_id).filter(Boolean);
    violations.push({ ids, qualification });
  }
  if (violations.length) {
    const ids = [...new Set(violations.flatMap((violation) => violation.ids))];
    throw new Error(`Property archive contains live event/action records: ${ids.join(", ")}`);
  }
  return true;
}

/**
 * Partition a scoped census without dropping rows. Counts use raw notice cardinality,
 * so grouping and small-multiple presentation cannot hide conservation failures.
 */
export function partitionPropertyExplorerEntries(entries, opts = {}) {
  const defaultEntries = [];
  const archiveEntries = [];
  for (const entry of entries || []) {
    const qualification = propertyEntryDefaultQualification(entry, opts);
    const stamped = { ...entry, default_qualification: qualification };
    (qualification.qualified ? defaultEntries : archiveEntries).push(stamped);
  }
  assertPropertyArchiveSafety(archiveEntries, opts);
  const censusTotal = propertyExplorerCensusCount(entries);
  const defaultCount = propertyExplorerCensusCount(defaultEntries);
  const archiveCount = propertyExplorerCensusCount(archiveEntries);
  if (defaultCount + archiveCount !== censusTotal) {
    throw new Error(`Property scope count mismatch: ${defaultCount} + ${archiveCount} != ${censusTotal}`);
  }
  return {
    default_entries: defaultEntries,
    archive_entries: archiveEntries,
    default_count: defaultCount,
    archive_count: archiveCount,
    census_total: censusTotal,
  };
}

const PROPERTY_ARCHIVE_GROUPS = Object.freeze([
  ["sales_results", "property_archive_sales_results"],
  ["hearings_decisions", "property_archive_hearings_decisions"],
  ["programs_ran", "property_archive_programs_ran"],
]);

function archiveRows(entry) { return rowsForPropertyEntry(entry); }

function archiveGroupForEntry(entry) {
  const rows = archiveRows(entry);
  const characters = rows.map((row) => row?.action_character || classifyPropertyActionCharacter(row).action_character || entry?.action_character).filter(Boolean);
  if (characters.includes("participation")) return "hearings_decisions";
  if (characters.includes("marketplace") || characters.includes("historical_result")) return "sales_results";
  return "programs_ran";
}

function archiveDate(entry) {
  const dates = archiveRows(entry).flatMap((row) => [
    row?.event_date, row?.start_date, row?.end_date,
    row?.commercial?.close_date, row?.property_reader_actions?.lifecycle?.closed_at,
  ]).map(isoDate).filter(Boolean).sort();
  return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
}

/** Historical presentation projection; entries and canonical URLs stay intact. */
export function groupPropertyArchiveEntries(entries = []) {
  const byKey = new Map(PROPERTY_ARCHIVE_GROUPS.map(([key, label]) => [key, {
    key, label, entries: [], count: 0, date_range: null,
  }]));
  for (const entry of entries || []) {
    const group = byKey.get(archiveGroupForEntry(entry));
    if (!group) continue;
    group.entries.push(entry);
    group.count += propertyExplorerCensusCount([entry]);
    const range = archiveDate(entry);
    if (range) group.date_range = {
      start: !group.date_range || range.start < group.date_range.start ? range.start : group.date_range.start,
      end: !group.date_range || range.end > group.date_range.end ? range.end : group.date_range.end,
    };
  }
  return PROPERTY_ARCHIVE_GROUPS.map(([key]) => byKey.get(key))
    .filter((group) => group.entries.length > 0);
}

/** Render only the archive's group chrome; card rendering stays with the app. */
export function propertyArchiveGroupsHTML(groups, cardFor, helpers) {
  const t = helpers.translate, esc = helpers.escape, date = helpers.formatDate;
  const coverage = (group) => {
    if (!group.date_range) return t("property_archive_coverage_unknown");
    const start = date(group.date_range.start, { dateOnly: true });
    const end = date(group.date_range.end, { dateOnly: true });
    return t("property_archive_coverage", { range: start === end ? start : `${start} – ${end}` });
  };
  return groups.map((group) => `<section class="property-archive-group" data-archive-group="${esc(group.key)}">
    <header class="property-archive-group-head"><h2>${esc(t(group.label))}</h2>
      <p>${esc(t(`${group.label}_dek`))}</p><span class="property-archive-coverage">${esc(coverage(group))} · ${esc(t("property_archive_record_count", { n: group.count }))}</span>
    </header><div class="property-archive-group-list">${group.entries.map(cardFor).join("")}</div>
  </section>`).join("");
}

/**
 * Sort explorer entries for commercial scan (closing soon / price / newest).
 * Default `closing_soon`: upcoming/open closes first (soonest first), undated
 * next, past-dated closed sales last (most recently closed first) — never the
 * front page of the default Property list.
 *
 * @param {object[]} entries
 * @param {string} [sort="closing_soon"]
 * @param {(row: object) => object|null} [commercialOf]
 * @param {{ today?: string|Date }} [opts]
 */
export function sortPropertyExplorerEntries(entries, sort = "closing_soon", commercialOf, opts = {}) {
  const key = normalizePropertySort(sort);
  const getCommercial = typeof commercialOf === "function"
    ? commercialOf
    : (row) => row?.commercial || null;
  const today = opts.today instanceof Date || typeof opts.today === "number"
    ? civicTodayIso(opts.today)
    : (opts.today ? String(opts.today).slice(0, 10) : civicTodayIso());
  const list = Array.isArray(entries) ? [...entries] : [];

  const closeDay = (entry) => {
    const row = entry?.primary;
    return commercialCloseDate(row, getCommercial(row));
  };
  const closeKey = (entry) => closeDay(entry) || "9999-12-31";
  const closedRank = (entry) => {
    // Prefer stamped temporal_status; fall back to date compare.
    if (entry?.temporal_status === "closed") return 2;
    if (entry?.temporal_status === "undated") return 1;
    if (entry?.temporal_status === "open") return 0;
    const day = closeDay(entry);
    if (!day) return 1;
    return isCloseDatePast(day, today) ? 2 : 0;
  };
  const priceKey = (entry) => {
    const amount = commercialPriceAmount(getCommercial(entry?.primary));
    return amount == null ? null : amount;
  };
  const postedKey = (entry) => {
    const s = String(entry?.primary?.start_date || "");
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "0000-01-01";
  };

  list.sort((a, b) => {
    if (key === "newest") {
      // Even on newest, keep closed sales after open ones when mixed (default all).
      const cr = closedRank(a) - closedRank(b);
      if (cr !== 0) return cr;
      return postedKey(b).localeCompare(postedKey(a));
    }
    if (key === "price_desc" || key === "price_asc") {
      const cr = closedRank(a) - closedRank(b);
      if (cr !== 0) return cr;
      const pa = priceKey(a);
      const pb = priceKey(b);
      // Unpriced sink to the end for both directions.
      if (pa == null && pb == null) return closeKey(a).localeCompare(closeKey(b));
      if (pa == null) return 1;
      if (pb == null) return -1;
      return key === "price_desc" ? pb - pa : pa - pb;
    }
    // closing_soon (default): open soonest → undated → closed (most recent first).
    const cr = closedRank(a) - closedRank(b);
    if (cr !== 0) return cr;
    if (closedRank(a) === 2) {
      // Closed bucket: reverse chrono (2014 before 2013 in the archive, not front page).
      return closeKey(b).localeCompare(closeKey(a));
    }
    return closeKey(a).localeCompare(closeKey(b));
  });
  return list;
}

/**
 * Count process-filter keys across entries (for chip badges).
 * @param {object[]} entries
 */
export function countPropertyProcessStages(entries) {
  const counts = { all: 0 };
  for (const [key] of PROP_PROCESS_STAGES) {
    if (key !== "all") counts[key] = 0;
  }
  for (const entry of entries || []) {
    counts.all += 1;
    const k = entry.process_filter || "unstaged";
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * Normalize a notice title to a grouping stem: lowercase, drop digits and
 * punctuation, collapse whitespace. So "PROPERTY CLERK INVOICE 1234 — PENDING
 * DESTRUCTION" and "…INVOICE 5678…" share a stem — the small-multiples signal.
 * @param {string} value
 */
function titleStem(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GROUP_TITLE_GENERIC = new Set([
  "notice", "notices", "public", "the", "of", "for", "and", "property", "disposition",
]);

/** Remove dates/identifiers while retaining the words a reader can recognize. */
function groupTitleTokens(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?\b/gi, " ")
    .replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/g, " ")
    .replace(/\b\S*\d\S*\b/g, " ")
    .toLowerCase()
    .replace(/[^a-z' -]+/g, " ")
    .replace(/[-']+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Longest contiguous word pattern shared by every title, not only a byte prefix. */
function longestSharedTitlePattern(tokenLists) {
  if (!tokenLists.length || tokenLists.some((tokens) => !tokens.length)) return [];
  const [first, ...rest] = tokenLists;
  for (let length = first.length; length > 0; length -= 1) {
    for (let start = 0; start + length <= first.length; start += 1) {
      const candidate = first.slice(start, start + length);
      const shared = rest.every((tokens) => {
        for (let i = 0; i + length <= tokens.length; i += 1) {
          if (candidate.every((token, j) => token === tokens[i + j])) return true;
        }
        return false;
      });
      if (shared) return candidate;
    }
  }
  return [];
}

function commonMemberValue(members, field) {
  const values = members
    .map((member) => clean(member?.primary?.[field]))
    .filter(Boolean);
  if (!values.length || values.length !== members.length) return null;
  return values.every((value) => value.toLowerCase() === values[0].toLowerCase()) ? values[0] : null;
}

function compactAgencyName(value) {
  const agency = clean(value);
  if (!agency) return null;
  if (/^[A-Z0-9&.-]{2,10}$/.test(agency)) return agency;
  const words = agency.split(/\s+/).filter((word) => !/^(?:of|the)$/i.test(word));
  if (words.length >= 3) return words.map((word) => word[0]).join("").toUpperCase();
  return agency;
}

/**
 * Describe what collapsed members share. Title content leads; common agency and
 * notice type are honest fallbacks when titles contain only dates/identifiers.
 */
export function describeCollapsedGroup(members) {
  const list = Array.isArray(members) ? members.filter(Boolean) : [];
  if (!list.length) return "Dated notices";
  const pattern = longestSharedTitlePattern(
    list.map((member) => groupTitleTokens(member?.primary?.short_title)),
  );
  const contentWords = pattern.filter((word) => !GROUP_TITLE_GENERIC.has(word));
  const agency = compactAgencyName(commonMemberValue(list, "agency_name"));
  const noticeType = commonMemberValue(list, "type_of_notice_description");

  let subject = contentWords.length ? pattern.join(" ") : null;
  if (!subject && noticeType) subject = noticeType.toLowerCase();
  if (!subject) subject = "dated notices";

  const normalizedSubject = subject.replace(/[^a-z]/gi, "").toLowerCase();
  const normalizedAgency = String(agency || "").replace(/[^a-z]/gi, "").toLowerCase();
  const prefix = agency && normalizedAgency && !normalizedSubject.startsWith(normalizedAgency)
    ? `${agency} `
    : "";
  const description = `${prefix}${subject}`.trim();
  return prefix ? description : description[0].toUpperCase() + description.slice(1);
}

/** Default cluster signature for property entries (agency + asset + stage + title stem). */
function defaultEntrySignature(entry) {
  const row = entry && entry.primary;
  if (!row) return null;
  const stem = titleStem(row.short_title);
  if (!stem) return null;
  const agency = clean(row.agency_name) || "";
  const asset = clean(row._asset) || "";
  const stage = clean(entry.process_filter) || "unstaged";
  return `${agency}${asset}${stage}${stem}`;
}

function buildClusterEntry(signature, members) {
  const dates = members
    .map((m) => m.close_date || (m.primary && (m.primary.event_date || m.primary.start_date)) || null)
    .map((d) => (d ? String(d).slice(0, 10) : null))
    .filter(Boolean)
    .sort();
  const allClosed = members.every((m) => m.temporal_status === "closed");
  const anyOpen = members.some((m) => m.temporal_status === "open");
  const rep = members[0] || {};
  return {
    kind: "cluster",
    count: members.length,
    members,
    description: describeCollapsedGroup(members),
    primary: rep.primary || null,
    signature,
    process_stage: rep.process_stage || null,
    process_filter: rep.process_filter || "unstaged",
    date_range: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
    temporal_status: allClosed ? "closed" : (anyOpen ? "open" : (rep.temporal_status || "undated")),
    close_date: rep.close_date || null,
  };
}

/**
 * Collapse runs of near-identical single-notice entries into one "cluster" entry —
 * Tufte small multiples: one frame, the varying datum is the date. Only single-notice
 * entries are eligible (multi-notice spines are already collapsed). A cluster forms when
 * >= minCount entries share a signature; it takes the list position of its earliest
 * member, and the rest are absorbed (expandable in the UI). Lens-neutral: pass
 * `opts.signatureOf` to reuse the collapse for another lens.
 *
 * @param {object[]} entries — already stamped + sorted explorer entries
 * @param {{minCount?: number, signatureOf?: (e: object) => string|null}} [opts]
 * @returns {object[]} entries with clusters spliced in (order preserved)
 */
export function clusterRepeatedEntries(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const minCount = Number.isFinite(opts.minCount) ? opts.minCount : 3;
  const signatureOf = typeof opts.signatureOf === "function" ? opts.signatureOf : defaultEntrySignature;
  const eligible = (e) => e && e.kind === "notice" && (e.notice_count || 1) === 1;
  const bySig = new Map();
  list.forEach((entry, index) => {
    if (!eligible(entry)) return;
    const sig = signatureOf(entry);
    if (!sig) return;
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(index);
  });
  const clusterAt = new Map();
  const absorbed = new Set();
  for (const [sig, indices] of bySig) {
    if (indices.length < minCount) continue;
    indices.forEach((i) => absorbed.add(i));
    clusterAt.set(indices[0], buildClusterEntry(sig, indices.map((i) => list[i])));
  }
  if (!clusterAt.size) return list;
  const out = [];
  list.forEach((entry, index) => {
    if (clusterAt.has(index)) { out.push(clusterAt.get(index)); return; }
    if (absorbed.has(index)) return;
    out.push(entry);
  });
  return out;
}

/**
 * Parcel lookup URLs for a 10-digit BBL (entity-link affordances on list cards).
 * Reuses site/property_location.mjs so ZoLa / ACRIS / Who Owns What stay one owner.
 * @param {string} bbl
 * @param {(bbl: string) => object|null} [linksFromBbl] — inject parcelLinksFromBbl in tests
 */
export function parcelLookupUrls(bbl, linksFromBbl) {
  const id = String(bbl || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(id)) return null;
  if (typeof linksFromBbl === "function") {
    const links = linksFromBbl(id);
    return links ? { bbl: id, ...links } : { bbl: id };
  }
  // Lazy-friendly pure shape when caller already has URLs; list UI imports
  // parcelLinksFromBbl from property_location.mjs directly.
  return {
    bbl: id,
    zola_url: `https://zola.planning.nyc.gov/l/lot/${id[0]}/${parseInt(id.slice(1, 6), 10)}/${parseInt(id.slice(6, 10), 10)}`,
    acris_url: `https://a836-acris.nyc.gov/bblsearch/bblsearch.asp?borough=${id[0]}&block=${parseInt(id.slice(1, 6), 10)}&lot=${parseInt(id.slice(6, 10), 10)}`,
    who_owns_what_url: `https://whoownswhat.justfix.org/bbl/${id}`,
  };
}
