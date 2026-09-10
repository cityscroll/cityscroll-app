/**
 * Stable meeting delivery identity for calendar and watch.
 *
 * Source-qualified meeting ids stay distinct. An exact same-proceeding join
 * records aliases so a later collection representative cannot look like a
 * newly announced civic event. Calendar UID and watch seen-set use this key.
 */

import {
  MEETING_COLLECTION_SUPPRESSED,
  collectionVisibilityOf,
} from "./meeting_same_proceeding.mjs";
import { readerLabel } from "./reader_surface_labels.mjs";

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function addId(ids, value) {
  const id = text(value);
  if (id && !ids.includes(id)) ids.push(id);
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function sourceSystemOf(row = {}) {
  return text(row.source_system) || text(row.source?.system) || null;
}

function lifecycleOf(row = {}) {
  const status = text(row.status) || text(row.lifecycle) || text(row.occurrence_lifecycle);
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "rescheduled") return "rescheduled";
  return "scheduled";
}

/** Every source-qualified id that names the same proceeding. */
export function meetingDeliveryIds(row = {}) {
  const ids = [];
  addId(ids, row.meeting_id);
  addId(ids, row.delivery_key);
  addId(ids, row.request_id);
  const evidence = row.same_proceeding && typeof row.same_proceeding === "object"
    ? row.same_proceeding
    : null;
  if (evidence) {
    for (const id of Array.isArray(evidence.meeting_ids) ? evidence.meeting_ids : []) addId(ids, id);
    addId(ids, evidence.nyc_legistar_events_meeting_id);
    addId(ids, evidence.city_record_meeting_id);
  }
  for (const id of Array.isArray(row.delivery_aliases) ? row.delivery_aliases : []) addId(ids, id);
  return ids;
}

/**
 * Cluster key: the original Events feed identity when an exact join recorded
 * it, otherwise the row's own source-qualified meeting id.
 */
export function meetingDeliveryKey(row = {}) {
  const ids = meetingDeliveryIds(row);
  const legistar = ids.filter((id) => id.startsWith("meeting:nyc_legistar_events:")).sort();
  if (legistar.length) return legistar[0];
  return ids.slice().sort()[0] || null;
}

/** Identity plus cancellation or reschedule state. Scheduled first observations keep the bare identity. */
export function meetingDeliveryStateKey(row = {}) {
  const identity = meetingDeliveryKey(row);
  if (!identity) return null;
  const lifecycle = lifecycleOf(row);
  if (lifecycle === "cancelled") return `${identity}:cancelled`;
  if (lifecycle === "rescheduled") {
    const when = String(row.event_date || "").slice(0, 16);
    return when ? `${identity}:rescheduled:${when}` : `${identity}:rescheduled`;
  }
  return identity;
}

export function officialMeetingSourceLabel(row = {}) {
  const source = sourceSystemOf(row);
  if (source === "nyc_legistar_events" || source === "legistar") {
    return readerLabel("nyc_legistar_events", "NYC Council Legistar");
  }
  if (source === "city_record") return readerLabel("city_record", "City Record");
  return "Official source";
}

export function officialMeetingSourceActions(rows = []) {
  const actions = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const href = httpsUrl(row.source_url || row.source?.url);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    actions.push({
      label: officialMeetingSourceLabel(row),
      href,
      kind: "official_source",
      source_system: sourceSystemOf(row),
    });
  }
  return actions;
}

function sequenceOf(row = {}) {
  const value = row.sequence ?? row.sequence_number ?? row.revision;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null;
}

function pickRepresentative(members) {
  const visible = members.filter((row) => collectionVisibilityOf(row) !== MEETING_COLLECTION_SUPPRESSED);
  const pool = visible.length ? visible : members;
  const city = pool.find((row) => sourceSystemOf(row) === "city_record");
  return city || pool[0];
}

function clusterLifecycle(members) {
  if (members.some((row) => lifecycleOf(row) === "cancelled")) {
    return { status: "cancelled", lifecycle: "cancelled" };
  }
  const rescheduled = members.find((row) => lifecycleOf(row) === "rescheduled");
  if (rescheduled) {
    return {
      status: "scheduled",
      lifecycle: "rescheduled",
      event_date: rescheduled.event_date || null,
      sequence: sequenceOf(rescheduled) ?? 1,
      last_modified: rescheduled.last_modified || rescheduled.modified_at || null,
    };
  }
  const latestSequence = members
    .map(sequenceOf)
    .filter((value) => value != null)
    .sort((left, right) => right - left)[0];
  return {
    status: "scheduled",
    lifecycle: "scheduled",
    sequence: latestSequence,
  };
}

function unionSearchText(members) {
  return [...new Set(members.flatMap((row) => String(row.search_text || "")
    .split(/\s+/).filter(Boolean)))].join(" ").slice(0, 6_000) || null;
}

/**
 * One row per exact same-proceeding cluster. Display follows the collection
 * representative; calendar UID and delivery aliases follow the original EventId
 * when that identity is in the cluster.
 */
export function collapseMeetingDeliveryRows(rows = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = meetingDeliveryKey(row);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, members]) => {
    const representative = pickRepresentative(members);
    const lifecycle = clusterLifecycle(members);
    const aliases = [...new Set(members.flatMap((row) => meetingDeliveryIds(row)))];
    const eventIdMember = members.find((row) => text(row.meeting_id) === key) || representative;
    return {
      ...representative,
      object_ref: key,
      delivery_key: key,
      delivery_aliases: aliases,
      official_source_actions: officialMeetingSourceActions(members),
      search_text: unionSearchText(members) || representative.search_text || null,
      status: lifecycle.status,
      lifecycle: lifecycle.lifecycle,
      event_date: lifecycle.event_date || eventIdMember.event_date || representative.event_date,
      sequence: lifecycle.sequence ?? sequenceOf(eventIdMember) ?? sequenceOf(representative),
      last_modified: lifecycle.last_modified
        || eventIdMember.last_modified
        || representative.last_modified
        || null,
    };
  });
}

export function reconcileMeetingDelivery({ rows = [], seen = new Set() } = {}) {
  const fresh = [];
  const markSeenIds = [];
  const seenSet = seen instanceof Set ? seen : new Set(seen);
  for (const row of Array.isArray(rows) ? rows : []) {
    const identity = meetingDeliveryKey(row);
    if (!identity) continue;
    const aliases = meetingDeliveryIds(row);
    const stateKey = meetingDeliveryStateKey(row);
    const identitySeen = Boolean(identity && (seenSet.has(identity) || aliases.some((id) => seenSet.has(id))));
    const stateSeen = Boolean(stateKey && seenSet.has(stateKey));
    const scheduledRepeat = identitySeen && stateKey === identity;
    if (!stateSeen && !scheduledRepeat) fresh.push(row);
    for (const id of [...aliases, identity, stateKey]) {
      if (id && !markSeenIds.includes(id)) markSeenIds.push(id);
    }
  }
  return { fresh, markSeenIds };
}

export { lifecycleOf };
