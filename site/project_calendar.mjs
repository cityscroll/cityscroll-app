/**
 * Project/entity calendar projection.
 *
 * The project is only a scope. Its calendar is assembled from source records
 * carried by accepted constellation edges and sent through the same
 * CalendarOccurrence producer used by ordinary feeds. There is deliberately no
 * project-owned event list to maintain.
 */

import {
  calendarOccurrencesForRecord,
  createCalendarOccurrence,
} from "./calendar_occurrence.mjs";
import {
  calendarNativeSubscriptionUrl,
} from "./calendar_subscription.mjs";
import {
  calendarFeedUrlForScope,
  emptyScope,
  scopeWithEntity,
  subscriptionParamsFromWatch,
} from "./scope_v0.mjs";

export const PROJECT_CALENDAR_SCHEMA = "cityscroll.project_calendar.v1";

function text(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function projectRef(value) {
  const ref = text(value, 80);
  return /^project:[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(ref) ? ref : null;
}

function sourceRecordForItem(item) {
  if (!item || typeof item !== "object") return null;
  return item.calendar_record || item.source_record || item.record || null;
}

function acceptedItem(item, group) {
  const state = text(item?.state || item?.status || group?.state, 30).toLowerCase();
  if (["held", "unknown", "empty", "unavailable"].includes(state)) return false;
  const confidence = text(item?.confidence || group?.confidence, 30).toLowerCase();
  return !confidence || ["strong", "tentative"].includes(confidence);
}

function connectedCandidates(input = {}) {
  const groups = Array.isArray(input.connections?.groups)
    ? input.connections.groups
    : Array.isArray(input.groups) ? input.groups : [];
  const fromGroups = groups.flatMap((group) => {
    if (group?.status !== "matched" || !Array.isArray(group.items)) return [];
    return group.items
      .filter((item) => acceptedItem(item, group))
      .map((item) => ({
        ...item,
        relation: item.relation || group.relation || group.id,
        calendar_record: sourceRecordForItem(item),
      }))
      .filter((item) => item.calendar_record);
  });
  const explicit = [
    ...(Array.isArray(input.connected_records) ? input.connected_records : []),
    ...(Array.isArray(input.connected) ? input.connected : []),
  ].filter((item) => acceptedItem(item, null));
  return [...fromGroups, ...explicit];
}

function semanticRecord(candidate, scopeRef) {
  const supplied = candidate.calendar_record || candidate.source_record || candidate.record;
  if (!supplied || typeof supplied !== "object") return null;
  const record = { ...supplied };
  const ref = text(candidate.object_ref || supplied.object_ref || supplied.subject_ref || candidate.ref, 240);
  if (ref) record.object_ref = ref;
  record.scope_ref = scopeRef;

  // Constellation item adapters may carry a source-backed date without owning
  // the domain field name. Preserve it as an event rather than dropping it.
  if (candidate.when && !record.event_date && !record.starts_at && !record.date) record.event_date = candidate.when;
  if (candidate.date && !record.event_date && !record.starts_at && !record.date) record.date = candidate.date;
  if (candidate.title && !record.title && !record.short_title && !record.name) record.title = candidate.title;
  if (candidate.source && !record.source && !record.source_provenance) record.source = candidate.source;
  if (candidate.canonical_url && !record.canonical_url) record.canonical_url = candidate.canonical_url;
  return record;
}

function milestoneCandidates(candidate, scopeRef) {
  const record = semanticRecord(candidate, scopeRef);
  if (!record) return [];
  if (record.time?.value && !record.event_date && !record.starts_at && !record.date) {
    return [{ ...candidate, calendar_record: {
      ...record,
      event_date: record.time.value,
      title: record.title || record.source_title || "Project milestone",
      object_ref: record.object_ref || `${scopeRef}:milestone`,
    } }];
  }
  if (!Array.isArray(record.milestones)) return [candidate];
  return record.milestones.map((milestone, index) => ({
    ...candidate,
    object_ref: `${scopeRef}:milestone:${text(milestone?.id, 120) || index}`,
    calendar_record: {
      ...record,
      milestones: undefined,
      object_ref: `${scopeRef}:milestone:${text(milestone?.id, 120) || index}`,
      title: milestone?.title || milestone?.source_title || record.title || "Project milestone",
      event_date: milestone?.review_meeting_at || milestone?.time?.value || milestone?.date || null,
      starts_at: milestone?.review_meeting_at || null,
      provenance: {
        ...(record.provenance || {}),
        basis: milestone?.time?.basis || "publisher_record",
        source_fields: ["milestones", "time"],
      },
    },
  })).filter((item) => item.calendar_record.event_date || item.calendar_record.starts_at);
}

function occurrenceKey(occurrence) {
  const when = occurrence.starts_at || occurrence.date || "";
  const normalize = (value) => text(value, 240).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const location = typeof occurrence.location === "string" ? occurrence.location : JSON.stringify(occurrence.location || "");
  return [occurrence.kind, when, normalize(occurrence.title), normalize(location)].join("|");
}

function withConnectionProvenance(occurrence, candidate) {
  const provenance = {
    ...(occurrence.provenance || {}),
    connected_relation: text(candidate.relation, 120) || null,
    connected_object_ref: text(candidate.object_ref || candidate.ref, 240) || occurrence.object_ref,
    source_record: occurrence.source || null,
  };
  return createCalendarOccurrence({ ...occurrence, provenance });
}

/** Aggregate future source-backed actions from accepted project connections. */
export function projectCalendarOccurrences(input = {}, { as_of = null } = {}) {
  const scopeRef = projectRef(input.project_ref || input.scope_ref || input.subject_ref);
  if (!scopeRef) return [];
  const seen = new Set();
  const occurrences = [];
  for (const rawCandidate of connectedCandidates(input)) {
    for (const candidate of milestoneCandidates(rawCandidate, scopeRef)) {
      const record = semanticRecord(candidate, scopeRef);
      if (!record) continue;
      const produced = calendarOccurrencesForRecord(record, {
        as_of: as_of || undefined,
        kind: candidate.kind || record.kind,
        object_ref: record.object_ref,
      });
      for (const occurrence of produced) {
        const key = occurrenceKey(occurrence);
        if (seen.has(key)) continue;
        seen.add(key);
        occurrences.push(withConnectionProvenance(occurrence, candidate));
      }
    }
  }
  return occurrences.sort((left, right) => String(left.starts_at || left.date).localeCompare(String(right.starts_at || right.date)));
}

/** Use the project outcome plus its current constellation edges as feed input. */
export function projectCalendarOccurrencesForRecord(record, options = {}) {
  const connections = record?.project_connections;
  if (!connections || connections.status !== "bounded") return [];
  const rootSources = Array.isArray(record?.project_calendar_sources)
    ? record.project_calendar_sources.map((source) => ({
      relation: source.relation || "project_process",
      object_ref: source.object_ref,
      calendar_record: source,
    }))
    : [];
  return projectCalendarOccurrences({
    project_ref: connections.project_ref || `project:${record.project_id}`,
    connections,
    connected_records: rootSources,
  }, options);
}

export function projectCalendarScope(projectId) {
  const ref = projectRef(String(projectId || "").startsWith("project:") ? projectId : `project:${projectId}`);
  if (!ref) return null;
  const scope = emptyScope();
  scope.facets.domains = ["entity"];
  return scopeWithEntity(scope, ref);
}

export function projectCalendarFeedUrl(projectId, { base } = {}) {
  const scope = projectCalendarScope(projectId);
  return scope ? calendarFeedUrlForScope(scope, base ? { base } : undefined) : null;
}

export function projectCalendarFollowHref(projectId, { base = "/following/", frequency = "weekly" } = {}) {
  const scope = projectCalendarScope(projectId);
  if (!scope) return null;
  const params = subscriptionParamsFromWatch({ lens: "entity", filter: scope.facets.values });
  if (["daily", "weekly"].includes(frequency)) params.set("freq", frequency);
  return `${String(base).replace(/\/$/, "")}?${params}`;
}

export function projectCalendarActionsHTML({ projectId, projectName = "" } = {}) {
  const feedUrl = projectCalendarFeedUrl(projectId);
  const webcalUrl = calendarNativeSubscriptionUrl(feedUrl);
  const followUrl = projectCalendarFollowHref(projectId);
  if (!feedUrl || !webcalUrl || !followUrl) return "";
  const label = projectName ? `Project · ${projectName}` : "Project calendar";
  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
  return `<span class="project-calendar-actions" data-project-calendar-actions="1"><a class="act project-follow-btn" data-project-follow="project" href="${esc(followUrl)}">Follow project</a><a class="act calendar-subscribe-btn" data-calendar-subscription="scope" data-calendar-subscription-feed="${esc(feedUrl)}" data-calendar-subscription-webcal="${esc(webcalUrl)}" data-calendar-subscription-label="${esc(label)}" href="${esc(webcalUrl)}" aria-label="Subscribe to project calendar for ${esc(projectName || projectId)}">Subscribe to project calendar</a></span>`;
}
