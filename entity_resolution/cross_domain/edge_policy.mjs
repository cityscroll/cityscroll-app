/**
 * Automatic cross-spine edge policy.
 *
 * A candidate is routed exactly once. Exact publisher-key joins are
 * deterministic; relation candidates are public only after their frozen
 * held-out relation gate passes; uncertain candidates stay in shadow storage.
 * This module has no review queue or human-action output.
 */

export const CROSS_SPINE_EDGE_POLICY_SCHEMA = "cityscroll.cross_spine_edge_policy.v1";
export const CROSS_SPINE_EDGE_POLICY_VERSION = "cross_spine_edge_policy_v1";
export const CROSS_SPINE_MIN_HELD_OUT_PRECISION = 0.90;

export const CROSS_SPINE_EDGE_TIERS = Object.freeze([
  "deterministic",
  "public_inferred",
  "evidence_only",
  "no_edge",
]);

export const CROSS_SPINE_RELATION_POLICIES = Object.freeze({
  mandate_contract: Object.freeze({
    required: [
      "agency_exact",
      "procurement_trigger",
      "procurement_action_exact",
      "subject_scope_overlap",
      "contract_authority_exact",
    ],
    minimumOverlap: { subject_scope_overlap: 1 },
  }),
  mandate_rule: Object.freeze({
    required: [
      "agency_exact",
      "expected_event_match",
      "topic_overlap",
      "rule_body_overlap",
      "citation_law_match",
      "temporal_compatible",
      "negative_evidence_free",
    ],
    minimumOverlap: { topic_overlap: 2 },
  }),
  mandate_meeting: Object.freeze({
    required: ["agency_exact", "event_kind_match", "subject_scope_overlap", "temporal_compatible"],
    minimumOverlap: { subject_scope_overlap: 2 },
  }),
  mandate_land_use: Object.freeze({
    required: ["agency_exact", "land_action_kind_match", "project_identity", "mandate_phase_compatible"],
    minimumOverlap: {},
  }),
});

const RELATION_ALIASES = Object.freeze({
  mandate_land: "mandate_land_use",
  mandate_land_action: "mandate_land_use",
});

/**
 * The committed operating point. `tools/cross_spine_eval.mjs --check-policy`
 * verifies these relation gates against the immutable held-out gold set.
 */
export const DEFAULT_CROSS_SPINE_EDGE_POLICY = Object.freeze({
  schema: CROSS_SPINE_EDGE_POLICY_SCHEMA,
  version: CROSS_SPINE_EDGE_POLICY_VERSION,
  min_held_out_precision: CROSS_SPINE_MIN_HELD_OUT_PRECISION,
  eval_version: "cross_spine_eval_v1",
  gold_version: "cross_spine_gold_v1",
  gates: Object.freeze({
    mandate_contract: Object.freeze({ status: "pass", min_precision: CROSS_SPINE_MIN_HELD_OUT_PRECISION }),
    mandate_rule: Object.freeze({ status: "pass", min_precision: CROSS_SPINE_MIN_HELD_OUT_PRECISION }),
    mandate_meeting: Object.freeze({ status: "pass", min_precision: CROSS_SPINE_MIN_HELD_OUT_PRECISION }),
    mandate_land_use: Object.freeze({ status: "pass", min_precision: CROSS_SPINE_MIN_HELD_OUT_PRECISION }),
  }),
});

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function canonicalCrossSpineRelation(value) {
  const relation = clean(value).toLowerCase();
  return RELATION_ALIASES[relation] || relation;
}

function valueForFeature(features, key) {
  if (Object.prototype.hasOwnProperty.call(features, key)) return features[key];
  if (key === "subject_scope_overlap" && Object.hasOwn(features, "subject_scope_keys")) {
    return features.subject_scope_keys;
  }
  if (key === "topic_overlap" && Object.hasOwn(features, "topic_keys")) return features.topic_keys;
  return undefined;
}

