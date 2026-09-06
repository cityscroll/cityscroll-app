#!/usr/bin/env node
/**
 * Build the committed legislative matter read model from the retained Council
 * meeting-outcome materialization.
 *
 * Two artifacts come out of this one builder, from one pass over one input:
 *
 *   site/data/legislative_matter_lookup.json — the full retained history for
 *     every published matter. Read by the `/matters/:id/` Pages-edge route.
 *   site/data/legislative_matter_index.json — the compact published population
 *     and each matter's own official address. Read by
 *     site/legislative_matter_availability.mjs, which every surface that offers
 *     a reader a way into a matter asks where that identity leads. That module
 *     is in the browser's first-load module graph, so it reads the small index
 *     rather than every retained appearance.
 *
 * The index is a projection of this same generation, not a second store of
 * evidence: it carries no appearance, action, vote, or receipt of its own, and
 * it is derived here so the two artifacts cannot describe different
 * populations.
 *
 * Identity rules, which are the substance of this builder:
 *
 *   Matter identity is the publisher system, the publisher tenant, and the
 *   immutable publisher matter id together — `legistar:nyc:matter:79200`. Two
 *   matters sharing a numeric id across tenants are not the same matter, and
 *   because the route is keyed by the bare id this builder publishes neither
 *   rather than guessing which one a reader meant.
 *
 *   An appearance is a matter at one native publisher event. A meeting is
 *   frequently announced by more than one City Record notice; those are
 *   repeated references to one event, not repeated hearings. Appearances are
 *   therefore grouped by event identity and every notice reference is kept as
 *   provenance on the single appearance.
 *
 *   Display labels are mutable and identity is not. A matter whose title or
 *   file label changes between observations keeps one history and shows the
 *   latest observed label; the labels it was previously observed under are
 *   retained as revisions rather than treated as a drift failure.
 *
 * What this builder does not do: infer a later action from the absence of one,
 * merge matters that only share a title, compose a publisher address the
 * retained record does not carry, or read a publisher at build time. Its only
 * input is the committed snapshot.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "site/data/meeting_outcomes_snapshot.json");
const LOOKUP_OUTPUT = join(ROOT, "site/data/legislative_matter_lookup.json");
const INDEX_OUTPUT = join(ROOT, "site/data/legislative_matter_index.json");

export const LEGISLATIVE_MATTER_LOOKUP_SCHEMA = "cityscroll.legislative_matter_lookup.v1";
export const LEGISLATIVE_MATTER_INDEX_SCHEMA = "cityscroll.legislative_matter_index.v1";

const SOURCE_SYSTEM = "legistar";
const INPUT_ARTIFACT = "site/data/meeting_outcomes_snapshot.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function clean(value, max = 1000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function exactMatterId(value) {
  const id = clean(value, 80);
  return /^\d+$/.test(id) ? id : null;
}

function safeHttps(value) {
  try {
    const url = new URL(clean(value, 2000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The publisher tenant this matter belongs to, read from the address the
 * retained record already carries. Nothing is composed: an address the record
 * does not supply leaves the tenant unresolved, and an unresolved tenant is
 * kept distinct from every resolved one rather than assumed to be the common
 * case.
 */
function publisherTenant(matterUrl) {
  const href = safeHttps(matterUrl);
  if (!href) return null;
  const host = new URL(href).hostname.toLowerCase();
  const match = /^([a-z0-9-]+)\.legistar(?:\d+)?\.com$/.exec(host);
  return match ? match[1] : null;
}

function canonicalRef(tenant, matterId) {
  return `${SOURCE_SYSTEM}:${tenant || "unresolved-tenant"}:matter:${matterId}`;
}

function exactBodyId(event) {
  const value = event?.body_id || event?.committee_id || event?.body?.id;
  return /^\d+$/.test(String(value || "").trim()) ? String(value).trim() : null;
}

