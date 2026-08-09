/**
 * Reviewed topic normalization for mandate-to-rule and mandate-to-meeting
 * candidate generation. This is deliberately a small allowlist, not a stemmer
 * or general synonym graph. Final relation gates remain outside this module.
 */

export const TOPIC_NORMALIZATION_SCHEMA = "cityscroll.topic_normalization_registry.v1";
export const TOPIC_NORMALIZATION_VERSION = "topic_normalization_v1";

const ALLOWED_KINDS = new Set(["morphology", "official_acronym", "publisher_terminology"]);
const ALLOWED_CORPORA = new Set(["cross_spine_gold_v3", "cross_spine_shadow_census_v1"]);

export const TOPIC_NORMALIZATION_REGISTRY = Object.freeze({
  schema: TOPIC_NORMALIZATION_SCHEMA,
  version: TOPIC_NORMALIZATION_VERSION,
  relations: Object.freeze(["mandate_rule", "mandate_meeting"]),
  policy: Object.freeze({
    minimum_shared_tokens: 2,
    allowed_kinds: Object.freeze([...ALLOWED_KINDS]),
    // These strings are either overloaded abbreviations or generic civic
    // vocabulary. They are documented abstentions and can never be aliases.
    ambiguous_aliases: Object.freeze(["bid", "dep", "dot", "map", "rec"]),
    broad_civic_words: Object.freeze([
      "agency", "agenda", "city", "hearing", "meeting", "notice", "plan", "public", "rule",
    ]),
  }),
  mappings: Object.freeze([
    Object.freeze({
      id: "morphology-landmark-v1",
      kind: "morphology",
      canonical_tokens: Object.freeze(["landmark"]),
      aliases: Object.freeze(["landmark", "landmarks"]),
      evidence: Object.freeze([
        Object.freeze({
          corpus: "cross_spine_gold_v3",
          residual_id: "xsg-v2-meeting-001",
          relation: "mandate_meeting",
          examples: Object.freeze([
            "Hold a hearing for a landmark under consideration",
            "June 23, 2026 Landmarks public hearing agenda",
          ]),
          source_systems: Object.freeze(["nyc_legistar", "city_record"]),
        }),
        Object.freeze({
          corpus: "cross_spine_shadow_census_v1",
          residual_id: "mandate_meeting:matter_body_subject",
          relation: "mandate_meeting",
          examples: Object.freeze(["landmark", "landmarks"]),
          source_systems: Object.freeze(["nyc_legistar", "city_record"]),
        }),
      ]),
    }),
    Object.freeze({
      id: "morphology-inspection-v1",
      kind: "morphology",
      canonical_tokens: Object.freeze(["inspection"]),
      aliases: Object.freeze(["inspection", "inspections"]),
      evidence: Object.freeze([
        Object.freeze({
          corpus: "cross_spine_gold_v3",
          residual_id: "xsg-v2-rule-014",
          relation: "mandate_rule",
          examples: Object.freeze([
            "Establish structural-inspection threshold score by rule",
            "Proposed rule relating to incomplete inspections",
          ]),
          source_systems: Object.freeze(["nyc_legistar", "city_record"]),
        }),
      ]),
    }),
    Object.freeze({
      id: "official-acronym-commercial-waste-zone-v1",
      kind: "official_acronym",
      canonical_tokens: Object.freeze(["commercial", "waste", "zone"]),
      aliases: Object.freeze(["commercial waste zone", "commercial waste zones", "cwz", "cwzs"]),
      evidence: Object.freeze([
        Object.freeze({
          corpus: "cross_spine_gold_v3",
          residual_id: "xsg-v2-rule-001",
          relation: "mandate_rule",
          examples: Object.freeze([
            "Regulate commercial waste zones",
            "Proposed implementation dates for four commercial waste zones",
          ]),
          source_systems: Object.freeze(["nyc_legistar", "city_record"]),
        }),
        Object.freeze({
          corpus: "cross_spine_shadow_census_v1",
          residual_id: "city_record:20260708002",
          relation: "mandate_rule",
          examples: Object.freeze([
            "commercial waste zones",
            "DSNY Proposed Implementation Dates Regarding Brooklyn East, Manhattan Northeast, Queens West, and Manhattan West CWZs",
          ]),
          source_systems: Object.freeze(["nyc_legistar", "city_record"]),
        }),
      ]),
    }),
    Object.freeze({
      id: "publisher-terminology-landmark-designation-v1",
      kind: "publisher_terminology",
      canonical_tokens: Object.freeze(["landmark", "designation"]),
      aliases: Object.freeze([
        "landmark designation",
        "landmarks designation",
        "landmark under consideration",
        "landmarks under consideration",
      ]),
      evidence: Object.freeze([
        Object.freeze({
          corpus: "cross_spine_gold_v3",
          residual_id: "xsg-v2-meeting-001",
          relation: "mandate_meeting",
          examples: Object.freeze([
            "Hold a hearing for a landmark under consideration",
            "landmark designation",
          ]),
          source_systems: Object.freeze(["nyc_legistar", "city_record"]),
        }),
        Object.freeze({
          corpus: "cross_spine_shadow_census_v1",
          residual_id: "mandate_meeting:matter_body_subject",
          relation: "mandate_meeting",
          examples: Object.freeze(["landmark under consideration", "landmark designation"]),
          source_systems: Object.freeze(["nyc_legistar", "city_record"]),
        }),
      ]),
    }),
  ]),
  review_cases: Object.freeze([
    Object.freeze({
      id: "topic-review-rule-cwzs",
      relation: "mandate_rule",
      split: "held_out",
      label: "same",
      left: "Regulate commercial waste zones",
      right: "DSNY Proposed Implementation Dates for Manhattan West CWZs",
      source_systems: Object.freeze(["nyc_legistar", "city_record"]),
    }),
    Object.freeze({
      id: "topic-review-rule-inspections",
      relation: "mandate_rule",
      split: "held_out",
      label: "same",
      left: "Establish structural inspection thresholds",
      right: "Structural inspections threshold amendments",
      source_systems: Object.freeze(["nyc_legistar", "city_record"]),
    }),
    Object.freeze({
      id: "topic-review-rule-ambiguous-rec",
      relation: "mandate_rule",
      split: "held_out",
      label: "different",
      left: "REC plan for buildings",
      right: "Records retention rule for buildings",
      source_systems: Object.freeze(["nyc_legistar", "city_record"]),
    }),
    Object.freeze({
      id: "topic-review-rule-broad-civic-words",
      relation: "mandate_rule",
      split: "held_out",
      label: "different",
      left: "City agency public rule plan",
      right: "Public city notice and plan",
      source_systems: Object.freeze(["nyc_legistar", "city_record"]),
    }),
    Object.freeze({
      id: "topic-review-meeting-landmark-designation",
      relation: "mandate_meeting",
      split: "held_out",
      label: "same",
      left: "Hold a hearing for a landmark under consideration",
      right: "Landmarks designation hearing",
      source_systems: Object.freeze(["nyc_legistar", "city_record"]),
    }),
    Object.freeze({
      id: "topic-review-meeting-ambiguous-lpc",
      relation: "mandate_meeting",
      split: "held_out",
      label: "different",
      left: "LPC public hearing agenda",
      right: "Landmark public meeting",
      source_systems: Object.freeze(["nyc_legistar", "city_record"]),
    }),
    Object.freeze({
      id: "topic-review-meeting-ambiguous-dot",
      relation: "mandate_meeting",
      split: "held_out",
      label: "different",
      left: "DOT map public hearing",
      right: "dot plan public meeting",
      source_systems: Object.freeze(["nyc_legistar", "city_record"]),
    }),
    Object.freeze({
      id: "topic-review-meeting-broad-civic-words",
      relation: "mandate_meeting",
      split: "held_out",
      label: "different",
      left: "Public hearing notice",
      right: "City meeting agenda",
      source_systems: Object.freeze(["nyc_legistar", "city_record"]),
    }),
  ]),
});

