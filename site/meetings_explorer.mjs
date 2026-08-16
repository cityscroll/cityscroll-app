/**
 * Meetings domain explorer — list ontology over the public hearing arc.
 *
 * Elevates the Meetings lens on observed stage, next-action keys, and entity
 * links. Place-based local / citywide / unlocated grouping is opt-in (not the
 * default wall): near-me and affected-area filters are the primary place path.
 *   1. Observed timeline — scheduled / agenda / held / outcomes facts
 *   2. Next-action keys — attend / testify / join when notice text publishes them
 *   3. Cross-domain entity links — agency + place + optional matter refs
 *
 * Pure: no DOM, no fetch. Same list-ontology shape as site/property_explorer.mjs
 * and site/rules_explorer.mjs. Detail vote spine remains site/meeting_phase_spine.mjs;
 * non-Council process spine remains site/non_council_hearing_spine.mjs.
 */

import {
  meetingObservedState,
  meetingProcessProjection,
  observedMeetingStage,
} from "./meeting_process_profile.mjs";

export const MEETINGS_EXPLORER_SCHEMA_VERSION = 2;

/** Ordered observed stages for one public hearing / meeting notice. */
export const MEETING_PROCESS_PHASES = Object.freeze([
  "scheduled",
  "agenda",
  "held",
  "outcomes",
]);

export const MEETING_PROCESS_META = Object.freeze({
  scheduled: {
    id: "scheduled",
    short: "Scheduled",
    label_key: "meeting_stage_scheduled",
    action_key: "meeting_action_attend",
  },
  agenda: {
    id: "agenda",
    short: "Agenda",
    label_key: "meeting_stage_agenda",
    action_key: "meeting_action_review_agenda",
  },
  held: {
    id: "held",
    short: "Held",
    label_key: "meeting_stage_held",
    action_key: "meeting_action_review_held",
  },
  outcomes: {
    id: "outcomes",
    short: "Outcomes",
    label_key: "meeting_stage_outcomes",
    action_key: "meeting_action_review_outcomes",
  },
});

/** Observed-stage filter chips for the Meetings domain rail. */
export const MEETINGS_PROCESS_STAGES = Object.freeze([
  ["all", "stage_all"],
  ["scheduled", "meeting_stage_scheduled"],
  ["agenda", "meeting_stage_agenda"],
  ["held", "meeting_stage_held"],
  ["outcomes", "meeting_stage_outcomes"],
  ["unstaged", "rule_sibling_role_notice"],
]);

const PHASE_ORDER = new Map(MEETING_PROCESS_PHASES.map((id, i) => [id, i]));

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
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

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Concatenate notice text fields used for agenda / minutes / testimony signals.
 * @param {object} record — normalized hearing row
 */
