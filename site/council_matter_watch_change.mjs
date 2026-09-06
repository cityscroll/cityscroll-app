/**
 * Semantic change reduction for exact Council-matter watches.
 *
 * Compares normalized official action state, not notice identity. Title,
 * formatting, duplicated notices, and acquisition timestamps are quiet.
 * Additions in one published matter revision become one logical update.
 */

import {
  COUNCIL_MATTER_WATCH_SCOPE_VERSION,
  canonicalCouncilMatterRef,
  parseCouncilMatterRef,
} from "./council_matter_watch_scope.mjs";

export const COUNCIL_MATTER_WATCH_CHANGE_SCHEMA = "cityscroll.council_matter_watch_change.v1";
export const MATTER_UPDATE_KIND = Object.freeze({
  OCCURRED: "occurred",
  SCHEDULED: "scheduled",
  CORRECTION: "correction",
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function clean(value, max = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function day(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || "";
}

function noticeList(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 80)).filter(Boolean).sort();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try { return noticeList(JSON.parse(trimmed)); } catch { /* fall through */ }
    }
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function voteText(observation) {
  const vote = observation?.vote && typeof observation.vote === "object" ? observation.vote : null;
  return clean(
    observation?.vote_result
      || vote?.result
      || observation?.vote_binding_status
      || "",
    240,
  );
}

export function normalizeOfficialActionText(value) {
  return clean(value, 500);
}

export function councilMatterActionIdentity(observation, matterRef) {
  const parsed = parseCouncilMatterRef(matterRef) || parseCouncilMatterRef(observation?.matter_ref);
  const ref = parsed?.matter_ref || matterRef || canonicalCouncilMatterRef("nyc", observation?.matter_id);
  const eventId = clean(observation?.event_id, 80);
  if (!ref || !eventId) return "";
  const itemId = clean(observation?.native_event_item_id || observation?.event_item_id, 80);
  const actionId = clean(observation?.publisher_action_id, 80);
  const parts = [ref, `event:${eventId}`];
  if (itemId) parts.push(`item:${itemId}`);
  else if (actionId) parts.push(`action:${actionId}`);
  return parts.join(":");
}

export function councilMatterSemanticFingerprint(observation) {
  return [
    normalizeOfficialActionText(observation?.action_name || observation?.outcome),
    voteText(observation),
  ].join("|");
}

function isQuietOnly(previous, current) {
  if (!previous) return false;
  return councilMatterSemanticFingerprint(previous) === councilMatterSemanticFingerprint(current)
    && councilMatterActionIdentity(previous, previous.matter_ref) === councilMatterActionIdentity(current, current.matter_ref);
}

function hasOccurredAction(observation) {
  const action = normalizeOfficialActionText(observation?.action_name || observation?.outcome).toLowerCase();
  if (!action) return false;
  if (/^scheduled\b/.test(action)) return false;
  return /laid over|approved|adopted|voted|passed|discharged|filed|withdrawn|amended|hearing held|heard by|recommended/i.test(action);
}

export function classifyCouncilMatterChange({ previous = null, current = null, asOf = null, baselineAcquiredAt = null } = {}) {
  if (!current) return null;
  const clock = day(asOf) || day(new Date().toISOString());
  const eventDay = day(current.event_time || current.observed_at);
  const status = clean(current.status || current.temporal_kind || current.action_status, 40).toLowerCase();
  if (status === MATTER_UPDATE_KIND.SCHEDULED
      || (!hasOccurredAction(current) && eventDay && clock && eventDay > clock)) {
    return MATTER_UPDATE_KIND.SCHEDULED;
  }
  if (previous && councilMatterActionIdentity(previous, previous.matter_ref) === councilMatterActionIdentity(current, current.matter_ref)
      && councilMatterSemanticFingerprint(previous) !== councilMatterSemanticFingerprint(current)) {
    return MATTER_UPDATE_KIND.CORRECTION;
  }
  if (baselineAcquiredAt && eventDay && eventDay < day(baselineAcquiredAt) && day(current.acquired_at) >= day(baselineAcquiredAt)) {
    return MATTER_UPDATE_KIND.OCCURRED;
  }
  return MATTER_UPDATE_KIND.OCCURRED;
}

function publishedRevisionOf(observation) {
  return clean(
    observation?.published_revision
      || observation?.generation_id
      || observation?.acquired_at
      || observation?.observation_id,
    240,
  );
}

function latestObservation(rows) {
  return [...rows].sort((left, right) => String(left.event_time || left.observed_at || "").localeCompare(String(right.event_time || right.observed_at || ""))
    || String(left.event_id || "").localeCompare(String(right.event_id || ""))).at(-1) || null;
}

export function matterUpdateKey(matterRef, publishedRevision) {
  return `council-matter:${matterRef}:rev:${clean(publishedRevision, 240)}`;
}

function kindForGroup(changes) {
  const kinds = new Set(changes.map((row) => row.kind));
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.has(MATTER_UPDATE_KIND.OCCURRED)) return MATTER_UPDATE_KIND.OCCURRED;
  if (kinds.has(MATTER_UPDATE_KIND.CORRECTION)) return MATTER_UPDATE_KIND.CORRECTION;
  return MATTER_UPDATE_KIND.SCHEDULED;
}

