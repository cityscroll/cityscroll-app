/**
 * Exact Administrative Code provision Following target.
 *
 * A watch is the persistent CodeProvision identity plus source-backed
 * lifecycle events. Text, current-version, agency, topic, and corpus-wide
 * legislation are never substitutes for that identity.
 */

import { resolveCodeChangeEffectiveDate } from "./code_version_materialization.mjs";
import {
  CODE_PROVISION_WATCH_SCHEMA,
  CODE_PROVISION_WATCH_SCOPE_VERSION,
  canonicalCodeProvisionId,
  exactProvisionWatch,
  provisionWatchCitation,
} from "./code_provision_watch_scope.mjs";

export {
  CODE_PROVISION_WATCH_SCHEMA,
  CODE_PROVISION_WATCH_LENS,
  CODE_PROVISION_WATCH_SCOPE_VERSION,
  canonicalCodeProvisionId,
  exactProvisionWatch,
  provisionFollowHref,
  provisionWatchCitation,
} from "./code_provision_watch_scope.mjs";

export const CODE_PROVISION_WATCH_EVENT_SCHEMA = "cityscroll.code_provision_watch_event.v1";
export const PROVISION_WATCH_EVENT_KINDS = Object.freeze([
  "proposed",
  "passed",
  "effective",
  "rule_citation",
]);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

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
  const match = clean(value, 80).match(ISO_DATE);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[0]) return null;
  return match[0];
}

