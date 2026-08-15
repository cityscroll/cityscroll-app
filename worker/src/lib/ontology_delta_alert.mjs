import currentEntityIntelligence from "../data/entity_intelligence_lookup.json" with { type: "json" };
import previousOntologyInventory from "../../../site/data/ontology_inventory_baseline.json" with { type: "json" };

import { toDayLogEntry } from "./digest_ops.mjs";

export const ONTOLOGY_DELTA_EVENT_SCHEMA = "cityscroll.semantic_event.ontology_delta.v1";
export const ONTOLOGY_DELTA_SHADOW_CONTRACT = "ontology-delta-shadow.v1";
export const ONTOLOGY_DELTA_EVENT_TYPE = "ontology_delta";
export const ONTOLOGY_DELTA_SCOPE = "civic_graph";
const MAX_CANDIDATES = 100;

function token(value, max = 120) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean || clean.length > max || !/^[a-z0-9][a-z0-9._:-]*$/.test(clean)) return null;
  return clean;
}

function sortedTokens(values) {
  return [...new Set((values || []).map((value) => token(value)).filter(Boolean))].sort();
}

function currentInventory(materialization = {}) {
  const entityTypes = new Set();
  const edgeTypes = new Set();
  for (const row of Object.values(materialization?.by_ref || {})) {
    const entityType = token(row?.root?.kind);
    if (entityType) entityTypes.add(entityType);
    for (const link of row?.links || []) {
      const edgeType = token(link?.type || link?.link_type);
      if (edgeType) edgeTypes.add(edgeType);
    }
    for (const domain of Object.values(row?.domains || {})) {
      for (const object of domain?.objects || []) {
        const edgeType = token(object?.link_type);
        if (edgeType) edgeTypes.add(edgeType);
      }
    }
  }
  return {
    as_of: materialization?.generated_at || null,
    entity_types: [...entityTypes].sort(),
    edge_types: [...edgeTypes].sort(),
  };
}

function priorInventory(inventory = {}) {
  return {
    as_of: inventory?.as_of || inventory?.generated_at || null,
    entity_types: sortedTokens(inventory?.entity_types || inventory?.root_kinds),
    edge_types: sortedTokens(inventory?.edge_types),
  };
}

function transitionKey(dimension, value, scope = ONTOLOGY_DELTA_SCOPE) {
  return `ontology-delta:${scope}:${dimension}:${value}:absent-to-present`;
}

function semanticEvent(dimension, value, { previousAsOf = null, observedAt = null } = {}) {
  return {
    schema: ONTOLOGY_DELTA_EVENT_SCHEMA,
    event_type: ONTOLOGY_DELTA_EVENT_TYPE,
    dimension,
    value,
    scope: ONTOLOGY_DELTA_SCOPE,
    transition_key: transitionKey(dimension, value),
    old_state: { present: false, as_of: previousAsOf },
    new_state: { present: true, observed_at: observedAt },
    shadow_only: true,
    promotion_state: "shadow",
  };
}

/**
 * Convert materialized graph inventory growth into bounded semantic-event candidates.
 * Only exact, typed additions are eligible; timestamps never participate in identity.
 */
export function buildOntologyDeltaCandidates({ previous = {}, current = {} } = {}) {
  const prior = priorInventory(previous);
  const present = currentInventory(current);
  const dimensions = [
    ["edge_type", prior.edge_types, present.edge_types],
    ["entity_type", prior.entity_types, present.entity_types],
  ];
  const events = [];
  for (const [dimension, before, after] of dimensions) {
    const known = new Set(before);
    for (const value of after) {
      if (known.has(value)) continue;
      events.push(semanticEvent(dimension, value, {
        previousAsOf: prior.as_of,
        observedAt: present.as_of,
      }));
    }
  }
  return events.slice(0, MAX_CANDIDATES);
}

export function buildDefaultOntologyDeltaCandidates() {
  return buildOntologyDeltaCandidates({
    previous: previousOntologyInventory,
    current: currentEntityIntelligence,
  });
}

function changes(result) {
  const value = result?.meta?.changes ?? result?.changes;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function digestReceipt(event, inserted) {
  const receipt = toDayLogEntry({
    kind: "semantic_event",
    watch: event.transition_key,
    lens: "ontology",
    queryLabel: `${event.dimension}:${event.value}`,
    found: 1,
    new: inserted ? 1 : 0,
    action: inserted ? "shadow_candidate" : "deduplicated",
    sent: false,
    dryRun: inserted,
    zeroMatch: false,
    error: null,
  });
  return {
    ...receipt,
    transition_key: event.transition_key,
    receipt_state: inserted ? "candidate" : "deduplicated",
  };
}

/**
 * Persist transition identity before exposing a candidate to the shadow summary.
 * INSERT OR IGNORE is the concurrency gate: only the winning insert is emitted.
 */
export async function reconcileOntologyDeltaCandidates(db, candidates = [], {
  observedAt = new Date().toISOString(),
} = {}) {
  if (!db?.prepare) throw new Error("ontology delta shadow reconciliation requires DB");
  const at = new Date(observedAt).toISOString();
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const key = token(candidate?.transition_key, 240);
    if (!key || seen.has(key) || candidate?.schema !== ONTOLOGY_DELTA_EVENT_SCHEMA) continue;
    seen.add(key);
    unique.push({ ...candidate, transition_key: key });
    if (unique.length >= MAX_CANDIDATES) break;
  }

  const emitted = [];
  const receipts = [];
  for (const event of unique) {
    const eventJson = JSON.stringify(event);
    const insert = await db.prepare(`INSERT OR IGNORE INTO ontology_delta_shadow_events
      (transition_key, event_type, dimension, value, first_observed_at, last_observed_at,
       observation_count, event_json)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(
        event.transition_key,
        event.event_type,
        event.dimension,
        event.value,
        at,
        at,
        eventJson,
      )
      .run();
    const inserted = changes(insert) > 0;
    if (inserted) {
      emitted.push(event);
    } else {
      await db.prepare(`UPDATE ontology_delta_shadow_events
        SET last_observed_at = ?, observation_count = observation_count + 1, event_json = ?
        WHERE transition_key = ?`)
        .bind(at, eventJson, event.transition_key)
        .run();
    }
    receipts.push(digestReceipt(event, inserted));
  }

  return {
    contract: ONTOLOGY_DELTA_SHADOW_CONTRACT,
    observed_at: at,
    candidate_count: unique.length,
    emitted_count: emitted.length,
    emitted,
    receipts,
  };
}
