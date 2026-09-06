/**
 * Exact Council-matter Following evaluation against retained observations.
 *
 * Compile reads the retained journal or compact snapshot. Delivery eligibility
 * is gated separately and stays off until end-to-end activation.
 */

import snapshot from "./data/meeting_outcomes_snapshot.json" with { type: "json" };
import {
  COUNCIL_MATTER_WATCH_SCHEMA,
  COUNCIL_MATTER_WATCH_SCOPE_VERSION,
  canonicalCouncilMatterRef,
  councilMatterFollowHref,
  exactCouncilMatterWatch,
  isRetainedCouncilMatter,
  parseCouncilMatterRef,
  retainedMatterIdsFromSnapshot,
} from "./council_matter_watch_scope.mjs";

export {
  COUNCIL_MATTER_KNOWN_TENANTS,
  COUNCIL_MATTER_SOURCE_SYSTEM,
  COUNCIL_MATTER_TENANT_NYC,
  COUNCIL_MATTER_WATCH_LENS,
  COUNCIL_MATTER_WATCH_SCHEMA,
  COUNCIL_MATTER_WATCH_SCOPE_VERSION,
  canonicalCouncilMatterRef,
  councilMatterFollowHref,
  exactCouncilMatterWatch,
  hasCouncilMatterScopeAttempt,
  isRetainedCouncilMatter,
  parseCouncilMatterRef,
  retainedMatterIdsFromSnapshot,
} from "./council_matter_watch_scope.mjs";

export const COUNCIL_MATTER_WATCH_EVENT_SCHEMA = "cityscroll.council_matter_watch_event.v1";
export const MATTER_WATCH_DELIVERY_ENV = "MATTER_WATCH_DELIVERY";

const DEFAULT_ROSTER = retainedMatterIdsFromSnapshot(snapshot);

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

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function matterWatchDeliveryEnabled(env = {}) {
  const value = env[MATTER_WATCH_DELIVERY_ENV];
  return value === true || value === "1" || value === "true";
}

export function defaultRetainedMatterRoster() {
  return DEFAULT_ROSTER;
}

export function resolveExactCouncilMatterWatch(input = {}, { roster = DEFAULT_ROSTER } = {}) {
  const watch = exactCouncilMatterWatch(input);
  if (watch.status !== "ok") return watch;
  if (!isRetainedCouncilMatter(watch, roster)) {
    return freeze({
      ...watch,
      status: "unsupported",
      attempted: true,
      lens: null,
      filter: {},
      replayable: false,
      reason: "exact Council matter identity is not in the retained roster",
    });
  }
  return watch;
}

function appearanceRowsFromSnapshot(matterId) {
  const rows = [];
  for (const [requestId, record] of Object.entries(snapshot?.by_notice || {})) {
    for (const matter of record?.matters || []) {
      if (String(matter?.matter_id) !== String(matterId)) continue;
      const eventId = clean(record?.event?.event_id, 80);
      const action = clean((Array.isArray(matter.actions) ? matter.actions.at(-1) : "") || matter.outcome, 240);
      const observedAt = clean(record?.event?.date || snapshot.generated_at, 80);
      rows.push({
        event_id: eventId,
        request_id: requestId,
        title: clean(matter.title, 500),
        action_name: action,
        event_time: observedAt,
        observed_at: observedAt,
        acquired_at: snapshot.generated_at,
        semantic_revision: clean(matter.outcome || action || eventId, 240),
        observation_id: `snapshot:${matterId}:${eventId}:${requestId}`,
        notice_references: [requestId],
      });
    }
  }
  return rows.sort((left, right) => String(left.event_time).localeCompare(String(right.event_time))
    || String(left.event_id).localeCompare(String(right.event_id)));
}

export function retainedAppearancesForMatter(matterId, observations = null) {
  if (Array.isArray(observations)) {
    return observations.filter((row) => String(row?.matter_id) === String(matterId));
  }
  return appearanceRowsFromSnapshot(matterId);
}

function replayKey(matterRef, row) {
  return `council-matter:${matterRef}:${row.event_id || "event"}:${row.observation_id || row.semantic_revision}`;
}

