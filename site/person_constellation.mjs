/**
 * Bounded constellation for a source-qualified generic Person.
 *
 * A person has no generic public route in the root slice. This adapter makes
 * the source alias and grounded cross-category relations visible in the same
 * local-constellation grammar used by other civic objects. Unsupported or
 * unverified destinations remain held text, never links.
 */

import { entityPivotRouteStatus } from "./edge_summary.mjs";
import { buildLocalConstellation } from "./local_constellation.mjs";

export const PERSON_CONSTELLATION_SCHEMA = "cityscroll.person_constellation.v1";
export const PERSON_CONSTELLATION_METHOD = "person_constellation_v1";

const RELATIONS = new Set(["member_of", "chairs", "staffed_by", "works_for", "same_person"]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function routeHref(value) {
  const href = clean(value, 2_000);
  return href && entityPivotRouteStatus(href).verified ? href : null;
}

function sourceAliasNeighbor(person) {
  const alias = person?.source_alias;
  if (!alias?.identity) return null;
  const href = routeHref(alias.compatibility_href);
  return {
    edge_type: "source_identity",
    relation_label: alias.source_kind ? `${alias.source_kind} source identity` : "Source identity",
    target_kind: alias.source_kind || "source-identity",
    target_id: alias.identity,
    target_name: alias.identity,
    href,
    state: href ? "matched" : "held",
    hold_reason: href ? null : "This source identity has no published generic-person route.",
    provenance: { source_identity: alias.identity },
  };
}

function relationNeighbor(edge) {
  const relation = clean(edge?.relation || edge?.edge_type, 80).toLowerCase();
  if (!RELATIONS.has(relation)) return null;
  const targetId = clean(edge?.target_ref || edge?.organization_ref || edge?.target_id, 500);
  if (!targetId) return null;
  const targetHref = routeHref(edge?.target_href || edge?.canonical_href || edge?.href);
  const state = edge?.status === "held" || edge?.status === "unknown" || !targetHref ? "held" : "matched";
  return {
    edge_type: relation,
    relation_label: clean(edge?.relation_label || edge?.role_label || relation.replaceAll("_", " "), 160),
    target_kind: clean(edge?.target_kind, 100) || "civic-object",
    target_id: targetId,
    target_name: clean(edge?.target_name || edge?.label || targetId, 500),
    href: state === "matched" ? targetHref : null,
    state,
    hold_reason: state === "held"
      ? (clean(edge?.hold_reason, 240) || "This relation has no verified published destination.")
      : null,
    provenance: edge?.provenance || null,
  };
}

export function buildPersonConstellation({ person = null, edges = [], source = null } = {}) {
  if (!person?.person_ref || person.object_type !== "person") return null;
  const neighbors = [sourceAliasNeighbor(person), ...(Array.isArray(edges) ? edges.map(relationNeighbor) : [])]
    .filter(Boolean);
  const local = buildLocalConstellation({
    kind: "person",
    subject_ref: person.person_ref,
    subject_id: person.person_ref,
    subject_name: person.display_name,
    source,
    provenance: { method: PERSON_CONSTELLATION_METHOD },
    neighbors,
  });
  return Object.freeze({
    schema: PERSON_CONSTELLATION_SCHEMA,
    method: PERSON_CONSTELLATION_METHOD,
    kind: "person-constellation",
    person_ref: person.person_ref,
    profile_family: person.profile_family,
    display_name: person.display_name,
    source_identity: person.source_alias?.identity || person.person_ref,
    canonical_person_ref: person.canonical_person_ref || null,
    edges: Object.freeze(neighbors),
    local_constellation: local,
  });
}
