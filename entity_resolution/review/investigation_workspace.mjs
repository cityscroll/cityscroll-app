// Desk-only composition of candidate evidence into an investigation case.
// Source records and publisher assertions stay independent; this model never
// chooses a canonical value or changes identity links.

export const INVESTIGATION_WORKSPACE_VERSION = "private_evidence_workspace_v1";

const clean = (value, fallback = "") => String(value ?? fallback).replace(/\s+/g, " ").trim();

function recordFromSide(side = {}) {
  const id = clean(side.id || side.source_record_id);
  if (!id) return null;
  return {
    id,
    name: clean(side.name || side.vendor_name),
    source: clean(side.source || side.source_system, "unknown"),
    source_record_key: clean(side.source_record_key || side.source_system_id),
    source_url: clean(side.source_url),
    observed_at: clean(side.observed_at || side.ingested_at),
    observed_fields: side.observed_fields && typeof side.observed_fields === "object"
      ? side.observed_fields
      : {},
  };
}

function itemRecordIds(item = {}) {
  return [recordFromSide(item.left), recordFromSide(item.right)]
    .filter(Boolean)
    .map((record) => record.id);
}

function connectedItems(selected, items) {
  const connected = new Set([selected.id]);
  const recordIds = new Set(itemRecordIds(selected));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (connected.has(item.id)) continue;
      const ids = itemRecordIds(item);
      if (!ids.some((id) => recordIds.has(id))) continue;
      connected.add(item.id);
      for (const id of ids) recordIds.add(id);
      changed = true;
    }
  }
  return items.filter((item) => connected.has(item.id));
}

function sourceRails(items) {
  const records = new Map();
  for (const item of items) {
    for (const side of [item.left, item.right]) {
      const record = recordFromSide(side);
      if (record && !records.has(record.id)) records.set(record.id, record);
    }
  }
  const bySource = new Map();
  for (const record of records.values()) {
    if (!bySource.has(record.source)) bySource.set(record.source, []);
    bySource.get(record.source).push(record);
  }
  return [...bySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, sourceRecords]) => ({
      source,
      records: sourceRecords.sort((left, right) => right.observed_at.localeCompare(left.observed_at)
        || left.id.localeCompare(right.id)),
    }));
}

function assertionKey(assertion = {}) {
  return [
    assertion.source_record_id,
    assertion.source_system,
    assertion.source_system_id,
    assertion.source_field,
    JSON.stringify(assertion.value),
  ].map(clean).join("::");
}

function assertionRails(items) {
  const rails = new Map();
  for (const item of items) {
    const conflicts = item.evidence?.assertion_interpretation?.conflicts || [];
    for (const conflict of conflicts) {
      const key = clean(conflict.fact);
      if (!key) continue;
      if (!rails.has(key)) rails.set(key, {
        fact: key,
        label: clean(conflict.label, key),
        kind: clean(conflict.kind),
        assertions: new Map(),
        interpretations: [],
      });
      const rail = rails.get(key);
      for (const assertion of conflict.assertions || []) {
        rail.assertions.set(assertionKey(assertion), assertion);
      }
      rail.interpretations.push({
        pair_id: item.id,
        ...conflict.interpretation,
      });
    }
  }
  return [...rails.values()].map((rail) => ({
    ...rail,
    assertions: [...rail.assertions.values()],
  }));
}

/**
 * Build a connected investigation case around one candidate pair. Candidate
 * components may contain more than two sources, but no records or assertions
 * are merged: every rail retains its publisher and snapshot identity.
 */
export function buildInvestigationWorkspace(selectedId, reviewItems = []) {
  const items = (Array.isArray(reviewItems) ? reviewItems : []).filter(Boolean);
  const selected = items.find((item) => item.id === selectedId);
  if (!selected) return null;
  const comparisons = connectedItems(selected, items);
  const sources = sourceRails(comparisons);
  return {
    version: INVESTIGATION_WORKSPACE_VERSION,
    id: selected.id,
    entity_type: selected.entity_type || "vendor",
    status: "investigation",
    scope: {
      candidate_pairs: comparisons.length,
      source_rails: sources.length,
      source_records: sources.reduce((sum, rail) => sum + rail.records.length, 0),
      note: "This case contains connected review leads only. It does not establish identity or select a canonical assertion.",
    },
    sources,
    assertions: assertionRails(comparisons),
    comparisons: comparisons.map((item) => ({
      id: item.id,
      method: item.method,
      matcher_version: item.matcher_version,
      confidence: item.confidence,
      record_ids: itemRecordIds(item),
      shared_keys: item.evidence?.shared_keys || [],
      comparison_features: item.evidence?.comparison_features || {},
    })),
  };
}