export function councilMatterDigestRows({
  matter_ref: matterRefInput,
  observations = null,
  baseline = null,
  confirmed = false,
  deliveryEnabled = false,
} = {}) {
  const parsed = parseCouncilMatterRef(matterRefInput);
  if (!parsed) return [];
  const rows = retainedAppearancesForMatter(parsed.matter_id, observations);
  const baselineAcquired = baseline?.baseline_acquired_at || null;
  const known = new Set(Array.isArray(baseline?.observation_ids) ? baseline.observation_ids : []);
  return rows
    .filter((row) => {
      if (!confirmed) return true;
      if (known.has(row.observation_id)) return false;
      if (baselineAcquired && String(row.acquired_at || "") <= String(baselineAcquired)) return false;
      return true;
    })
    .filter((row) => deliveryEnabled || !confirmed)
    .map((row) => freeze({
      alert_id: replayKey(parsed.matter_ref, row),
      request_id: replayKey(parsed.matter_ref, row),
      matter_ref: parsed.matter_ref,
      matter_id: parsed.matter_id,
      event_id: row.event_id || null,
      observation_id: row.observation_id || null,
      short_title: row.action_name
        ? `${row.action_name} · Council matter ${parsed.matter_id}`
        : (row.title || `Council matter ${parsed.matter_id}`),
      start_date: row.event_time || row.observed_at || null,
      observed_at: row.observed_at || null,
      acquired_at: row.acquired_at || null,
      semantic_revision: row.semantic_revision || null,
      source_vintage: snapshot.generated_at,
      href: `/matters/${encodeURIComponent(parsed.matter_id)}/`,
      watch_scope_version: COUNCIL_MATTER_WATCH_SCOPE_VERSION,
    }));
}

export function latestObservedAction(matterId, observations = null) {
  const rows = retainedAppearancesForMatter(matterId, observations);
  const latest = rows.at(-1);
  if (!latest) return null;
  return freeze({
    matter_id: String(matterId),
    action_name: latest.action_name || null,
    event_id: latest.event_id || null,
    event_time: latest.event_time || latest.observed_at || null,
    title: latest.title || null,
  });
}

export function councilMatterFollowMarkup(input, { label = null, className = "matter-follow-link" } = {}) {
  const watch = exactCouncilMatterWatch(input);
  if (watch.status !== "ok") return "";
  const href = councilMatterFollowHref(watch);
  if (!href) return "";
  const text = label || `Follow Council matter ${watch.matter_id}`;
  return `<a class="${esc(className)}" href="${esc(href)}" data-matter-id="${esc(watch.matter_id)}" data-matter-ref="${esc(watch.matter_ref)}">${esc(text)}</a>`;
}

export function councilMatterChoiceMarkup(matters, { className = "matter-follow-choice" } = {}) {
  const rows = (Array.isArray(matters) ? matters : [])
    .map((matter) => {
      const watch = exactCouncilMatterWatch({
        lens: "meetings",
        matter_id: matter?.matter_id || matter,
      });
      if (watch.status !== "ok") return "";
      const href = councilMatterFollowHref(watch);
      if (!href) return "";
      const file = clean(matter?.matter_file || `Matter ${watch.matter_id}`, 120);
      return `<li class="meeting-matter-follow-item" data-matter-id="${esc(watch.matter_id)}">${councilMatterFollowMarkup(watch, {
        label: `Follow ${file}`,
        className: "matter-follow-link meeting-matter-follow",
      })}</li>`;
    })
    .filter(Boolean);
  if (!rows.length) return "";
  return `<ul class="${esc(className)}" data-matter-follow-choice="${esc(String(rows.length))}">${rows.join("")}</ul>`;
}

export function councilMatterWatchSummaryHtml(watchInput, { latest = null, stale = false } = {}) {
  const watch = exactCouncilMatterWatch(watchInput);
  if (watch.status !== "ok") {
    return `<p class="following-scope-error" role="status">This exact matter watch cannot be saved. ${esc(watch.reason || "The identity is not supported.")}</p>`;
  }
  const observed = latest || latestObservedAction(watch.matter_id);
  const action = observed?.action_name
    ? `Latest observed official action: ${observed.action_name}${observed.event_time ? ` (${observed.event_time})` : ""}.`
    : "No later official action has been located.";
  const staleNote = stale
    ? `<p class="matter-watch-stale" role="status">The last known history is still shown. A later refresh has not been applied.</p>`
    : "";
  return `<section class="matter-watch-summary" data-matter-ref="${esc(watch.matter_ref)}">
    <p>This watch is for New York City Council matter ${esc(watch.matter_id)} only. Other matters heard at the same meeting are not included.</p>
    <p class="matter-watch-latest">${esc(action)}</p>
    ${staleNote}
    <details class="matter-watch-source"><summary>Source identity and acquisition</summary>
      <dl>
        <div><dt>Publisher identity</dt><dd>${esc(watch.matter_ref)}</dd></div>
        <div><dt>Scope version</dt><dd>${esc(String(watch.watch_scope_version))}</dd></div>
        <div><dt>Retained vintage</dt><dd>${esc(snapshot.generated_at)}</dd></div>
      </dl>
    </details>
  </section>`;
}