export function crossSpineFeaturePasses(features = {}, key, minimum = 1) {
  const value = valueForFeature(features, key);
  if (Array.isArray(value)) return value.length >= minimum;
  if (typeof value === "number") return value >= minimum;
  return value === true || value === "true" || value === "exact" || value === "compatible";
}

export function crossSpineRowFeatures(row = {}) {
  return {
    ...(row.features && typeof row.features === "object" ? row.features : {}),
    ...(row.evidence?.features && typeof row.evidence.features === "object" ? row.evidence.features : {}),
    ...(row.evidence && typeof row.evidence === "object" ? row.evidence : {}),
  };
}

/** Return the relation-specific evidence result without consulting a label. */
export function crossSpineEvidenceDecision(row = {}, relation = row.relation) {
  const canonical = canonicalCrossSpineRelation(relation);
  const policy = CROSS_SPINE_RELATION_POLICIES[canonical];
  if (!policy) return { relation: canonical, candidate: false, reason: "unknown_relation" };
  const features = crossSpineRowFeatures(row);
  const missing = policy.required.filter((key) => !crossSpineFeaturePasses(
    features,
    key,
    policy.minimumOverlap[key],
  ));
  return {
    relation: canonical,
    candidate: missing.length === 0,
    required: [...policy.required],
    missing,
    reason: missing.length ? "insufficient_relation_evidence" : "relation_evidence_satisfied",
  };
}

function hasExactKey(edge) {
  const provenance = edge.provenance && typeof edge.provenance === "object" ? edge.provenance : {};
  const tier = clean(edge.tier || provenance.tier).toLowerCase();
  if (["deterministic", "deterministic_exact_key"].includes(tier)) return true;
  const match = clean(edge.match || provenance.match).toLowerCase();
  const key = clean(edge.join_key || provenance.join_key || edge.exact_key || provenance.exact_key);
  const value = clean(edge.join_value || provenance.join_value);
  return match === "exact" && Boolean(key && value);
}

function hasHardConflict(edge) {
  const features = crossSpineRowFeatures(edge);
  return [
    features.hard_id_conflict,
    features.conflict,
    features.contradiction,
    features.different,
  ].some((value) => value === true || value === "true" || value === "conflict")
    || ["different", "no_edge", "conflict"].includes(clean(edge.decision).toLowerCase());
}

function hasEvidence(edge) {
  const features = crossSpineRowFeatures(edge);
  return Object.keys(features).length > 0
    || Boolean(edge.evidence)
    || Boolean(edge.provenance);
}

function gateFor(policy, relation) {
  return policy?.gates?.[relation] || null;
}

function publicRoute(edge, tier, reason, extra = {}) {
  return {
    schema: CROSS_SPINE_EDGE_POLICY_SCHEMA,
    policy_version: CROSS_SPINE_EDGE_POLICY_VERSION,
    tier,
    decision: tier,
    public: tier === "deterministic" || tier === "public_inferred",
    reason,
    relation: canonicalCrossSpineRelation(edge?.relation || edge?.cross_spine_relation),
    edge: edge || null,
    ...extra,
  };
}

/**
 * Route one candidate to exactly one policy tier.
 *
 * `evidence_only` contains the original candidate as shadow evidence but never
 * returns it as a public edge. `no_edge` is reserved for malformed, unknown,
 * or contradictory candidates; neither tier creates review work.
 */