function copyForUpdate(kind, observation, { discoveredOlder = false } = {}) {
  const action = normalizeOfficialActionText(observation?.action_name || observation?.outcome);
  const when = day(observation?.event_time || observation?.observed_at);
  if (kind === MATTER_UPDATE_KIND.SCHEDULED) {
    return when
      ? `A hearing is scheduled for ${when}.`
      : "A hearing is scheduled.";
  }
  if (kind === MATTER_UPDATE_KIND.CORRECTION) {
    return action
      ? `Officials corrected the record for this meeting: ${action}.`
      : "Officials corrected the record for this meeting.";
  }
  if (discoveredOlder) {
    return action
      ? `A newly located older record shows ${action}${when ? ` (${when})` : ""}.`
      : "A newly located older record was added to this matter history.";
  }
  return action
    ? `Officials recorded: ${action}${when ? ` (${when})` : ""}.`
    : "Officials recorded a later action on this matter.";
}

/**
 * Reduce current observations against a confirmed baseline.
 *
 * Returns one logical update per published revision that contains a meaningful
 * official change. Callers persist owed membership; this function is pure.
 */
export function reduceCouncilMatterWatchUpdates({
  matter_ref: matterRefInput,
  observations = [],
  baseline = null,
  asOf = null,
  publishedGeneration = null,
} = {}) {
  const parsed = parseCouncilMatterRef(matterRefInput);
  if (!parsed) return [];
  const matterRef = parsed.matter_ref;
  const rows = (Array.isArray(observations) ? observations : [])
    .filter((row) => !row?.superseded_by)
    .map((row) => ({
      ...row,
      matter_id: String(row.matter_id || parsed.matter_id),
      matter_ref: matterRef,
      notice_references: noticeList(row.notice_references || row.notice_references_json),
    }));
  const knownIds = new Set(Array.isArray(baseline?.observation_ids) ? baseline.observation_ids : []);
  const baselineAcquired = baseline?.baseline_acquired_at || null;
  const baselineByAction = new Map();
  const currentByAction = new Map();
  for (const row of rows) {
    const key = councilMatterActionIdentity(row, matterRef);
    if (!key) continue;
    const inBaseline = knownIds.has(row.observation_id)
      || (baselineAcquired && String(row.acquired_at || "") <= String(baselineAcquired));
    if (inBaseline) baselineByAction.set(key, row);
    const prior = currentByAction.get(key);
    if (!prior || String(row.acquired_at || "") >= String(prior.acquired_at || "")) currentByAction.set(key, row);
  }
  const meaningful = [];
  for (const [key, row] of currentByAction) {
    const previous = baselineByAction.get(key) || null;
    if (isQuietOnly(previous, row)) continue;
    if (!previous && baselineAcquired && String(row.acquired_at || "") <= String(baselineAcquired)) continue;
    if (!previous && knownIds.has(row.observation_id)) continue;
    if (previous && councilMatterSemanticFingerprint(previous) === councilMatterSemanticFingerprint(row)) continue;
    const kind = classifyCouncilMatterChange({
      previous,
      current: row,
      asOf,
      baselineAcquiredAt: baselineAcquired,
    });
    if (!kind) continue;
    meaningful.push({
      observation: row,
      action_identity: key,
      kind,
      semantic_revision: clean(row.semantic_revision, 240) || councilMatterSemanticFingerprint(row),
      published_revision: publishedRevisionOf(row),
    });
  }
  const groups = new Map();
  for (const change of meaningful) {
    const bucket = groups.get(change.published_revision) || [];
    bucket.push(change);
    groups.set(change.published_revision, bucket);
  }
  const updates = [];
  for (const [revision, changes] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const primary = latestObservation(changes.map((row) => row.observation));
    const kind = kindForGroup(changes);
    const eventDay = day(primary?.event_time || primary?.observed_at);
    const discoveredOlder = Boolean(baselineAcquired && eventDay && eventDay < day(baselineAcquired));
    const key = matterUpdateKey(matterRef, revision);
    updates.push(freeze({
      schema: COUNCIL_MATTER_WATCH_CHANGE_SCHEMA,
      matter_update_key: key,
      matter_ref: matterRef,
      matter_id: parsed.matter_id,
      published_revision: revision,
      published_generation_id: clean(
        primary?.published_generation_id
          || primary?.generation_id
          || publishedGeneration?.generation_id,
        128,
      ) || null,
      published_generation_sequence: Number.isInteger(Number(
        primary?.published_generation_sequence ?? publishedGeneration?.sequence,
      )) && clean(primary?.published_generation_id || primary?.generation_id || publishedGeneration?.generation_id, 128)
        ? Number(primary?.published_generation_sequence ?? publishedGeneration?.sequence)
        : null,
      published_generation_at: clean(
        primary?.published_generation_at || (publishedGeneration?.generation_id && publishedGeneration?.published_at),
        80,
      ) || null,
      kind,
      action_name: normalizeOfficialActionText(primary?.action_name || primary?.outcome) || null,
      event_id: primary?.event_id || null,
      event_time: primary?.event_time || primary?.observed_at || null,
      observed_at: primary?.observed_at || null,
      acquired_at: primary?.acquired_at || null,
      observation_id: primary?.observation_id || null,
      href: `/matters/${encodeURIComponent(parsed.matter_id)}/`,
      short_title: copyForUpdate(kind, primary, { discoveredOlder }),
      discovered_older: discoveredOlder,
      constituents: changes.map((row) => ({
        action_identity: row.action_identity,
        kind: row.kind,
        semantic_revision: row.semantic_revision,
        event_id: row.observation.event_id || null,
        action_name: normalizeOfficialActionText(row.observation.action_name || row.observation.outcome) || null,
      })),
      council_matter_watch: {
        update_key: key,
        kind,
        watch_scope_version: COUNCIL_MATTER_WATCH_SCOPE_VERSION,
      },
      source_vintage: primary?.source_vintage || null,
      watch_scope_version: COUNCIL_MATTER_WATCH_SCOPE_VERSION,
    }));
  }
  return updates;
}

