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
  buildEdgeProvenanceClaim,
  claimInspectHref,
  renderWhyBelieveControl,
} from "./graph_edge_provenance.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
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
  const perMandateLimit = Math.max(1, Math.min(Number(sources.perMandateLimit) || 3, 8));

  for (const { row: mandate, actionKinds } of mandates) {
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
        source_record_id: `obligation:${mandate.obligation_id}`,
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
        root_ref: `obligation:${mandate.obligation_id}`,
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
          subject_ref: `obligation:${mandate.obligation_id}`,
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

  const matchedMandates = new Set(edges.map((edge) => edge.mandate.mandate_id));
  const matchedActions = new Set(edges.map((edge) => edge.land_action.project_id));
  return {
    schema: MANDATE_LAND_USE_SCHEMA,
    method: MANDATE_LAND_USE_METHOD,
    status: edges.length ? "matched" : "empty",
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
    },
    edges,
    shadow_edges: shadowEdges,
    publication_gate: gate,
    share_path: agencyMandateLandUsePath(identity.canonical_id),
    land_browse_href: agencyLandUseBrowseHref(identity.canonical_id),
    mandates_follow_href: agencyObligationsFollowHref(identity.canonical_id),
    land_follow_href: agencyLandUseFollowHref(identity.canonical_id),
  };
}

export function renderMandateLandUseSection(view) {
  if (!view || view.status !== "matched" || !view.edges?.length) return "";
  const groups = new Map();
  for (const edge of view.edges) {
    const id = edge.mandate.mandate_id;
    if (!groups.has(id)) groups.set(id, { mandate: edge.mandate, edges: [] });
    groups.get(id).edges.push(edge);
  }
  const list = [...groups.values()].map(({ mandate, edges }) => {
    const source = mandate.source_href
      ? ` · ${officialSourceLink({ href: mandate.source_href, label: "Source law", className: "agency-source-link", escape: esc })}`
      : "";
    const actions = edges.map((edge) => {
      const why = renderWhyBelieveControl(edge.claim);
      // Source: https://data.cityofnewyork.us/resource/hgx4-8ukb.json (status and action-date fields).
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
      <ul class="node-record-list mandate-land-use-records">${actions}</ul>
    </li>`;
  }).join("");
  const actions = [
    `<a class="node-action civic-object-action" href="${esc(view.land_browse_href)}">Open land-use and zoning actions</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.mandates_follow_href)}">Watch mandates</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.land_follow_href)}">Follow land-use and zoning actions</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.share_path)}">Share this view</a>`,
  ].join("");
  return `<section id="mandates-land-use" class="node-section node-card civic-object-section mandate-land-use" data-agency-constellation-card="mandate-land-use" data-method="${esc(view.method)}" data-status="matched" data-export-class="object_members">
    <h2>Mandates · Land-use and zoning actions <span class="muted node-muted">(${view.counts.mandates} mandate${view.counts.mandates === 1 ? "" : "s"} · ${view.counts.land_actions} action${view.counts.land_actions === 1 ? "" : "s"})</span></h2>
    <ul class="node-record-list mandate-land-use-list">${list}</ul>
    <p class="node-inline-actions civic-object-inline-actions">${actions}</p>
  </section>`;
}
