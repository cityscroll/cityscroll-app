/** Exact-key City Council committee membership read model. */

import { renderEntityPivotLink } from "./edge_summary.mjs";
import { buildLocalConstellation, buildOfficialLocalConstellation, ensureLocalConstellationStylesheet, renderLocalConstellationHTML } from "./local_constellation.mjs";

export { buildLocalConstellation, buildOfficialLocalConstellation, ensureLocalConstellationStylesheet, renderLocalConstellationHTML } from "./local_constellation.mjs";

const clean = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const COMMITTEE_MEMBERSHIP_SOURCE = "aabe-yfm9";

/** Build one committee's bounded neighborhood from the published exact-key graph. */
export function buildCommitteeLocalConstellation(graph = {}, committeeId, people = {}) {
  const id = clean(committeeId).replace(/^committee:/, "");
  const node = (graph.nodes || []).find((candidate) => candidate?.id === `committee:${id}`);
  const edges = graph.publication === "published" && Array.isArray(graph.public_edges)
    ? graph.public_edges.filter((edge) => edge?.type === "member_of" && edge.to === `committee:${id}`)
    : [];
  return buildLocalConstellation({
    kind: "committee",
    subject_ref: `committee:${id}`,
    subject_id: id || null,
    subject_name: node?.name || null,
    source: node?.provenance?.source || null,
    provenance: node?.provenance || null,
    availability_state: graph.publication === "published" ? null : "unknown",
    neighbors: edges.map((edge) => {
      const personId = clean(edge.from).replace(/^official:/, "");
      const person = people.by_person_id?.[personId] || {};
      return {
        edge_type: "member_of",
        relation_label: edge.is_chair ? "chair membership" : "member of",
        target_kind: "official",
        target_id: personId || null,
        target_name: person.person_name || personId || null,
        href: personId ? `/officials/${encodeURIComponent(personId)}/` : null,
        state: personId ? "matched" : "unknown",
        provenance: edge.provenance || null,
      };
    }),
  });
}

export function renderCommitteeLocalConstellationHTML(graph, committeeId, people = {}) {
  const constellation = buildCommitteeLocalConstellation(graph, committeeId, people);
  return renderLocalConstellationHTML(constellation, {
    heading: constellation.subject_name ? `Committee members · ${constellation.subject_name}` : "Committee members",
    id: `committee-local-constellation-${clean(committeeId).replace(/[^A-Za-z0-9_-]/g, "-")}`,
  });
}

export function renderOfficialLocalConstellationHTML(officialView, committeeRows, id, name) {
  ensureLocalConstellationStylesheet();
  return renderLocalConstellationHTML(buildOfficialLocalConstellation(officialView, committeeRows, id, name), {
    heading: "Nearby official records",
    id: "official-local-constellation-heading",
  });
}

export function committeeMembershipsForId(lookup, personId) {
  const id = clean(personId).replace(/^official:/, "");
  const bag = lookup?.by_member_id?.[id];
  return bag && Array.isArray(bag.rows) ? bag.rows : [];
}

export function committeeReverseEdgesForId(graph, personId) {
  const id = clean(personId).replace(/^official:/, "");
  if (!id || graph?.publication !== "published") return [];
  return (Array.isArray(graph.public_reverse_edges) ? graph.public_reverse_edges : [])
    .filter((edge) => edge?.type === "has_member" && edge.to === `official:${id}`);
}

/** Turn only the canonical graph's exact forward edges into profile rows. */
export function committeeRowsFromGraph(graph, committeeView = {}) {
  if (committeeView?.state !== "matched") return [];
  const nodes = new Map((Array.isArray(graph?.nodes) ? graph.nodes : [])
    .filter((node) => node?.id)
    .map((node) => [node.id, node]));
  return (Array.isArray(committeeView.edges) ? committeeView.edges : []).map((edge) => {
    const committeeId = clean(edge?.to).replace(/^committee:/, "");
    const node = nodes.get(`committee:${committeeId}`);
    return {
      member_id: clean(edge?.from).replace(/^official:/, ""),
      committee_id: committeeId || null,
      committee: clean(node?.name) || committeeId || null,
      appointment_type: edge?.is_chair ? "Chair" : (clean(edge?.title) || "Membership"),
      start_date: clean(edge?.valid_from) || null,
      end_date: clean(edge?.valid_to) || null,
      href: null,
      edge_type: "member_of",
      relation_label: clean(edge?.relation_label) || "member of",
      provenance: edge?.provenance || null,
    };
  });
}

export function renderCommitteeMembershipsHTML(bag, { escapeHtml, translate } = {}) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
  const rows = Array.isArray(bag?.rows) ? bag.rows : [];
  if (!rows.length) return "";
  const reverseEdges = Array.isArray(bag?.reverse_edges) ? bag.reverse_edges : null;
  const reverseForRow = (row) => reverseEdges?.find((edge) =>
    edge.from === `committee:${clean(row.committee_id || row.id)}`
    && edge.to === `official:${clean(bag?.member_id).replace(/^official:/, "")}`
  ) || null;
  return `<section class="official-committee-memberships" data-membership-status="linked" data-entity-pivot-schema="cityscroll.edge_summary.v1">
    <div class="chain-h">Committee memberships</div>
    <ul>${rows.map((row) => {
      const reverseEdge = reverseForRow(row);
      const reverseUnavailable = reverseEdges && !reverseEdge
        ? `<span class="committee-membership-reverse-unavailable">Reverse coverage unavailable.</span>`
        : "";
      return `<li><strong>${renderEntityPivotLink({
      relation_label: row.relation_label || "committee membership",
      target_kind: "committee",
      target_id: row.committee_id || row.id || null,
      target_name: row.committee,
      canonical_href: row.href || null,
      source: { kind: null, id: bag?.member_id || null, name: bag?.person_name || null, canonical_href: null },
      provenance: reverseEdge?.provenance ?? row.provenance ?? null,
      inverse_of: reverseEdge?.inverse_of || null,
    }, { escape: esc })}</strong><br><span>${esc(row.appointment_type || "Membership")}${row.start_date ? ` · ${esc(row.start_date)}${row.end_date ? `–${esc(row.end_date)}` : ""}` : ""}</span>${reverseUnavailable}</li>`;
    }).join("")}</ul>
  </section>`;
}