function httpsUrl(value) {
  try {
    const url = new URL(clean(value, 2_000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function unsupported(reason, extra = {}) {
  return freeze({
    schema: CODE_PROVISION_WATCH_SCHEMA,
    status: "unsupported",
    lens: null,
    filter: {},
    provision_id: extra.provision_id || null,
    citation: extra.citation || null,
    watch_scope_version: CODE_PROVISION_WATCH_SCOPE_VERSION,
    reason,
    replayable: false,
  });
}

function changeTargets(change, provisionId) {
  const target = canonicalCodeProvisionId(change?.target?.provision_id || change?.target_provision_id);
  const successor = canonicalCodeProvisionId(change?.redesignation?.successor_provision_id);
  return target === provisionId || successor === provisionId;
}

function changeState(change) {
  const state = clean(change?.state, 40).toLowerCase();
  if (["prospective", "proposed", "pending", "introduced"].includes(state)) return "proposed";
  if (["enacted", "passed", "signed", "adopted"].includes(state)) return "passed";
  return null;
}

function sourceRecord(change) {
  const source = change?.source && typeof change.source === "object" ? change.source : {};
  const ref = clean(source.source_ref || change.source_ref || change.id, 500) || null;
  const url = httpsUrl(source.url || source.source_url || change.source_url);
  return {
    source_ref: ref,
    source_url: url,
    source_fields: freeze({
      instruction_text: clean(source.instruction_text, 8_000) || null,
      document_id: clean(source.document_id, 240) || null,
      source_system: clean(source.source_system || source.system, 160) || null,
    }),
    observed_at: day(source.observed_at || change.observed_at),
    source_vintage: day(source.observed_at || source.vintage || change.source_vintage) || null,
  };
}

function replayKey({ provisionId, kind, sourceRef, clock }) {
  if (!provisionId || !kind || !sourceRef || !clock) return null;
  return `legal-code:${provisionId}:${kind}:${sourceRef}:${clock}`;
}

function eventRecord({
  provisionId,
  kind,
  change = null,
  clock,
  effectiveAt = null,
  status = "occurred",
  reason = null,
  confirmed = false,
  citation = null,
  extraSource = null,
}) {
  const source = extraSource || sourceRecord(change);
  const key = replayKey({
    provisionId,
    kind,
    sourceRef: source.source_ref,
    clock,
  });
  if (!key && status === "occurred") {
    return freeze({
      schema: CODE_PROVISION_WATCH_EVENT_SCHEMA,
      status: "unknown",
      event_kind: kind,
      provision_id: provisionId,
      watch_scope_version: CODE_PROVISION_WATCH_SCOPE_VERSION,
      confirmation: { required: true, confirmed: false },
      replay_key: null,
      reason: "exact replay key cannot be preserved",
    });
  }
  return freeze({
    schema: CODE_PROVISION_WATCH_EVENT_SCHEMA,
    status,
    event_kind: kind,
    provision_id: provisionId,
    citation: citation || provisionWatchCitation(provisionId),
    watch_scope_version: CODE_PROVISION_WATCH_SCOPE_VERSION,
    confirmation: { required: true, confirmed: confirmed === true },
    change_id: change?.id || null,
    operation: change?.operation || null,
    source_record: source.source_ref,
    source_url: source.source_url,
    source_fields: source.source_fields,
    observed_at: source.observed_at,
    effective_at: effectiveAt,
    clock,
    source_vintage: source.source_vintage,
    replay_key: key,
    reason,
  });
}

function ruleCitationEvent(citation, provisionId, { asOf, confirmed }) {
  const cited = canonicalCodeProvisionId(citation?.provision_id || citation?.cited_provision_id);
  if (!cited) {
    return eventRecord({
      provisionId,
      kind: "rule_citation",
      clock: null,
      status: "unknown",
      reason: "rule citation is not an exact provision ref",
      confirmed,
      extraSource: {
        source_ref: clean(citation?.source_ref, 500) || null,
        source_url: httpsUrl(citation?.source_url),
        source_fields: freeze({ rule_id: clean(citation?.rule_id, 240) || null }),
        observed_at: day(citation?.observed_at),
        source_vintage: day(citation?.source_vintage || citation?.observed_at),
      },
    });
  }
  if (cited !== provisionId) return null;
  const clock = day(citation?.observed_at || citation?.published_at || asOf);
  const source = {
    source_ref: clean(citation?.source_ref || citation?.rule_id, 500) || null,
    source_url: httpsUrl(citation?.source_url),
    source_fields: freeze({
      rule_id: clean(citation?.rule_id, 240) || null,
      citation_span: clean(citation?.citation_span, 500) || null,
    }),
    observed_at: day(citation?.observed_at),
    source_vintage: day(citation?.source_vintage || citation?.observed_at),
  };
  if (!source.source_ref || !clock) {
    return eventRecord({
      provisionId,
      kind: "rule_citation",
      clock,
      status: "unknown",
      reason: "rule citation is missing source evidence or clock",
      confirmed,
      extraSource: source,
    });
  }
  return eventRecord({
    provisionId,
    kind: "rule_citation",
    clock,
    confirmed,
    extraSource: source,
  });
}

/**
 * Project distinct proposed / passed / effective events, plus optional exact
 * rule citations. Enactment never implies immediate effect.
 */
export function projectProvisionWatchEvents({
  provision_id: provisionIdInput = null,
  changes = [],
  versions = [],
  rule_citations = [],
  as_of = null,
  confirmed = false,
  stale = false,
} = {}) {
  const provisionId = canonicalCodeProvisionId(provisionIdInput);
  if (!provisionId) {
    return freeze({
      schema: CODE_PROVISION_WATCH_SCHEMA,
      status: "unsupported",
      provision_id: null,
      events: [],
      unresolved: [unsupported("exact provision identity is missing or not a canonical Administrative Code ref")],
    });
  }
  const asOf = day(as_of);
  const events = [];
  const unresolved = [];
  if (stale) {
    unresolved.push(freeze({
      status: "stale",
      provision_id: provisionId,
      reason: "source vintage is stale; no current opportunity is emitted",
    }));
    return freeze({
      schema: CODE_PROVISION_WATCH_SCHEMA,
      status: "stale",
      provision_id: provisionId,
      events: [],
      unresolved,
    });
  }

  for (const change of Array.isArray(changes) ? changes : []) {
    if (!changeTargets(change, provisionId)) continue;
    const lifecycle = changeState(change);
    const source = sourceRecord(change);
    if (!source.source_ref) {
      unresolved.push(eventRecord({
        provisionId,
        kind: lifecycle || "proposed",
        change,
        clock: null,
        status: "unknown",
        reason: "source record is missing",
        confirmed,
      }));
      continue;
    }
    if (lifecycle === "proposed") {
      const clock = source.observed_at || day(change.introduced_at || change.proposed_at);
      const event = eventRecord({
        provisionId,
        kind: "proposed",
        change,
        clock,
        status: clock ? "occurred" : "unknown",
        reason: clock ? null : "proposed change has no observed clock",
        confirmed,
      });
      (clock ? events : unresolved).push(event);
      continue;
    }
    if (lifecycle !== "passed") {
      unresolved.push(eventRecord({
        provisionId,
        kind: "passed",
        change,
        clock: null,
        status: "unknown",
        reason: "lifecycle relation is unsupported",
        confirmed,
      }));
      continue;
    }
    const passedAt = day(change.passed_at || change.enacted_at || change.signed_at);
    if (!passedAt) {
      unresolved.push(eventRecord({
        provisionId,
        kind: "passed",
        change,
        clock: null,
        status: "unresolved",
        reason: "enactment clock is missing",
        confirmed,
      }));
    } else {
      events.push(eventRecord({
        provisionId,
        kind: "passed",
        change,
        clock: passedAt,
        confirmed,
      }));
    }
    const effective = resolveCodeChangeEffectiveDate(change, {
      enacted_at: passedAt,
      local_law: change.local_law || {},
    });
    if (effective.resolution !== "resolved" || !effective.effective_at) {
      unresolved.push(eventRecord({
        provisionId,
        kind: "effective",
        change,
        clock: null,
        effectiveAt: null,
        status: "unresolved",
        reason: effective.reason || "effective date is missing or conditional",
        confirmed,
      }));
      continue;
    }
    if (asOf && effective.effective_at > asOf) continue;
    events.push(eventRecord({
      provisionId,
      kind: "effective",
      change,
      clock: effective.effective_at,
      effectiveAt: effective.effective_at,
      confirmed,
    }));
  }

  for (const citation of Array.isArray(rule_citations) ? rule_citations : []) {
    const event = ruleCitationEvent(citation, provisionId, { asOf, confirmed });
    if (!event) continue;
    (event.status === "occurred" ? events : unresolved).push(event);
  }

  const identityPreserved = Array.isArray(versions)
    ? versions.every((version) => !version?.provision_id || canonicalCodeProvisionId(version.provision_id) === provisionId)
    : true;

  return freeze({
    schema: CODE_PROVISION_WATCH_SCHEMA,
    status: events.length ? "ok" : (unresolved.length ? "unresolved" : "empty"),
    provision_id: provisionId,
    citation: provisionWatchCitation(provisionId),
    watch_scope_version: CODE_PROVISION_WATCH_SCOPE_VERSION,
    identity_preserved: identityPreserved,
    events,
    unresolved,
  });
}

export function provisionWatchDigestRows(lookup, {
  provision_id: provisionIdInput,
  as_of = null,
  confirmed = false,
} = {}) {
  const provisionId = canonicalCodeProvisionId(provisionIdInput);
  if (!provisionId) return [];
  const payload = lookup && typeof lookup === "object" ? lookup : {};
  const scoped = payload.provisions?.[provisionId] || payload;
  const projected = projectProvisionWatchEvents({
    provision_id: provisionId,
    changes: scoped.changes || payload.changes || [],
    versions: scoped.versions || payload.versions || [],
    rule_citations: scoped.rule_citations || payload.rule_citations || [],
    as_of: as_of || payload.as_of,
    confirmed,
    stale: payload.stale === true || scoped.stale === true,
  });
  return projected.events
    .filter((event) => event.status === "occurred" && event.replay_key && (confirmed === true ? event.confirmation.confirmed : true))
    .filter((event, index, rows) => rows.findIndex((row) => row.replay_key === event.replay_key) === index)
    .map((event) => freeze({
      alert_id: event.replay_key,
      request_id: event.replay_key,
      provision_id: event.provision_id,
      event_kind: event.event_kind,
      short_title: event.event_kind === "proposed"
        ? `Proposed change to Administrative Code ${event.citation}`
        : event.event_kind === "passed"
          ? `Amendment passed for Administrative Code ${event.citation}`
          : event.event_kind === "effective"
            ? `Amendment effective for Administrative Code ${event.citation}`
            : `Rule citation of Administrative Code ${event.citation}`,
      start_date: event.clock,
      source_url: event.source_url,
      source_record: event.source_record,
      source_vintage: event.source_vintage,
      effective_at: event.effective_at,
      watch_scope_version: event.watch_scope_version,
      href: event.source_url || `https://cityscroll.org/administrative-code/${encodeURIComponent(event.citation.replace(/^§\s+/, ""))}/`,
    }));
}

/**
 * Replay an exact provision watch. Null means the scope cannot be preserved.
 */
export function replayProvisionWatch(input, {
  todayISO = null,
  lookup = null,
  confirmed = false,
} = {}) {
  const watch = exactProvisionWatch(input);
  if (watch.status !== "ok" || watch.replayable !== true) return null;
  const projected = projectProvisionWatchEvents({
    provision_id: watch.provision_id,
    changes: lookup?.provisions?.[watch.provision_id]?.changes || lookup?.changes || [],
    versions: lookup?.provisions?.[watch.provision_id]?.versions || lookup?.versions || [],
    rule_citations: lookup?.provisions?.[watch.provision_id]?.rule_citations || lookup?.rule_citations || [],
    as_of: todayISO,
    confirmed,
    stale: lookup?.stale === true,
  });
  return freeze({
    schema: CODE_PROVISION_WATCH_SCHEMA,
    lens: watch.lens,
    filter: watch.filter,
    provision_id: watch.provision_id,
    watch_scope_version: watch.watch_scope_version,
    replayable: true,
    status: projected.status,
    events: projected.events,
    unresolved: projected.unresolved,
    digest_rows: provisionWatchDigestRows(lookup, {
      provision_id: watch.provision_id,
      as_of: todayISO,
      confirmed,
    }),
  });
}
