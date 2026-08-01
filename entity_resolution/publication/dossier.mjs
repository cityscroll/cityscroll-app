// Public entity dossier serializer.
//
// The database join is intentionally richer than this output. Every object below is
// rebuilt from an explicit allowlist so raw snapshots, immutable content hashes,
// matcher internals, and reviewer identity cannot cross the publication boundary.

import {
  ASSERTION_FACT_DEFINITIONS,
  assertionSnapshot,
  sourceAssertionForFact,
} from "../review/assertion_evidence.mjs";

export const PUBLIC_DOSSIER_VERSION = "public_entity_dossier_v1";

const IDENTITY_FACTS = [
  {
    fact: "name",
    label: "Name",
    kind: "text",
    aliases: ["vendor_name", "payee_name", "entity_name", "name"],
  },
  {
    fact: "agency",
    label: "Agency",
    kind: "text",
    aliases: ["agency_name", "contracting_agency", "agency"],
  },
  {
    fact: "pin",
    label: "PIN",
    kind: "text",
    aliases: ["pin", "pin_number", "procurement_identification_number"],
  },
  {
    fact: "epin",
    label: "EPIN",
    kind: "text",
    aliases: ["epin", "epin_number"],
  },
  {
    fact: "contract_id",
    label: "Contract ID",
    kind: "text",
    aliases: ["contract_id", "prime_contract_id", "contract_number"],
  },
];

export const PUBLIC_DOSSIER_FACT_DEFINITIONS = Object.freeze([
  ...IDENTITY_FACTS,
  ...ASSERTION_FACT_DEFINITIONS,
].map((definition) => Object.freeze({
  ...definition,
  aliases: Object.freeze([...definition.aliases]),
})));

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function safeUrl(value) {
  const candidate = clean(value);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function sourceUrlForObservation(row, raw) {
  const supplied = safeUrl(
    raw.source_url ?? raw.record_url ?? raw.url,
  );
  if (supplied) return supplied;
  if (clean(row.source_system) === "city_record" && clean(row.source_system_id)) {
    return `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(clean(row.source_system_id))}`;
  }
  return "";
}

function publicEntity(row) {
  const id = clean(row?.entity_id ?? row?.id);
  const type = clean(row?.entity_type ?? row?.type);
  const name = clean(row?.display_name ?? row?.name);
  return id && type && name ? { id, type, name } : null;
}

function sourceFromObservation(observation) {
  const system = clean(observation.source_system);
  const id = clean(observation.source_system_id);
  if (!system || !id) return null;
  const source = { system, id };
  const url = safeUrl(observation.source_url);
  if (url) source.url = url;
  return source;
}

function joinedObservations(rows) {
  const observations = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const sourceSystem = clean(row.source_system);
    const sourceSystemId = clean(row.source_system_id);
    const observedAt = clean(row.ingested_at);
    if (!sourceSystem || !sourceSystemId || !observedAt) continue;

    const internalKey = [sourceSystem, sourceSystemId, observedAt].join("\u0000");
    if (observations.has(internalKey)) continue;
    const rawSnapshot = assertionSnapshot(row.raw_snapshot);
    observations.set(internalKey, {
      source_system: sourceSystem,
      source_system_id: sourceSystemId,
      source_url: sourceUrlForObservation(row, rawSnapshot),
      raw_snapshot: rawSnapshot,
      ingested_at: observedAt,
    });
  }
  return [...observations.values()].sort((left, right) =>
    left.ingested_at.localeCompare(right.ingested_at)
      || left.source_system.localeCompare(right.source_system)
      || left.source_system_id.localeCompare(right.source_system_id));
}