export function meetingNoticeHaystack(record) {
  return [
    record?.title,
    record?.decides,
    record?.description,
    record?.notice_type,
    record?.agency,
    record?.short_title,
    record?.additional_description_1,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * True only when the record carries an observed agenda publication.
 * @param {object} record
 */
export function hasAgendaSignal(record) {
  return meetingObservedState(record).publications.agenda.state === "observed";
}

/**
 * True when minutes or an outcome publication is observed.
 * @param {object} record
 */
export function hasOutcomesSignal(record) {
  const publications = meetingObservedState(record).publications;
  return publications.minutes.state === "observed"
    || publications.outcome.state === "observed";
}

/**
 * True when a participation email is extractable for testimony/comment.
 * @param {object} record
 */
export function hasTestimonyChannel(record) {
  const emails = record?.participation?.emails;
  return Array.isArray(emails) && emails.some((e) => clean(e));
}

/**
 * True when an online join / materials URL is present.
 * @param {object} record
 */
export function hasParticipationLink(record) {
  const links = record?.participation?.links;
  return Array.isArray(links) && links.some((l) => l && clean(l.url));
}

/**
 * Explorer stage derived only from observed facts. The date anchor remains in
 * the signature for compatibility, but chronology cannot prove an event held.
 * @param {object} record
 * @param {object} [opts]
 * @param {string|null} [opts.now] — ISO day anchor (tests)
 * @returns {string|null}
 */
export function meetingProcessStage(record, opts = {}) {
  void opts;
  return observedMeetingStage(meetingObservedState(record));
}

/**
 * Filter key for process rail counts (includes "unstaged").
 * @param {object} record
 * @param {object} [opts]
 */
export function meetingProcessFilterKey(record, opts = {}) {
  return meetingProcessStage(record, opts) || "unstaged";
}

/**
 * Action i18n key for a process stage, preferring concrete participation channels.
 * @param {string|null} stage
 * @param {object|null} [record]
 */
export function meetingProcessActionKey(stage, record = null) {
  const id = stage && MEETING_PROCESS_META[stage] ? stage : null;
  if (!id) return "meeting_action_open_notice";

  // Prefer concrete channels when the notice published them (next-action axis).
  if ((id === "scheduled" || id === "agenda") && record) {
    if (hasParticipationLink(record)) {
      const links = record.participation?.links || [];
      const join = links.find((l) => l && /\bjoin\b/i.test(l.label || ""));
      if (join) return "meeting_action_join_online";
      return "meeting_action_open_materials";
    }
    if (hasTestimonyChannel(record)) return "meeting_action_submit_testimony";
    if (record.event_date) return "meeting_action_attend_dated";
  }
  if (id === "outcomes") return MEETING_PROCESS_META.outcomes.action_key;
  if (id === "held") return MEETING_PROCESS_META.held.action_key;
  if (id === "agenda") return MEETING_PROCESS_META.agenda.action_key;
  return MEETING_PROCESS_META.scheduled.action_key;
}

/**
 * Event identity key for collapsing same-board same-day notices into one card.
 * Requires both agency and event day — never groups on bare date alone.
 * @param {object} record
 */
export function meetingEventSubjectKey(record) {
  if (record?.meeting_id) return `meeting-object:${record.meeting_id}`;
  // Source-qualified rows without a materialized id are not safe to group by
  // display fields. The legacy fallback remains only for old compatibility
  // rows that predate the shared meeting object contract.
  if (record?.source_system || record?.source_keys?.length) return null;
  const agency = normalizeKey(record?.agency || record?.agency_name);
  const day = isoDate(record?.event_date);
  if (!agency || !day) return null;
  return `meeting-event:${agency}|${day}`;
}

/**
 * Matter-ish subject when the notice names a single matter (for multi-notice chain).
 * Uses agency + decides text — only when decides is long enough to be specific.
 * Never groups across agencies (false merge worse than split).
 * @param {object} record
 */
export function meetingMatterSubjectKey(record) {
  if (record?.meeting_id) return null;
  if (record?.source_system || record?.source_keys?.length) return null;
  const decides = clean(record?.decides);
  const agency = normalizeKey(record?.agency || record?.agency_name);
  if (!agency || !decides || decides.length < 24) return null;
  // Drop generic untitled / not-stated boilerplate.
  if (/does not give a short plain-language/i.test(decides)) return null;
  if (/^(?:public )?(?:hearing|meeting)s?(?: notice)?$/i.test(decides)) return null;
  return `meeting-matter:${agency}|${normalizeKey(decides).slice(0, 120)}`;
}

/**
 * Prefer local scope when merging multi-notice cards (preserve place strength).
 * @param {object[]} members
 */
export function pickPrimaryHearing(members) {
  const list = Array.isArray(members) ? members.filter(Boolean) : [];
  if (!list.length) return null;
  const rank = (r) => {
    const scope = r?.affected_area?.scope || "unlocated";
    if (scope === "local") return 0;
    if (scope === "citywide") return 1;
    return 2;
  };
  return [...list].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    // Prefer earlier event when same scope (stable for upcoming lists).
    return String(a.event_date || "").localeCompare(String(b.event_date || ""));
  })[0];
}