export function councilMatterUpdateDigestRows(updates = []) {
  return (Array.isArray(updates) ? updates : []).map((update) => freeze({
    matter_update_key: update.matter_update_key,
    alert_id: update.matter_update_key,
    matter_ref: update.matter_ref,
    matter_id: update.matter_id,
    event_id: update.event_id,
    observation_id: update.observation_id,
    short_title: update.short_title,
    action_name: update.action_name,
    start_date: update.event_time,
    observed_at: update.observed_at,
    acquired_at: update.acquired_at,
    href: update.href,
    kind: update.kind,
    published_revision: update.published_revision,
    published_generation_id: update.published_generation_id,
    published_generation_sequence: update.published_generation_sequence,
    published_generation_at: update.published_generation_at,
    constituents: update.constituents,
    council_matter_watch: update.council_matter_watch,
    discovered_older: update.discovered_older,
    source_vintage: update.source_vintage,
    watch_scope_version: update.watch_scope_version,
  }));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function renderCouncilMatterWatchUpdate(update, { includeSource = true } = {}) {
  if (!update?.matter_update_key) return "";
  const kind = update.kind || MATTER_UPDATE_KIND.OCCURRED;
  const href = update.href || `/matters/${encodeURIComponent(update.matter_id || "")}/`;
  const official = update.official_url
    ? ` <a class="node-source-link" href="${esc(update.official_url)}">Official record</a>`
    : "";
  const source = includeSource
    ? `<details class="matter-watch-source"><summary>Source identity and acquisition</summary>
        <dl>
          <div><dt>Publisher identity</dt><dd>${esc(update.matter_ref)}</dd></div>
          <div><dt>Update identity</dt><dd>${esc(update.matter_update_key)}</dd></div>
          <div><dt>Kind</dt><dd>${esc(kind)}</dd></div>
        </dl>
      </details>`
    : "";
  return `<article class="matter-watch-update" data-matter-update-kind="${esc(kind)}" data-matter-ref="${esc(update.matter_ref)}">
    <p class="matter-watch-latest">${esc(update.short_title)}</p>
    <p><a class="matter-follow-link" href="${esc(href)}">View matter history</a>${official}</p>
    ${source}
  </article>`;
}
