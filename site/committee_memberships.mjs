/** Exact-key City Council committee membership read model. */

import { renderEntityPivotLink } from "./edge_summary.mjs";

const clean = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const COMMITTEE_MEMBERSHIP_SOURCE = "aabe-yfm9";

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
      relation_label: "committee membership",
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