/**
 * Latest process stage across members (for multi-notice collapse).
 * @param {object[]} members
 * @param {object} [opts]
 */
export function entryCurrentProcessStage(members, opts = {}) {
  let best = null;
  let bestOrder = -1;
  for (const m of members || []) {
    const id = meetingProcessStage(m, opts);
    if (!id || !PHASE_ORDER.has(id)) continue;
    const order = PHASE_ORDER.get(id);
    if (order >= bestOrder) {
      bestOrder = order;
      best = id;
    }
  }
  return best;
}

/**
 * Participation channels unioned across members (first non-empty wins per kind).
 * @param {object[]} members
 */
export function unionParticipation(members) {
  const links = [];
  const emails = [];
  const phones = [];
  const seenUrl = new Set();
  const seenEmail = new Set();
  for (const m of members || []) {
    const p = m?.participation || {};
    for (const link of p.links || []) {
      const url = clean(link?.url);
      if (!url || seenUrl.has(url.toLowerCase())) continue;
      seenUrl.add(url.toLowerCase());
      links.push(link);
    }
    for (const email of p.emails || []) {
      const e = clean(email);
      if (!e || seenEmail.has(e.toLowerCase())) continue;
      seenEmail.add(e.toLowerCase());
      emails.push(e);
    }
    for (const phone of p.phones || []) {
      const ph = clean(phone);
      if (ph && !phones.includes(ph)) phones.push(ph);
    }
  }
  return {
    links: links.slice(0, 2),
    emails: emails.slice(0, 4),
    phones: phones.slice(0, 4),
  };
}

/**
 * Agency display name for entity link.
 * @param {object} record
 */
export function meetingsAgencyName(record) {
  return clean(record?.agency) || clean(record?.agency_name) || null;
}

/**
 * Build list entries for the Meetings explorer.
 * Same-agency same-day notices collapse to one event card; matter-subject chains
 * with ≥2 notices also collapse. Place scope stays on each member for grouping.
 *
 * @param {object[]} hearings — normalized hearing rows
 * @param {object} [opts]
 * @param {string|null} [opts.now]
 * @returns {object[]}
 */