function surfaceText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function surfaceContains(surface, alias) {
  return (` ${surface} `).includes(` ${alias} `);
}

function aliasTokens(alias) {
  return alias.split(" ").filter(Boolean);
}

/** Validate registry provenance and the narrow allowlist contract. */
export function validateTopicNormalizationRegistry(registry = TOPIC_NORMALIZATION_REGISTRY) {
  if (registry?.schema !== TOPIC_NORMALIZATION_SCHEMA || registry?.version !== TOPIC_NORMALIZATION_VERSION) {
    throw new TypeError("topic normalization registry schema/version mismatch");
  }
  const ambiguous = new Set(registry.policy?.ambiguous_aliases || []);
  const broad = new Set(registry.policy?.broad_civic_words || []);
  const ids = new Set();
  for (const mapping of registry.mappings || []) {
    if (!mapping?.id || ids.has(mapping.id)) throw new TypeError("topic normalization mapping ids must be unique");
    ids.add(mapping.id);
    if (!ALLOWED_KINDS.has(mapping.kind)) throw new TypeError(`${mapping.id}: unsupported mapping kind`);
    if (!mapping.canonical_tokens?.length || !mapping.aliases?.length) throw new TypeError(`${mapping.id}: canonical tokens and aliases are required`);
    if (mapping.aliases.some((alias) => ambiguous.has(surfaceText(alias)))) {
      throw new TypeError(`${mapping.id}: ambiguous aliases must abstain`);
    }
    if (mapping.aliases.some((alias) => broad.has(surfaceText(alias)))
      || mapping.canonical_tokens.some((token) => broad.has(surfaceText(token)))) {
      throw new TypeError(`${mapping.id}: broad civic words must abstain`);
    }
    if (!mapping.evidence?.length) throw new TypeError(`${mapping.id}: residual evidence is required`);
    for (const evidence of mapping.evidence) {
      if (!ALLOWED_CORPORA.has(evidence.corpus)) throw new TypeError(`${mapping.id}: evidence must come from reviewed gold/shadow residuals`);
      if (!evidence.residual_id || evidence.examples?.length < 2 || evidence.source_systems?.length < 2) {
        throw new TypeError(`${mapping.id}: residual id, paired examples, and source systems are required`);
      }
    }
  }
  return { ok: true, mappings: ids.size, version: registry.version };
}

/**
 * Canonicalize pre-filtered evidence tokens through reviewed mappings.
 * Matched alias tokens are replaced, not merely augmented, so one plural
 * concept cannot satisfy the two-token gate by counting twice.
 */
export function normalizeTopicEvidence(text, tokens = [], registry = TOPIC_NORMALIZATION_REGISTRY) {
  const surface = surfaceText([text, ...tokens].filter(Boolean).join(" "));
  const normalized = new Set(tokens.map(surfaceText).filter(Boolean));
  const applied = [];
  for (const mapping of registry.mappings) {
    const matchedAliases = mapping.aliases
      .map(surfaceText)
      .filter((alias) => surfaceContains(surface, alias));
    if (!matchedAliases.length) continue;
    for (const alias of matchedAliases) {
      for (const token of aliasTokens(alias)) normalized.delete(token);
    }
    for (const token of mapping.canonical_tokens) normalized.add(token);
    applied.push({
      id: mapping.id,
      kind: mapping.kind,
      matched_aliases: [...new Set(matchedAliases)],
      canonical_tokens: [...mapping.canonical_tokens],
    });
  }
  return {
    tokens: [...normalized],
    applied,
    registry_version: registry.version,
  };
}

validateTopicNormalizationRegistry();