function publicAssertion(observation, definition) {
  const sourceAssertion = sourceAssertionForFact(observation, definition);
  if (!sourceAssertion) return null;
  const source = sourceFromObservation(observation);
  if (!source) return null;
  const assertionId = [
    "assertion",
    source.system,
    source.id,
    definition.fact,
    observation.ingested_at,
  ].map((part) => encodeURIComponent(clean(part))).join(":");
  return {
    id: assertionId,
    classification: "source_assertion",
    value: sourceAssertion.value,
    provenance: {
      source,
      source_field: clean(sourceAssertion.source_field),
      observed_at: clean(observation.ingested_at),
    },
    derivation: {
      status: "observed",
      evidence_assertion_ids: [],
    },
    confidence: { status: "not_scored" },
    review: { status: "not_public" },
    _comparison_value: sourceAssertion._comparison_value,
  };
}

function withoutComparison(assertion) {
  const { _comparison_value: omitted, ...result } = assertion;
  return result;
}

function assertionGroups(observations) {
  return PUBLIC_DOSSIER_FACT_DEFINITIONS.map((definition) => {
    const assertions = observations
      .map((observation) => publicAssertion(observation, definition))
      .filter(Boolean);
    if (!assertions.length) {
      return {
        fact: definition.fact,
        label: definition.label,
        status: "not_observed",
        assertions: [],
        missingness: "Not observed in the source records linked to this dossier.",
      };
    }
    const distinctValues = new Set(assertions.map((assertion) =>
      JSON.stringify(assertion._comparison_value)));
    return {
      fact: definition.fact,
      label: definition.label,
      status: distinctValues.size > 1 ? "disagreement" : "observed",
      assertions: assertions.map(withoutComparison),
      ...(distinctValues.size > 1 ? {
        disagreement: "Linked sources report different values; this dossier does not select a winner.",
      } : {}),
    };
  });
}

function linkedRecords(entityId, observations) {
  return observations.map((observation) => {
    const source = sourceFromObservation(observation);
    return {
      entity_id: entityId,
      source,
      observed_at: observation.ingested_at,
    };
  }).filter((record) => record.source);
}

function derivedNameAssertion(entity, groups, observedAt) {
  const evidenceIds = groups
    .find((group) => group.fact === "name")
    ?.assertions.map((assertion) => assertion.id) || [];
  return {
    id: `${encodeURIComponent(entity.id)}:assertion:canonical_name`,
    fact: "canonical_name",
    label: "Dossier name",
    // Product-facing display name from linked name assertions — not a publisher field and
    // not a conflict interpretation (see docs/adr/evidence-assertion-layer.md).
    classification: "derived_conclusion",
    value: entity.name,
    provenance: {
      source: { system: "cityscroll", id: entity.id },
      observed_at: observedAt,
    },
    derivation: {
      status: evidenceIds.length ? "derived" : "unresolved",
      evidence_assertion_ids: evidenceIds,
    },
    confidence: { status: "not_published" },
    review: { status: "not_public" },
  };
}

/**
 * Convert joined canonical-entity/link/source rows to the complete public dossier.
 * Returns null when the canonical entity itself is absent or incomplete.
 */
export function serializePublicEntityDossier(rows = [], opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const entity = publicEntity(list[0]);
  if (!entity) return null;
  const observations = joinedObservations(list);
  const groups = assertionGroups(observations);
  const observedTimes = observations.map((observation) => observation.ingested_at).filter(Boolean);
  const observedFrom = observedTimes[0] || "";
  const observedThrough = observedTimes.at(-1) || "";
  const sources = [...new Set(observations.map((observation) => observation.source_system))].sort();
  const recordLimit = Math.max(0, Number(opts.recordLimit) || 0);
  const truncated = Boolean(opts.truncated);

  return {
    version: PUBLIC_DOSSIER_VERSION,
    entity,
    scope: {
      sources,
      observed_from: observedFrom,
      observed_through: observedThrough,
      completeness: "linked_records_only",
      record_limit: recordLimit || null,
      truncated,
      note: truncated
        ? `This dossier shows the newest ${recordLimit} linked records from the listed sources. Older linked records may exist; absence is not proof that no record exists.`
        : "This dossier is limited to the listed linked sources and observation period. Absence is not proof that no record exists.",
    },
    linked_records: linkedRecords(entity.id, observations),
    assertions: groups,
    derived_assertions: [derivedNameAssertion(entity, groups, observedThrough)],
  };
}