export function buildMeetingsExplorerEntries(hearings, opts = {}) {
  const rows = Array.isArray(hearings) ? hearings.filter(Boolean) : [];
  const byEvent = new Map();
  const byMatter = new Map();

  for (const row of rows) {
    const eventKey = meetingEventSubjectKey(row);
    if (eventKey) {
      if (!byEvent.has(eventKey)) byEvent.set(eventKey, []);
      byEvent.get(eventKey).push(row);
    }
    const matterKey = meetingMatterSubjectKey(row);
    if (matterKey) {
      if (!byMatter.has(matterKey)) byMatter.set(matterKey, []);
      byMatter.get(matterKey).push(row);
    }
  }

  // Multi only when ≥2 notices share the key in-window.
  const multiEvent = new Set(
    [...byEvent.entries()].filter(([, ms]) => ms.length > 1).map(([k]) => k),
  );
  // Matter multi only when NOT already covered by a multi event (avoid double-collapse).
  const multiMatter = new Set();
  for (const [k, ms] of byMatter) {
    if (ms.length < 2) continue;
    // Skip if every member already sits in a multi-event group.
    const allInMultiEvent = ms.every((m) => multiEvent.has(meetingEventSubjectKey(m)));
    if (allInMultiEvent) continue;
    multiMatter.add(k);
  }

  const emitted = new Set();
  const entries = [];

  for (const row of rows) {
    const eventKey = meetingEventSubjectKey(row);
    const matterKey = meetingMatterSubjectKey(row);

    if (eventKey && multiEvent.has(eventKey)) {
      if (emitted.has(eventKey)) continue;
      emitted.add(eventKey);
      const members = byEvent.get(eventKey) || [row];
      // Also mark member request ids so matter collapse does not re-emit them.
      for (const m of members) {
        if (m?.request_id) emitted.add(`rid:${m.request_id}`);
        const mk = meetingMatterSubjectKey(m);
        if (mk) emitted.add(mk);
      }
      const primary = pickPrimaryHearing(members) || row;
      const processStage = entryCurrentProcessStage(members, opts);
      const processProjection = meetingProcessProjection(primary);
      const participation = unionParticipation(members);
      const primaryWithPart = {
        ...primary,
        participation: {
          ...(primary.participation || {}),
          links: participation.links.length
            ? participation.links
            : primary.participation?.links || [],
          emails: participation.emails.length
            ? participation.emails
            : primary.participation?.emails || [],
          phones: participation.phones.length
            ? participation.phones
            : primary.participation?.phones || [],
        },
      };
      const matched = [];
      for (const m of members) {
        const p = meetingProcessStage(m, opts);
        if (p && !matched.includes(p)) matched.push(p);
      }
      entries.push({
        kind: "event",
        schema_version: MEETINGS_EXPLORER_SCHEMA_VERSION,
        subject_ref: eventKey,
        primary: primaryWithPart,
        members,
        notice_count: members.length,
        meeting_family: processProjection.meeting_family,
        process_profile: processProjection.process_profile,
        observed_state: processProjection.observed,
        normative_expectations: processProjection.normative_expectations,
        process_role: processProjection.process_role,
        process_stage: processStage,
        process_filter: processStage || "unstaged",
        action_key: meetingProcessActionKey(processStage, primaryWithPart),
        agency: meetingsAgencyName(primary),
        title: clean(primary.decides) || clean(primary.title) || null,
        place_scope: primary.affected_area?.scope || "unlocated",
        event_date: isoDate(primary.event_date),
        matched_phases: matched,
        participation,
        join_method: "agency_event_date",
        sibling_notices: members.map((m) => ({
          request_id: m.request_id || null,
          title: clean(m.decides) || clean(m.title) || null,
          is_self: m.request_id === primary.request_id,
        })),
      });
      continue;
    }

    if (matterKey && multiMatter.has(matterKey)) {
      if (emitted.has(matterKey)) continue;
      // Skip if primary already emitted as part of another group.
      if (row.request_id && emitted.has(`rid:${row.request_id}`)) continue;
      emitted.add(matterKey);
      const members = byMatter.get(matterKey) || [row];
      for (const m of members) {
        if (m?.request_id) emitted.add(`rid:${m.request_id}`);
      }
      const primary = pickPrimaryHearing(members) || row;
      const processStage = entryCurrentProcessStage(members, opts);
      const processProjection = meetingProcessProjection(primary);
      const participation = unionParticipation(members);
      const primaryWithPart = {
        ...primary,
        participation: {
          ...(primary.participation || {}),
          links: participation.links.length
            ? participation.links
            : primary.participation?.links || [],
          emails: participation.emails.length
            ? participation.emails
            : primary.participation?.emails || [],
          phones: participation.phones.length
            ? participation.phones
            : primary.participation?.phones || [],
        },
      };
      const matched = [];
      for (const m of members) {
        const p = meetingProcessStage(m, opts);
        if (p && !matched.includes(p)) matched.push(p);
      }
      entries.push({
        kind: "matter",
        schema_version: MEETINGS_EXPLORER_SCHEMA_VERSION,
        subject_ref: matterKey,
        primary: primaryWithPart,
        members,
        notice_count: members.length,
        meeting_family: processProjection.meeting_family,
        process_profile: processProjection.process_profile,
        observed_state: processProjection.observed,
        normative_expectations: processProjection.normative_expectations,
        process_role: processProjection.process_role,
        process_stage: processStage,
        process_filter: processStage || "unstaged",
        action_key: meetingProcessActionKey(processStage, primaryWithPart),
        agency: meetingsAgencyName(primary),
        title: clean(primary.decides) || clean(primary.title) || null,
        place_scope: primary.affected_area?.scope || "unlocated",
        event_date: isoDate(primary.event_date),
        matched_phases: matched,
        participation,
        join_method: "matter_subject",
        sibling_notices: members.map((m) => ({
          request_id: m.request_id || null,
          title: clean(m.title) || null,
          event_date: isoDate(m.event_date),
          is_self: m.request_id === primary.request_id,
        })),
      });
      continue;
    }

    if (row.request_id && emitted.has(`rid:${row.request_id}`)) continue;
    if (row.request_id) emitted.add(`rid:${row.request_id}`);

    // Singleton hearing card
    const processProjection = meetingProcessProjection(row);
    const processStage = processProjection.observed_stage;
    entries.push({
      kind: "notice",
      schema_version: MEETINGS_EXPLORER_SCHEMA_VERSION,
      subject_ref: eventKey || (row.request_id ? `notice:${row.request_id}` : null),
      primary: row,
      members: [row],
      notice_count: 1,
      meeting_family: processProjection.meeting_family,
      process_profile: processProjection.process_profile,
      observed_state: processProjection.observed,
      normative_expectations: processProjection.normative_expectations,
      process_role: processProjection.process_role,
      process_stage: processStage,
      process_filter: processStage || "unstaged",
      action_key: meetingProcessActionKey(processStage, row),
      agency: meetingsAgencyName(row),
      title: clean(row.decides) || clean(row.title) || null,
      place_scope: row.affected_area?.scope || "unlocated",
      event_date: isoDate(row.event_date),
      matched_phases: processStage ? [processStage] : [],
      participation: row.participation || { links: [], emails: [], phones: [] },
      join_method: "single_notice",
      sibling_notices: [],
    });
  }

  return entries;
}

