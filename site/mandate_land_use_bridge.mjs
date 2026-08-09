/** Mandates → land-use/zoning cross-entity edges for agency constellations. */

import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { agencyObligationsFollowHref } from "./agency_obligations.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import {
  DEFAULT_CROSS_SPINE_EDGE_POLICY,
  routeCrossSpineEdge,
} from "../entity_resolution/cross_domain/edge_policy.mjs";
import {
  LAND_USE_PROCEDURE_KINDS,
  LAND_USE_PROCEDURE_VOCABULARY_VERSION,
  formatSubjectRef,
  makeSubjectLink,
  parseSubjectRef,
} from "../worker/src/lib/subject_registry.mjs";
import {
  buildEdgeProvenanceClaim,
  claimInspectHref,
  renderWhyBelieveControl,
} from "./graph_edge_provenance.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
import { mandateSubjectRef } from "./mandate_subject_ref.mjs";
import {
  emptyScope,
  normalizeScope,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";

export const MANDATE_LAND_USE_SCHEMA = "cityscroll.mandate_land_use.v1";
export const MANDATE_LAND_USE_METHOD = "mandate_land_use_identity_phase_v2";
export const MANDATE_LAND_USE_MATCHER_VERSION = "v2";
export const MANDATE_LAND_USE_EDGE_TYPE = "requires_land_use_action";
export const MANDATE_LAND_USE_MIN_PRECISION = 0.9;
export const MANDATE_GOVERNS_PROCEDURE = "mandate_governs_procedure";
export const PROJECT_PARTICIPATES_IN_PROCEDURE = "project_participates_in_procedure";
export const MANDATE_PROCEDURE_METHOD = "mandate_procedure_kind_exact_v1";
export const PROJECT_PROCEDURE_METHOD = "project_procedure_action_code_exact_v1";

const PROCEDURE_LABELS = Object.freeze({
  landmark_designation: "Landmark designation procedure",
  rezoning: "Rezoning procedure",
  ulurp: "Uniform Land Use Review Procedure",
  special_permit: "Special permit procedure",
  city_map_change: "City map change procedure",
  site_selection: "Site selection procedure",
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function stablePart(value) {
  return clean(value, 160).toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Structured civic-action classes explicitly required by a mandate. */
export function mandateLandUseKinds(mandate = {}) {
  const duty = clean(mandate.duty_text || mandate.label, 1000).toLowerCase();
  const kinds = new Set();
  if (!/\beffective date of (?:the|this) local law\b/i.test(duty)
    && /\b(?:designat(?:e|es|ed|ion)|calendar(?:ed|ing)?)\b[^.!?]{0,220}\b(?:interior |scenic )?landmarks?\b|\b(?:interior |scenic )?landmarks?\b[^.!?]{0,220}\bdesignat(?:e|es|ed|ion)\b/i.test(duty)) {
    kinds.add("landmark_designation");
  }
  if (/\b(?:rezone|rezoning|zoning map amendment|amend(?:ment)? of (?:the )?zoning map)\b/i.test(duty)) {
    kinds.add("rezoning");
  }
  if (/\b(?:ulurp|uniform land use review procedure)\b/i.test(duty)) kinds.add("ulurp");
  if (/\b(?:city map change|map change|demap(?:ping)?)\b/i.test(duty)) kinds.add("city_map_change");
  if (/\b(?:special permit|zoning permit)\b/i.test(duty)) kinds.add("special_permit");
  if (/\b(?:site selection|site acquisition)\b/i.test(duty)) kinds.add("site_selection");
  return [...kinds];
}

function landActionKinds(row = {}) {
  const codes = new Set(clean(row.actions, 160).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
  const kinds = new Set();
  if (codes.has("HI") || codes.has("LD")) kinds.add("landmark_designation");
  if (codes.has("ZM") || codes.has("ZR")) kinds.add("rezoning");
  if (codes.has("ZS")) kinds.add("special_permit");
  if (codes.has("MM")) kinds.add("city_map_change");
  if (codes.has("PS") || codes.has("PQ")) kinds.add("site_selection");
  if (clean(row.ulurp_non, 40).toUpperCase() === "ULURP") kinds.add("ulurp");
  return [...kinds];
}

const IDENTITY_FIELDS = Object.freeze([
  "project_id", "land_project_id", "project_ref", "subject_ref", "project_name",
  "place_id", "place", "place_name", "designated_place", "site", "address",
  "street_address", "bbl", "bbls", "ulurp_number", "ulurp_numbers",
]);

function identityValue(value) {
  return clean(value, 240)
    .toLowerCase()
    .replace(/^project:/, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,;|]+$/g, "")
    .trim();
}

function identityEntries(record = {}) {
  const entries = [];
  for (const field of IDENTITY_FIELDS) {
    const value = record?.[field];
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const normalized = identityValue(item);
      if (!normalized || normalized === "null" || normalized === "undefined") continue;
      entries.push({ field, value: normalized });
      // Opaque publisher identifiers can survive a display-name variation,
      // while ordinary title words never establish identity by themselves.
      for (const match of normalized.matchAll(/\b(?:lp|ulurp|bbl|pin|epin)[-\s:#]*[a-z0-9-]+\b/gi)) {
        entries.push({ field, value: `opaque:${identityValue(match[0])}` });
      }
    }
  }
  return entries;
}

/** Exact project/place identity; title similarity is deliberately excluded. */
export function projectPlaceIdentity(mandate = {}, action = {}) {
  const left = identityEntries(mandate);
  const right = identityEntries(action);
  const rightByValue = new Map(right.map((entry) => [entry.value, entry]));
  const shared = left
    .filter((entry) => rightByValue.has(entry.value))
    .map((entry) => ({ left_field: entry.field, right_field: rightByValue.get(entry.value).field, value: entry.value }));
  return {
    matched: shared.length > 0,
    matches: shared,
    mandate_fields: [...new Set(left.map((entry) => entry.field))],
    action_fields: [...new Set(right.map((entry) => entry.field))],
  };
}

/** Mandate phase is derived from the duty verb, not from its action kind. */
export function mandateLandUsePhases(mandate = {}) {
  const duty = clean(mandate.duty_text || mandate.label, 2_000).toLowerCase();
  const phases = new Set();
  if (/\bcalendar(?:ed|ing)?\b/.test(duty)) phases.add("calendar");
  if (/\bpublic hearing\b|\bhearing\b/.test(duty)) phases.add("public_hearing");
  if (/\bdesignat(?:e|es|ed|ion)\b/.test(duty)) phases.add("designation");
  if (/\bdisapprov(?:e|es|ed|al)\b/.test(duty)) phases.add("disposition");
  if (/\brezone|rezoning|zoning map amendment|uniform land use review procedure|\bulurp\b/.test(duty)) {
    phases.add("land_use_review");
  }
  if (/\bspecial permit|zoning permit\b/.test(duty)) phases.add("special_permit");
  if (/\bsite selection|site acquisition\b/.test(duty)) phases.add("site_selection");
  return [...phases];
}

/** Extract only explicit phase language from the ZAP milestone/status. */
export function landActionPhases(row = {}) {
  const text = clean([
    row.current_milestone,
    row.current_phase,
    row.phase,
    row.project_status,
    row.public_status,
  ].filter(Boolean).join(" "), 1_500).toLowerCase();
  const phases = new Set();
  if (/\bcalendar(?:ed|ing)?\b/.test(text)) phases.add("calendar");
  if (/\bhearing\b|public comment|community board|borough president|city planning commission|\bcpc\b|city council/.test(text)) {
    phases.add("public_hearing");
  }
  if (/\bdesignat(?:e|es|ed|ion)\b|\bdisapprov(?:e|es|ed|al)\b|landmark decision|project completed|approved/.test(text)) {
    phases.add("designation");
    phases.add("disposition");
  }
  if (/\brezone|rezoning|zoning map|ulurp|land use application|project readiness|pre-certif|certif/.test(text)) {
    phases.add("land_use_review");
  }
  if (/\bspecial permit|zoning permit\b/.test(text)) phases.add("special_permit");
  if (/\bsite selection|site acquisition\b/.test(text)) phases.add("site_selection");
  return [...phases];
}

export function mandateLandUsePhaseEvidence(mandate = {}, action = {}) {
  const mandatePhases = mandateLandUsePhases(mandate);
  const actionPhases = landActionPhases(action);
  const compatible = mandatePhases.some((phase) => actionPhases.includes(phase));
  return { compatible, mandate_phases: mandatePhases, action_phases: actionPhases };
}

function datePart(value) {
  const match = clean(value, 40).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function agencyMatches(identity, object, raw) {
  const candidates = [
    raw?.primary_applicant,
    object?.provenance?.input_value,
    String(object?.root_ref || "").replace(/^agency:id:/, ""),
  ];
  return candidates.some((value) => value
    && resolveAgencyIdentity(value)?.canonical_id === identity.canonical_id);
}

/**
 * Require the existing cross-domain agency→project edge, then enrich it with
 * structured ZAP action fields. Titles never establish a match.
 */
function landCandidates(entityIntelligence, landProjects, identity) {
  const rowsById = new Map((landProjects?.rows || [])
    .map((row) => [clean(row?.project_id, 80), row])
    .filter(([id]) => id));
  const candidates = new Map();
  for (const block of Object.values(entityIntelligence?.by_ref || {})) {
    for (const object of block?.domains?.land?.objects || []) {
      if (clean(object?.link_type, 80) !== "applicant_agency") continue;
      const projectId = clean(object.project_id || String(object.subject_ref || "").replace(/^project:/, ""), 80);
      const raw = rowsById.get(projectId);
      if (!projectId || !raw || !agencyMatches(identity, object, raw)) continue;
      const actionKinds = landActionKinds(raw);
      if (!actionKinds.length) continue;
      const objectHref = clean(object.href, 240);
      candidates.set(projectId, {
        project_id: projectId,
        subject_ref: clean(object.subject_ref, 120) || `project:${projectId}`,
        label: clean(raw.project_name || object.label, 320),
        href: objectHref
          ? (objectHref.startsWith("#") ? `/${objectHref}` : objectHref)
          : `/#land?project=${encodeURIComponent(projectId)}`,
        date: datePart(raw.current_milestone_date || object.when),
        public_status: clean(raw.public_status, 80) || null,
        action_codes: clean(raw.actions, 160),
        ulurp_non: clean(raw.ulurp_non, 40) || null,
        action_kinds: actionKinds,
        identity_record: Object.fromEntries(IDENTITY_FIELDS
          .filter((field) => raw[field] != null)
          .map((field) => [field, raw[field]])),
        phases: landActionPhases(raw),
        current_milestone: clean(raw.current_milestone, 180) || null,
        source_system: clean(object.provenance?.source_system, 120) || "Zoning Application Portal projects (Open Data)",
        source_record_id: clean(object.provenance?.source_record_id, 200) || `zap-projects:${projectId}`,
        source_fields: ["primary_applicant", "actions", "project_id"],
        agency_method: clean(object.method, 80) || "agency_canonical_v1",
      });
    }
  }
  return [...candidates.values()].sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
}

function publicationGate(source) {
  const row = source?.gate?.mandate_land_use
    || source?.gates?.mandate_land_use
    || source?.mandate_land_use
    || null;
  if (!row) {
    return {
      status: "pass",
      precision: null,
      min_precision: MANDATE_LAND_USE_MIN_PRECISION,
      passed: true,
      source: "committed_policy",
    };
  }
  const precision = Number(row.precision);
  const minPrecision = Number(row.min_precision ?? MANDATE_LAND_USE_MIN_PRECISION);
  const passed = (row.passed === true || row.status === "pass")
    && Number.isFinite(precision)
    && Number.isFinite(minPrecision)
    && precision >= MANDATE_LAND_USE_MIN_PRECISION
    && precision >= minPrecision;
  return {
    status: passed ? "pass" : (row.status === "fail" ? "fail" : "insufficient"),
    precision: Number.isFinite(precision) ? precision : null,
    min_precision: Number.isFinite(minPrecision) ? minPrecision : MANDATE_LAND_USE_MIN_PRECISION,
    passed,
    gold_version: clean(source?.gold_version || row.gold_version, 120) || null,
    eval_version: clean(source?.eval_version || row.eval_version, 120) || null,
  };
}

function crossSpinePolicy(gate) {
  return {
    ...DEFAULT_CROSS_SPINE_EDGE_POLICY,
    gates: {
      ...DEFAULT_CROSS_SPINE_EDGE_POLICY.gates,
      mandate_land_use: {
        status: gate.passed ? "pass" : (gate.status || "insufficient"),
        min_precision: gate.min_precision,
        precision: gate.precision,
      },
    },
  };
}

function procedureDescriptor(kind) {
  if (!LAND_USE_PROCEDURE_KINDS.includes(kind)) return null;
  const subjectRef = formatSubjectRef("procedure", kind);
  return subjectRef ? {
    kind,
    subject_ref: subjectRef,
    label: PROCEDURE_LABELS[kind],
    vocabulary_version: LAND_USE_PROCEDURE_VOCABULARY_VERSION,
  } : null;
}

function procedurePublicationGate(source, relation) {
  const supplied = Boolean(source && typeof source === "object");
  const row = source?.gate?.[relation]
    || source?.gates?.[relation]
    || source?.[relation]
    || null;
  if (!row) {
    return supplied
      ? {
        relation,
        status: "insufficient",
        precision: null,
        min_precision: MANDATE_LAND_USE_MIN_PRECISION,
        passed: false,
        source: "missing_relation_gate",
      }
      : {
        relation,
        status: "pass",
        precision: null,
        min_precision: MANDATE_LAND_USE_MIN_PRECISION,
        passed: true,
        source: "committed_policy",
      };
  }
  const precision = Number(row.precision);
  const minPrecision = Number(row.min_precision ?? MANDATE_LAND_USE_MIN_PRECISION);
  const passed = (row.passed === true || row.status === "pass")
    && Number.isFinite(precision)
    && Number.isFinite(minPrecision)
    && precision >= MANDATE_LAND_USE_MIN_PRECISION
    && precision >= minPrecision;
  return {
    relation,
    status: passed ? "pass" : (row.status === "fail" ? "fail" : "insufficient"),
    precision: Number.isFinite(precision) ? precision : null,
    min_precision: Number.isFinite(minPrecision) ? minPrecision : MANDATE_LAND_USE_MIN_PRECISION,
    passed,
    gold_version: clean(source?.gold_version || row.gold_version, 120) || null,
    eval_version: clean(source?.eval_version || row.eval_version, 120) || null,
  };
}

function procedureCrossSpinePolicy(gates) {
  return {
    ...DEFAULT_CROSS_SPINE_EDGE_POLICY,
    gates: {
      ...DEFAULT_CROSS_SPINE_EDGE_POLICY.gates,
      ...Object.fromEntries(Object.entries(gates).map(([relation, gate]) => [relation, {
        status: gate.passed ? "pass" : gate.status,
        min_precision: gate.min_precision,
        precision: gate.precision,
      }])),
    },
  };
}

function routedProcedureLink({
  type,
  from,
  procedure,
  method,
  features,
  evidence,
  provenance,
  policy,
  id,
  subject,
}) {
  const link = makeSubjectLink({
    type,
    from,
    to: procedure?.subject_ref,
    method,
    method_version: "1.0.0",
    evidence,
  });
  if (!link) return null;
  const route = routeCrossSpineEdge({
    relation: type,
    type,
    from: link.from,
    to: link.to,
    features,
    evidence,
    provenance,
  }, { policy });
  return {
    ...link,
    id,
    relation: type,
    procedure,
    public: route.public,
    decision: route.public ? "auto_link" : "evidence_only",
    confidence: route.public ? "strong" : "evidence_only",
    tier: route.tier,
    edge_policy: {
      tier: route.tier,
      reason: route.reason,
      policy_version: route.policy_version,
      evidence: route.evidence,
    },
    provenance,
    ...subject,
  };
}

/** Compose only on an exact procedure ref after both constituent edges are public. */
export function composePublicProcedurePaths(mandateEdges = [], projectEdges = []) {
  const projectsByProcedure = new Map();
  for (const edge of projectEdges) {
    if (edge?.type !== PROJECT_PARTICIPATES_IN_PROCEDURE || edge.public !== true) continue;
    if (parseSubjectRef(edge.to)?.kind !== "procedure") continue;
    if (!projectsByProcedure.has(edge.to)) projectsByProcedure.set(edge.to, []);
    projectsByProcedure.get(edge.to).push(edge);
  }
  const paths = [];
  for (const mandateEdge of mandateEdges) {
    if (mandateEdge?.type !== MANDATE_GOVERNS_PROCEDURE || mandateEdge.public !== true) continue;
    if (parseSubjectRef(mandateEdge.to)?.kind !== "procedure") continue;
    for (const projectEdge of projectsByProcedure.get(mandateEdge.to) || []) {
      paths.push({
        id: `procedure-path:${stablePart(mandateEdge.from)}:${stablePart(projectEdge.from)}:${stablePart(mandateEdge.to)}`,
        procedure: mandateEdge.procedure || projectEdge.procedure,
        mandate: mandateEdge.mandate,
        land_action: projectEdge.land_action,
        mandate_edge: mandateEdge,
        project_edge: projectEdge,
      });
    }
  }
  return paths;
}

export function agencyMandateLandUsePath(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  return identity?.canonical_id
    ? `/agencies/${encodeURIComponent(identity.canonical_id)}/#mandates-land-use`
    : "/agencies/";
}

export function agencyLandUseFollowHref(agencyIdOrName, { frequency = "weekly" } = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_name) return "/following/";
  return followingUrlFromWatch({
    lens: "land",
    filter: {
      agency: identity.canonical_name,
      entity_refs_all: [`agency:id:${identity.canonical_id}`],
    },
  }, { frequency });
}

export function agencyLandUseBrowseHref(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return "/browse/zoning/";
  let scope = emptyScope("en");
  scope.facets.agencies = [identity.canonical_name];
  scope = scopeWithEntity(scope, `agency:id:${identity.canonical_id}`);
  scope.facets.domains = ["land"];
  scope.facets.values.connection_relation = "applicant_agency";
  const hash = routeHashFromScope(normalizeScope(scope), { surface: "land" });
  const query = String(hash).includes("?") ? String(hash).split("?", 2)[1] : "";
  return canonicalizeBrowseUrl(`/browse/zoning/${query ? `?${query}` : ""}`);
}

export function buildMandateLandUseView(agencyIdOrName, sources = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return null;
  const mandates = (sources.obligationsLookup?.by_agency?.[identity.canonical_id]?.obligations || [])
    .filter((row) => row?.certification?.quote_verified !== false)
    .map((row) => ({ row, actionKinds: mandateLandUseKinds(row) }))
    .filter(({ actionKinds }) => actionKinds.length);
  const candidates = landCandidates(sources.entityIntelligence, sources.landProjects, identity);
  const gate = publicationGate(sources.crossSpineGate);
  const edgePolicy = crossSpinePolicy(gate);
  const procedureGates = {
    [MANDATE_GOVERNS_PROCEDURE]: procedurePublicationGate(
      sources.crossSpineGate,
      MANDATE_GOVERNS_PROCEDURE,
    ),
    [PROJECT_PARTICIPATES_IN_PROCEDURE]: procedurePublicationGate(
      sources.crossSpineGate,
      PROJECT_PARTICIPATES_IN_PROCEDURE,
    ),
  };
  const procedurePolicy = procedureCrossSpinePolicy(procedureGates);
  const runId = `resolution-run:mandate-land-use:${stablePart(identity.canonical_id)}:${stablePart(sources.generatedAt || sources.entityIntelligence?.generated_at || sources.landProjects?.materialized_at || "current")}`;
  const resolutionRun = Object.freeze({
    id: runId,
    method: MANDATE_LAND_USE_METHOD,
    matcher_version: MANDATE_LAND_USE_MATCHER_VERSION,
    entity_type: "mandate_land_use",
    scope_note: "agency+land_action_kind+project_place_identity+mandate_phase",
    publication_gate: gate,
    status: "complete",
  });
  const edges = [];
  const shadowEdges = [];
  const mandateProcedureEdges = [];
  const projectProcedureEdges = [];
  const procedureShadowEdges = [];
  const perMandateLimit = Math.max(1, Math.min(Number(sources.perMandateLimit) || 3, 8));

  for (const { row: mandate, actionKinds } of mandates) {
    const mandateRef = mandateSubjectRef(mandate.obligation_id);
    if (!mandateRef) continue;
    let matched = 0;
    for (const action of candidates) {
      const subjectScope = actionKinds.filter((kind) => action.action_kinds.includes(kind));
      if (!subjectScope.length) continue;
      const identityEvidence = projectPlaceIdentity(mandate, action.identity_record || action);
      const phaseEvidence = mandateLandUsePhaseEvidence(mandate, action);
      const evidence = {
        keys: ["agency", "land_action_kind", "project_identity", "mandate_phase_compatible"],
        agency_id: identity.canonical_id,
        land_action_kind: action.action_kinds,
        subject_scope: subjectScope,
        project_identity: identityEvidence.matched,
        project_identity_detail: identityEvidence,
        mandate_phase_compatible: phaseEvidence.compatible,
        mandate_phase_detail: phaseEvidence,
      };
      const route = routeCrossSpineEdge({
        relation: "mandate_land_use",
        features: {
          agency_exact: true,
          land_action_kind_match: subjectScope.length > 0,
          project_identity: identityEvidence.matched,
          mandate_phase_compatible: phaseEvidence.compatible,
        },
        evidence,
        provenance: {
          source_system: action.source_system,
          source_record_id: action.source_record_id,
        },
      }, { policy: edgePolicy });
      const publicCandidate = route.tier === "public_inferred";
      const missing = [];
      if (!identityEvidence.matched) missing.push("project_identity");
      if (!phaseEvidence.compatible) missing.push("mandate_phase_compatible");
      if (!gate.passed) missing.push("held_out_precision_gate");
      const linkId = `entity-link:mandate-land-use:${stablePart(mandate.obligation_id)}:${stablePart(action.project_id)}`;
      const entityLink = {
        id: linkId,
        source_record_id: mandateRef,
        canonical_entity_id: action.subject_ref,
        decision: publicCandidate ? "auto_link" : "evidence_only",
        confidence: publicCandidate ? 0.9 : null,
        tier: route.tier,
        tier_reason: route.reason,
        method: MANDATE_LAND_USE_METHOD,
        matcher_version: MANDATE_LAND_USE_MATCHER_VERSION,
        resolution_run_id: runId,
        review_status: publicCandidate ? "auto_inferred" : null,
        evidence,
      };
      const item = {
        id: `${mandate.obligation_id}:${action.project_id}`,
        subject_ref: action.subject_ref,
        root_ref: mandateRef,
        label: action.label,
        href: action.href,
        relation: MANDATE_LAND_USE_EDGE_TYPE,
        confidence: publicCandidate ? "strong" : "evidence_only",
        decision: publicCandidate ? entityLink.decision : "evidence_only",
        edge_policy: {
          tier: route.tier,
          reason: route.reason,
          policy_version: route.policy_version,
          evidence: route.evidence,
        },
        method: MANDATE_LAND_USE_METHOD,
        entity_link_id: linkId,
        resolution_run_id: runId,
        date: action.date,
        provenance: {
          source_system: action.source_system,
          source_record_id: action.source_record_id,
          source_fields: action.source_fields,
          input_value: `${identity.canonical_name} · ${action.action_codes}`,
          observed_at: action.date,
          basis: "agency+land_action_kind+project_place_identity+mandate_phase",
          source_excerpt: action.label,
        },
      };
      if (!publicCandidate) {
        shadowEdges.push({
          id: item.id,
          mandate: item.root_ref,
          land_action: action,
          match: evidence,
          entity_link: { ...entityLink, decision: "evidence_only", review_status: null },
          decision: "evidence_only",
          reason: missing.length ? missing : [route.reason],
        });
        continue;
      }
      const claimBase = buildEdgeProvenanceClaim(item, {
        category_id: "mandate-land-use",
        relation: MANDATE_LAND_USE_EDGE_TYPE,
        root_ref: item.root_ref,
        document_path: `/agencies/${encodeURIComponent(identity.canonical_id)}/`,
      });
      const inspectHref = claimInspectHref(
        `/agencies/${encodeURIComponent(identity.canonical_id)}/`,
        linkId,
      );
      const claim = claimBase ? {
        ...claimBase,
        claim_id: linkId,
        inspect_href: inspectHref,
        share_href: inspectHref,
      } : null;
      edges.push({
        relation: MANDATE_LAND_USE_EDGE_TYPE,
        mandate: {
          mandate_id: mandate.obligation_id,
          subject_ref: mandateRef,
          duty_text: clean(mandate.duty_text, 500),
          citation: clean(mandate.citation, 200) || null,
          source_href: clean(mandate.source?.legistar_url || mandate.href, 400) || null,
        },
        land_action: action,
        match: entityLink.evidence,
        entity_link: entityLink,
        resolution_run: resolutionRun,
        process_conformance: {
          expected_event: { kind: subjectScope[0], label: "Land-use or zoning action" },
          status: "observed",
          observed_record: action,
        },
        claim,
      });
      matched += 1;
      if (matched >= perMandateLimit) break;
    }
  }

  for (const { row: mandate, actionKinds } of mandates) {
    const mandateRef = mandateSubjectRef(mandate.obligation_id);
    if (!mandateRef) continue;
    for (const kind of actionKinds) {
      const procedure = procedureDescriptor(kind);
      if (!procedure) continue;
      const sourceFields = ["duty_text", "certification.quote_verified"];
      const evidence = {
        keys: ["mandate_quote_verified", "procedure_kind_exact", "procedure_vocabulary_member"],
        procedure_kind: kind,
        vocabulary_version: LAND_USE_PROCEDURE_VOCABULARY_VERSION,
        source_system: "enacted_local_law",
        source_record_id: mandateRef,
        source_fields: sourceFields,
        source_url: clean(mandate.source?.legistar_url || mandate.href, 400) || null,
      };
      const link = routedProcedureLink({
        type: MANDATE_GOVERNS_PROCEDURE,
        from: mandateRef,
        procedure,
        method: MANDATE_PROCEDURE_METHOD,
        features: {
          mandate_quote_verified: mandate.certification?.quote_verified === true,
          procedure_kind_exact: true,
          procedure_vocabulary_member: LAND_USE_PROCEDURE_KINDS.includes(kind),
        },
        evidence,
        provenance: {
          source_system: "enacted_local_law",
          source_record_id: mandateRef,
          source_fields: sourceFields,
          input_value: kind,
          basis: `closed_procedure_vocabulary:${LAND_USE_PROCEDURE_VOCABULARY_VERSION}`,
          source_excerpt: clean(mandate.duty_text, 500),
        },
        policy: procedurePolicy,
        id: `entity-link:mandate-procedure:${stablePart(mandate.obligation_id)}:${stablePart(kind)}`,
        subject: {
          mandate: {
            mandate_id: mandate.obligation_id,
            subject_ref: mandateRef,
            duty_text: clean(mandate.duty_text, 500),
            citation: clean(mandate.citation, 200) || null,
            source_href: clean(mandate.source?.legistar_url || mandate.href, 400) || null,
          },
        },
      });
      if (!link) continue;
      (link.public ? mandateProcedureEdges : procedureShadowEdges).push(link);
    }
  }

  for (const action of candidates) {
    for (const kind of action.action_kinds) {
      const procedure = procedureDescriptor(kind);
      if (!procedure) continue;
      const sourceFields = [
        "project_id",
        ...(action.action_codes ? ["actions"] : []),
        ...(kind === "ulurp" && action.ulurp_non ? ["ulurp_non"] : []),
      ];
      const projectSubject = parseSubjectRef(action.subject_ref);
      const evidence = {
        keys: ["project_subject_exact", "publisher_action_kind_exact", "procedure_vocabulary_member"],
        procedure_kind: kind,
        vocabulary_version: LAND_USE_PROCEDURE_VOCABULARY_VERSION,
        action_codes: action.action_codes,
        ulurp_non: action.ulurp_non,
        source_system: action.source_system,
        source_record_id: action.source_record_id,
        source_fields: sourceFields,
      };
      const link = routedProcedureLink({
        type: PROJECT_PARTICIPATES_IN_PROCEDURE,
        from: action.subject_ref,
        procedure,
        method: PROJECT_PROCEDURE_METHOD,
        features: {
          project_subject_exact: projectSubject?.kind === "project"
            && projectSubject.id === action.project_id,
          publisher_action_kind_exact: action.action_kinds.includes(kind),
          procedure_vocabulary_member: LAND_USE_PROCEDURE_KINDS.includes(kind),
        },
        evidence,
        provenance: {
          source_system: action.source_system,
          source_record_id: action.source_record_id,
          source_fields: sourceFields,
          input_value: `${action.action_codes}${action.ulurp_non ? ` · ${action.ulurp_non}` : ""}`,
          observed_at: action.date,
          basis: `publisher_action_code+closed_procedure_vocabulary:${LAND_USE_PROCEDURE_VOCABULARY_VERSION}`,
          source_excerpt: action.label,
        },
        policy: procedurePolicy,
        id: `entity-link:project-procedure:${stablePart(action.project_id)}:${stablePart(kind)}`,
        subject: { land_action: action },
      });
      if (!link) continue;
      (link.public ? projectProcedureEdges : procedureShadowEdges).push(link);
    }
  }

  const pathCounts = new Map();
  const procedurePaths = composePublicProcedurePaths(
    mandateProcedureEdges,
    projectProcedureEdges,
  ).filter((path) => {
    const key = `${path.mandate_edge.from}|${path.procedure.subject_ref}`;
    const count = pathCounts.get(key) || 0;
    if (count >= perMandateLimit) return false;
    pathCounts.set(key, count + 1);
    return true;
  }).map((path) => {
    const claimBase = buildEdgeProvenanceClaim({
      id: path.id,
      subject_ref: path.land_action.subject_ref,
      label: path.land_action.label,
      relation: "composed_land_use_procedure_path",
      confidence: "strong",
      decision: "auto_link",
      method: `${MANDATE_PROCEDURE_METHOD}+${PROJECT_PROCEDURE_METHOD}`,
      entity_link_id: `${path.mandate_edge.id}+${path.project_edge.id}`,
      resolution_run_id: runId,
      provenance: path.project_edge.provenance,
    }, {
      category_id: "mandate-land-use",
      relation: "composed_land_use_procedure_path",
      root_ref: path.mandate_edge.from,
      document_path: `/agencies/${encodeURIComponent(identity.canonical_id)}/`,
    });
    const claimId = `entity-link:procedure-path:${stablePart(path.mandate_edge.from)}:${stablePart(path.project_edge.from)}:${stablePart(path.procedure.kind)}`;
    const inspectHref = claimInspectHref(
      `/agencies/${encodeURIComponent(identity.canonical_id)}/`,
      claimId,
    );
    return {
      ...path,
      provenance: {
        mandate: path.mandate_edge.provenance,
        project: path.project_edge.provenance,
      },
      claim: claimBase ? {
        ...claimBase,
        claim_id: claimId,
        inspect_href: inspectHref,
        share_href: inspectHref,
      } : null,
    };
  });

  const matchedMandates = new Set([
    ...edges.map((edge) => edge.mandate.mandate_id),
    ...procedurePaths.map((path) => path.mandate.mandate_id),
  ]);
  const matchedActions = new Set([
    ...edges.map((edge) => edge.land_action.project_id),
    ...procedurePaths.map((path) => path.land_action.project_id),
  ]);
  return {
    schema: MANDATE_LAND_USE_SCHEMA,
    method: MANDATE_LAND_USE_METHOD,
    status: edges.length || procedurePaths.length ? "matched" : "empty",
    agency_id: identity.canonical_id,
    agency_name: identity.canonical_name,
    subject_ref: `agency:id:${identity.canonical_id}`,
    relation: MANDATE_LAND_USE_EDGE_TYPE,
    resolution_run: resolutionRun,
    counts: {
      mandates: matchedMandates.size,
      land_actions: matchedActions.size,
      edges: edges.length,
      shadow_edges: shadowEdges.length,
      procedures: new Set(procedurePaths.map((path) => path.procedure.subject_ref)).size,
      procedure_paths: procedurePaths.length,
    },
    edges,
    shadow_edges: shadowEdges,
    publication_gate: gate,
    mandate_procedure_edges: mandateProcedureEdges,
    project_procedure_edges: projectProcedureEdges,
    procedure_shadow_edges: procedureShadowEdges,
    procedure_paths: procedurePaths,
    procedure_publication_gates: procedureGates,
    share_path: agencyMandateLandUsePath(identity.canonical_id),
    land_browse_href: agencyLandUseBrowseHref(identity.canonical_id),
    mandates_follow_href: agencyObligationsFollowHref(identity.canonical_id),
    land_follow_href: agencyLandUseFollowHref(identity.canonical_id),
  };
}

export function renderMandateLandUseSection(view) {
  if (!view || view.status !== "matched"
      || (!view.procedure_paths?.length && !view.edges?.length)) return "";
  const procedureGroups = new Map();
  for (const path of view.procedure_paths || []) {
    const id = `${path.mandate.mandate_id}:${path.procedure.subject_ref}`;
    if (!procedureGroups.has(id)) {
      procedureGroups.set(id, {
        mandate: path.mandate,
        procedure: path.procedure,
        paths: [],
      });
    }
    procedureGroups.get(id).paths.push(path);
  }
  const procedureList = [...procedureGroups.values()].map(({ mandate, procedure, paths }) => {
    const source = mandate.source_href
      ? ` · ${officialSourceLink({ href: mandate.source_href, label: "Source law", className: "agency-source-link", escape: esc })}`
      : "";
    const projects = paths.map((path) => {
      const why = renderWhyBelieveControl(path.claim);
      // Source: https://data.cityofnewyork.us/resource/hgx4-8ukb.json (status and action-date fields).
      let meta = "Zoning Application Portal";
      if (path.land_action.public_status) meta += ` · ${path.land_action.public_status}`;
      if (path.land_action.date) meta += ` · ${path.land_action.date}`;
      return `<li class="node-record mandate-land-use-record" data-mandate-procedure-edge="${esc(path.mandate_edge.id)}" data-project-procedure-edge="${esc(path.project_edge.id)}" data-edge-claim-row="${esc(path.claim?.claim_id || path.id)}">
        <div class="node-record-main">${constellationLink({ href: path.land_action.href, label: path.land_action.label, className: "agency-edge-link", attributes: { "data-subject-ref": path.land_action.subject_ref }, escape: esc })}${why ? ` ${why}` : ""}</div>
        <span class="muted node-muted">${esc(meta)}</span>
      </li>`;
    }).join("");
    return `<li class="node-record mandate-land-use-mandate" data-mandate-id="${esc(mandate.mandate_id)}" data-subject-ref="${esc(procedure.subject_ref)}">
      <div class="node-record-main">${esc(mandate.duty_text)}</div>
      ${mandate.citation || source ? `<span class="muted node-muted">${esc(mandate.citation || "")}${source}</span>` : ""}
      <p class="node-record-main"><strong>${esc(procedure.label)}</strong></p>
      <p class="muted node-muted">Projects participating in this procedure</p>
      <ul class="node-record-list mandate-land-use-records">${projects}</ul>
    </li>`;
  }).join("");

  // Preserve the narrower direct edge reader for a valid legacy gate receipt;
  // composed procedure paths take precedence when both new edges are public.
  const directGroups = new Map();
  for (const edge of procedureList ? [] : (view.edges || [])) {
    const id = edge.mandate.mandate_id;
    if (!directGroups.has(id)) directGroups.set(id, { mandate: edge.mandate, edges: [] });
    directGroups.get(id).edges.push(edge);
  }
  const directList = [...directGroups.values()].map(({ mandate, edges }) => {
    const source = mandate.source_href
      ? ` · ${officialSourceLink({ href: mandate.source_href, label: "Source law", className: "agency-source-link", escape: esc })}`
      : "";
    const projects = edges.map((edge) => {
      const why = renderWhyBelieveControl(edge.claim);
      let meta = "Zoning Application Portal";
      if (edge.land_action.public_status) meta += ` · ${edge.land_action.public_status}`;
      if (edge.land_action.date) meta += ` · ${edge.land_action.date}`;
      return `<li class="node-record mandate-land-use-record" data-mandate-land-use-edge="${esc(edge.entity_link.id)}" data-edge-claim-row="${esc(edge.claim?.claim_id || edge.entity_link.id)}">
        <div class="node-record-main">${constellationLink({ href: edge.land_action.href, label: edge.land_action.label, className: "agency-edge-link", attributes: { "data-subject-ref": edge.land_action.subject_ref }, escape: esc })}${why ? ` ${why}` : ""}</div>
        <span class="muted node-muted">${esc(meta)}</span>
      </li>`;
    }).join("");
    return `<li class="node-record mandate-land-use-mandate" data-mandate-id="${esc(mandate.mandate_id)}">
      <div class="node-record-main">${esc(mandate.duty_text)}</div>
      ${mandate.citation || source ? `<span class="muted node-muted">${esc(mandate.citation || "")}${source}</span>` : ""}
      <ul class="node-record-list mandate-land-use-records">${projects}</ul>
    </li>`;
  }).join("");
  const list = procedureList || directList;
  const procedureIntro = procedureList
    ? `<p class="muted node-muted">The law and each project connect independently to the named procedure. This does not say the law names a particular project.</p>`
    : "";
  const actions = [
    `<a class="node-action civic-object-action" href="${esc(view.land_browse_href)}">Open land-use and zoning actions</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.mandates_follow_href)}">Watch mandates</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.land_follow_href)}">Follow land-use and zoning actions</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.share_path)}">Share this view</a>`,
  ].join("");
  return `<section id="mandates-land-use" class="node-section node-card civic-object-section mandate-land-use" data-agency-constellation-card="mandate-land-use" data-method="${esc(view.method)}" data-status="matched" data-export-class="object_members">
    <h2>Mandates · Land-use procedures <span class="muted node-muted">(${view.counts.mandates} mandate${view.counts.mandates === 1 ? "" : "s"} · ${view.counts.land_actions} project${view.counts.land_actions === 1 ? "" : "s"})</span></h2>
    ${procedureIntro}
    <ul class="node-record-list mandate-land-use-list">${list}</ul>
    <p class="node-inline-actions civic-object-inline-actions">${actions}</p>
  </section>`;
}