function eventProjection(event) {
  return {
    event_id: clean(event.event_id, 80),
    name: clean(event.name || "Council meeting", 240),
    date: clean(event.date, 20),
    url: clean(event.url, 1000),
    body_id: exactBodyId(event),
    documents: (Array.isArray(event.documents) ? event.documents : []).map((document) => ({
      name: clean(document?.name || "Official meeting record", 120),
      url: clean(document?.url, 1000),
    })).filter((document) => /^https:\/\//.test(document.url)),
  };
}

/** The mutable display fields, as observed at one appearance. */
function observedLabels(matter) {
  return {
    matter_file: clean(matter?.matter_file, 120),
    title: clean(matter?.title, 500),
    matter_type: clean(matter?.matter_type, 120) || null,
    matter_status: clean(matter?.status, 160) || null,
    matter_href: safeHttps(matter?.matter_url),
  };
}

const LABEL_FIELDS = ["matter_file", "title", "matter_type", "matter_status", "matter_href"];

function sameLabels(left, right) {
  return LABEL_FIELDS.every((key) => left[key] === right[key]);
}

/**
 * One observation of a matter at an event, through one City Record notice.
 * Several of these can describe one appearance; `coalesceAppearance` folds them
 * without discarding any reference.
 */
function observationFor(requestId, record, matter) {
  return {
    request_id: clean(requestId, 80),
    event: eventProjection(record.event || {}),
    labels: observedLabels(matter),
    actions: (Array.isArray(matter?.actions) ? matter.actions : [])
      .map((action) => clean(action, 240))
      .filter(Boolean),
    outcome: clean(matter?.outcome, 240) || null,
    votes: matter?.votes ?? null,
  };
}

/**
 * Fold every observation of one matter at one event into a single appearance.
 *
 * The first reference in notice order supplies the displayed event projection
 * and the retained outcome and vote rows; the actions of every reference are
 * unioned so nothing observed is dropped; and each reference keeps its own
 * notice identity and source address. Two notices announcing one meeting
 * therefore produce one appearance with two provenance rows, never two
 * appearances.
 */
function coalesceAppearance(matterId, canonical, observations, snapshotGeneratedAt) {
  const ordered = [...observations].sort((left, right) => left.request_id.localeCompare(right.request_id));
  const primary = ordered[0];
  const actions = [...new Set(ordered.flatMap((observation) => observation.actions))];
  const outcome = ordered.map((observation) => observation.outcome).find(Boolean) || null;
  const votes = ordered.map((observation) => observation.votes).find((value) => value != null) || null;
  const labels = ordered[ordered.length - 1].labels;
  const event = primary.event;
  const notices = ordered.map((observation) => ({
    request_id: observation.request_id,
    notice_href: `/notices/${encodeURIComponent(observation.request_id)}/`,
    source_url: observation.event.url || null,
  }));
  return {
    request_id: primary.request_id,
    notice_references: notices,
    event,
    committee: {
      label: clean(event.name || "Committee not listed", 240),
      body_id: event.body_id,
      join_state: event.body_id ? "matched_exact_body_id" : "unresolved_no_explicit_body_id",
    },
    matter_id: matterId,
    matter_ref: canonical,
    matter_file: labels.matter_file,
    actions,
    outcome,
    matter_type: labels.matter_type,
    matter_status: labels.matter_status,
    votes,
    source_receipt: {
      source_system: SOURCE_SYSTEM,
      request_id: primary.request_id,
      request_ids: notices.map((notice) => notice.request_id),
      event_id: event.event_id,
      source_url: event.url,
      input_artifact: INPUT_ARTIFACT,
      snapshot_generated_at: clean(snapshotGeneratedAt || "", 80) || null,
    },
  };
}

/** Source event time orders the history a reader reads. */
function orderAppearances(left, right) {
  return String(left.event.date).localeCompare(String(right.event.date))
    || String(left.event.event_id).localeCompare(String(right.event.event_id));
}

function orderObservations(left, right) {
  return String(left.event.date).localeCompare(String(right.event.date))
    || String(left.event.event_id).localeCompare(String(right.event.event_id))
    || left.request_id.localeCompare(right.request_id);
}

/**
 * Group every retained observation by matter identity and then by event
 * identity. The result is keyed by canonical ref, so a numeric id observed
 * under two tenants stays two groups.
 */
function groupObservations(snapshot) {
  const groups = new Map();
  for (const [requestId, record] of Object.entries(snapshot.by_notice || {})) {
    if (record?.snapshot_state !== "present") continue;
    const event = record.event || {};
    if (!clean(event.event_id, 80)) continue;
    for (const matter of Array.isArray(record.matters) ? record.matters : []) {
      const matterId = exactMatterId(matter?.matter_id);
      if (!matterId) continue;
      const tenant = publisherTenant(matter?.matter_url);
      const canonical = canonicalRef(tenant, matterId);
      if (!groups.has(canonical)) {
        groups.set(canonical, { canonical, matter_id: matterId, tenant, events: new Map() });
      }
      const group = groups.get(canonical);
      const eventId = clean(event.event_id, 80);
      if (!group.events.has(eventId)) group.events.set(eventId, []);
      group.events.get(eventId).push(observationFor(requestId, record, matter));
    }
  }
  return groups;
}

/** The label revisions this matter was previously observed under, oldest first. */
function labelRevisions(observations, current) {
  const revisions = [];
  for (const observation of observations) {
    if (sameLabels(observation.labels, current)) continue;
    if (revisions.some((revision) => sameLabels(revision.labels, observation.labels))) continue;
    revisions.push({ labels: observation.labels, observation });
  }
  return revisions.map(({ labels, observation }) => ({
    matter_file: labels.matter_file,
    title: labels.title,
    matter_href: labels.matter_href,
    observed_event_id: observation.event.event_id,
    observed_event_date: observation.event.date,
    observed_request_id: observation.request_id,
  }));
}

export function buildLegislativeMatterLookup(snapshot = {}) {
  const generatedAt = clean(snapshot.generated_at, 80) || null;
  const groups = groupObservations(snapshot);

  // A numeric id claimed by more than one tenant cannot address one route.
  // Publish neither and say so, rather than merging two publishers' matters or
  // silently letting the last one win.
  const byMatterId = new Map();
  for (const group of groups.values()) {
    if (!byMatterId.has(group.matter_id)) byMatterId.set(group.matter_id, []);
    byMatterId.get(group.matter_id).push(group);
  }

  const identityCollisions = [];
  const matters = {};
  for (const matterId of [...byMatterId.keys()].sort((left, right) => Number(left) - Number(right))) {
    const claimants = byMatterId.get(matterId);
    if (claimants.length > 1) {
      identityCollisions.push({
        matter_id: matterId,
        reason: "same_matter_id_across_publisher_tenants",
        claimants: claimants.map((group) => group.canonical).sort(),
      });
      continue;
    }
    const group = claimants[0];
    const appearances = [...group.events.values()]
      .map((observations) => coalesceAppearance(matterId, group.canonical, observations, generatedAt))
      .sort(orderAppearances);
    if (!appearances.length) continue;

    // Identity is the id; the label is whatever the publisher most recently
    // called it. Earlier labels are kept as observed revisions so a renamed
    // matter reads as one continuous history rather than a broken one.
    const observations = [...group.events.values()].flat().sort(orderObservations);
    const current = observations[observations.length - 1].labels;
    matters[matterId] = {
      matter_id: matterId,
      matter_ref: group.canonical,
      publisher_tenant: group.tenant,
      matter_file: current.matter_file,
      title: current.title,
      matter_type: current.matter_type,
      matter_status: current.matter_status,
      matter_href: current.matter_href,
      label_revisions: labelRevisions(observations, current),
      appearances,
    };
  }

  return {
    schema: LEGISLATIVE_MATTER_LOOKUP_SCHEMA,
    generated_at: generatedAt,
    source: {
      system: SOURCE_SYSTEM,
      input_artifact: INPUT_ARTIFACT,
      identity: "{source_system}:{publisher_tenant}:matter:{legistar_matter_id}",
      exact_key_only: true,
      appearance_identity: "native publisher event id; repeated notice references are coalesced provenance",
    },
    identity_collisions: identityCollisions,
    matters,
  };
}

/**
 * The compact published population, derived from the lookup this same run
 * produced. It carries exactly what the shared availability rule needs — which
 * ids have a local history, and the official address each matter is known by —
 * and deliberately nothing else.
 */
export function buildLegislativeMatterIndex(lookup = {}) {
  const matters = {};
  for (const [matterId, entry] of Object.entries(lookup.matters || {})) {
    matters[matterId] = {
      matter_id: matterId,
      matter_ref: entry.matter_ref || null,
      matter_href: entry.matter_href || null,
      appearance_count: Array.isArray(entry.appearances) ? entry.appearances.length : 0,
    };
  }
  return {
    schema: LEGISLATIVE_MATTER_INDEX_SCHEMA,
    generated_at: lookup.generated_at || null,
    source: {
      system: SOURCE_SYSTEM,
      input_artifact: INPUT_ARTIFACT,
      derived_from: "site/data/legislative_matter_lookup.json",
      note: "Published population and official addresses only. Appearances, actions, votes and receipts stay in the lookup.",
    },
    matters,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const lookup = buildLegislativeMatterLookup(readJson(INPUT));
  const outputs = [
    [LOOKUP_OUTPUT, `${JSON.stringify(lookup, null, 2)}\n`],
    [INDEX_OUTPUT, `${JSON.stringify(buildLegislativeMatterIndex(lookup), null, 2)}\n`],
  ];
  let stale = false;
  for (const [path, output] of outputs) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (check) {
      if (current !== output) {
        console.error(`legislative matter artifact is stale: ${path}`);
        stale = true;
      }
    } else {
      writeFileSync(path, output);
      console.log(`wrote ${path}`);
    }
  }
  if (check) {
    if (stale) process.exit(1);
    console.log("Legislative matter artifacts are current");
  }
}