export function routeCrossSpineEdge(edge, { policy = DEFAULT_CROSS_SPINE_EDGE_POLICY } = {}) {
  if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
    return publicRoute(edge, "no_edge", "invalid_candidate");
  }
  if (hasExactKey(edge)) return publicRoute(edge, "deterministic", "exact_publisher_key");
  if (hasHardConflict(edge)) return publicRoute(edge, "no_edge", "hard_conflict");

  const relation = canonicalCrossSpineRelation(edge.relation || edge.cross_spine_relation);
  const relationPolicy = CROSS_SPINE_RELATION_POLICIES[relation];
  if (!relationPolicy) return publicRoute(edge, "no_edge", "unknown_relation");

  const evidence = crossSpineEvidenceDecision(edge, relation);
  const gate = gateFor(policy, relation);
  if (gate?.status === "pass" && Number(gate.min_precision ?? policy.min_held_out_precision) >= CROSS_SPINE_MIN_HELD_OUT_PRECISION && evidence.candidate) {
    return publicRoute(edge, "public_inferred", "held_out_precision_gate_passed", {
      gate: { relation, min_precision: Number(gate.min_precision ?? policy.min_held_out_precision) },
      evidence,
    });
  }
  if (hasEvidence(edge)) {
    return publicRoute(edge, "evidence_only", evidence.reason, {
      gate: gate ? { relation, status: gate.status, min_precision: Number(gate.min_precision ?? policy.min_held_out_precision) } : null,
      evidence,
      shadow: {
        relation,
        policy_version: CROSS_SPINE_EDGE_POLICY_VERSION,
        candidate: edge,
      },
    });
  }
  return publicRoute(edge, "no_edge", evidence.reason);
}

/** Route a batch and expose only public edges in `public_edges`. */
export function routeCrossSpineEdges(edges = [], options = {}) {
  const routes = (Array.isArray(edges) ? edges : []).map((edge) => routeCrossSpineEdge(edge, options));
  const counts = Object.fromEntries(CROSS_SPINE_EDGE_TIERS.map((tier) => [tier, 0]));
  for (const route of routes) counts[route.tier] += 1;
  return {
    schema: CROSS_SPINE_EDGE_POLICY_SCHEMA,
    policy_version: CROSS_SPINE_EDGE_POLICY_VERSION,
    routes,
    public_edges: routes
      .filter((route) => route.public)
      .map((route) => ({
        ...route.edge,
        tier: route.tier,
        tier_version: CROSS_SPINE_EDGE_POLICY_VERSION,
      })),
    shadow_edges: routes
      .filter((route) => route.tier === "evidence_only")
      .map((route) => route.shadow),
    no_edge: routes
      .filter((route) => route.tier === "no_edge")
      .map((route) => route.edge),
    counts,
  };
}

/** Build a runtime policy from a checked evaluator receipt. */
export function policyFromCrossSpineEval(report) {
  if (!report || typeof report !== "object" || !report.gate) return null;
  const gates = {};
  for (const relation of Object.keys(CROSS_SPINE_RELATION_POLICIES)) {
    const gate = report.gate[relation];
    if (!gate) return null;
    gates[relation] = Object.freeze({
      status: gate.status,
      min_precision: Number(gate.min_precision),
      precision: Number(gate.precision),
    });
  }
  return Object.freeze({
    schema: CROSS_SPINE_EDGE_POLICY_SCHEMA,
    version: CROSS_SPINE_EDGE_POLICY_VERSION,
    min_held_out_precision: CROSS_SPINE_MIN_HELD_OUT_PRECISION,
    eval_version: clean(report.eval_version),
    gold_version: clean(report.gold_version),
    gates: Object.freeze(gates),
  });
}

export function checkCrossSpineEdgePolicy(report) {
  const policy = policyFromCrossSpineEval(report);
  if (!policy) return { ok: false, reason: "invalid_eval_report", policy: null };
  const failures = Object.entries(policy.gates)
    .filter(([, gate]) => gate.status !== "pass"
      || !Number.isFinite(gate.precision)
      || gate.precision < CROSS_SPINE_MIN_HELD_OUT_PRECISION)
    .map(([relation]) => relation);
  return { ok: failures.length === 0, failures, policy };
}

export const isCrossSpineCandidate = (edge = {}) => Boolean(
  edge?.cross_spine === true
    || edge?.relation
    || edge?.cross_spine_relation
    || clean(edge?.tier || edge?.provenance?.tier).toLowerCase() === "deterministic_exact_key",
);
