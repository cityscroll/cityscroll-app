/** Mandates → land-use/zoning cross-entity edges for agency constellations. */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { agencyObligationsFollowHref } from "./agency_obligations.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
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
export const MANDATE_LAND_USE_METHOD = "mandate_land_use_multikey_exact_v1";
export const MANDATE_LAND_USE_MATCHER_VERSION = "v1";
export const MANDATE_LAND_USE_EDGE_TYPE = "requires_land_use_action";

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
        source_system: clean(object.provenance?.source_system, 120) || "Zoning Application Portal projects (Open Data)",
        source_record_id: clean(object.provenance?.source_record_id, 200) || `zap-projects:${projectId}`,
        source_fields: ["primary_applicant", "actions", "project_id"],
        agency_method: clean(object.method, 80) || "agency_canonical_v1",
      });
    }
  }
  return [...candidates.values()].sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
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
  const runId = `resolution-run:mandate-land-use:${stablePart(identity.canonical_id)}:${stablePart(sources.generatedAt || sources.entityIntelligence?.generated_at || sources.landProjects?.materialized_at || "current")}`;
  const resolutionRun = Object.freeze({
    id: runId,
    method: MANDATE_LAND_USE_METHOD,
    matcher_version: MANDATE_LAND_USE_MATCHER_VERSION,
    entity_type: "mandate_land_use",
    scope_note: "agency+land_action_kind+subject_scope",
    status: "complete",
  });
  const edges = [];
  const perMandateLimit = Math.max(1, Math.min(Number(sources.perMandateLimit) || 3, 8));

  for (const { row: mandate, actionKinds } of mandates) {
    let matched = 0;
    for (const action of candidates) {
      const subjectScope = actionKinds.filter((kind) => action.action_kinds.includes(kind));
      if (!subjectScope.length) continue;
      const linkId = `entity-link:mandate-land-use:${stablePart(mandate.obligation_id)}:${stablePart(action.project_id)}`;
      const entityLink = {
        id: linkId,
        source_record_id: `obligation:${mandate.obligation_id}`,
        canonical_entity_id: action.subject_ref,
        decision: "auto_link",
        confidence: 1,
        method: MANDATE_LAND_USE_METHOD,
        matcher_version: MANDATE_LAND_USE_MATCHER_VERSION,
        resolution_run_id: runId,
        review_status: "auto_exact",
        evidence: {
          keys: ["agency", "land_action_kind", "subject_scope"],
          agency_id: identity.canonical_id,
          land_action_kind: action.action_kinds,
          subject_scope: subjectScope,
        },
      };
      const item = {
        id: `${mandate.obligation_id}:${action.project_id}`,
        subject_ref: action.subject_ref,
        root_ref: `obligation:${mandate.obligation_id}`,
        label: action.label,
        href: action.href,
        relation: MANDATE_LAND_USE_EDGE_TYPE,
        confidence: "strong",
        decision: entityLink.decision,
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
          basis: "agency+land_action_kind+subject_scope",
          source_excerpt: action.label,
        },
      };
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
    counts: { mandates: matchedMandates.size, land_actions: matchedActions.size, edges: edges.length },
    edges,
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
      ? ` · <a href="${esc(mandate.source_href)}" rel="noopener">Source law</a>`
      : "";
    const actions = edges.map((edge) => {
      const why = renderWhyBelieveControl(edge.claim);
      // Source: https://data.cityofnewyork.us/resource/hgx4-8ukb.json (status and action-date fields).
      let meta = "Zoning Application Portal";
      if (edge.land_action.public_status) meta += ` · ${edge.land_action.public_status}`;
      if (edge.land_action.date) meta += ` · ${edge.land_action.date}`;
      return `<li class="node-record mandate-land-use-record" data-mandate-land-use-edge="${esc(edge.entity_link.id)}" data-edge-claim-row="${esc(edge.claim?.claim_id || edge.entity_link.id)}">
        <div class="node-record-main"><a data-subject-ref="${esc(edge.land_action.subject_ref)}" href="${esc(edge.land_action.href)}">${esc(edge.land_action.label)}</a>${why ? ` ${why}` : ""}</div>
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