/**
 * Filter explorer entries by process stage (place / agency / keyword stay caller-side
 * via chooseHearingScope so meetings keep their place-based ladder).
 *
 * @param {object[]} entries
 * @param {object} opts
 * @param {string} [opts.process="all"]
 * @param {string|null} [opts.now]
 */
export function filterMeetingsExplorerEntries(entries, opts = {}) {
  const process = opts.process || "all";
  if (process === "all") return (entries || []).filter((e) => e && e.primary);

  return (entries || []).filter((entry) => {
    if (!entry || !entry.primary) return false;
    // The list facet represents one current position for each collapsed card.
    // Earlier member phases remain visible on the card/detail timeline, but do
    // not make this mutually exclusive bucket overlap another stage.
    return entry.process_filter === process;
  });
}

/**
 * Count process-filter keys across entries (for chip badges).
 * @param {object[]} entries
 */
export function countMeetingsProcessStages(entries) {
  const counts = { all: 0 };
  for (const [key] of MEETINGS_PROCESS_STAGES) {
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
 * Group entries by place scope for the opt-in place-based feed sections.
 * Default list render is flat chronological; grouping is demoted to an
 * explicit filter state (not the always-on wall). Order when enabled:
 * local → citywide → unlocated.
 * @param {object[]} entries
 */
export function groupMeetingsByPlace(entries) {
  const groups = { local: [], citywide: [], unlocated: [] };
  for (const entry of entries || []) {
    const scope = entry?.place_scope || entry?.primary?.affected_area?.scope || "unlocated";
    if (scope === "local") groups.local.push(entry);
    else if (scope === "citywide") groups.citywide.push(entry);
    else groups.unlocated.push(entry);
  }
  return groups;
}

/** Place-group mode keys for the Meetings list (opt-in grouping). */
export const MEETINGS_PLACE_GROUP_MODES = Object.freeze([
  ["flat", "meetings_place_group_flat"],
  ["place", "meetings_place_group_place"],
]);

/**
 * Whether the meetings list should render place-scope sections.
 * Default is flat (false). Only explicit "place" enables grouping.
 * @param {string|null|undefined} mode
 */
export function meetingsPlaceGroupEnabled(mode) {
  return String(mode || "flat").toLowerCase() === "place";
}

export {
  MEETING_PROCESS_PHASES as MEETINGS_PHASES,
  MEETING_PROCESS_META as MEETINGS_PHASE_META,
};
