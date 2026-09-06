/**
 * "What this institution actually did" — the capacity-labelled record list.
 *
 * A profile's ordinary categories answer "which records name this agency".
 * That is not enough to act on: a body can be named on a contract because it
 * awarded it or because it received it, and those lead to different
 * decision-makers. This section states the capacity in plain language beside
 * each record, before the reader opens anything.
 *
 * Every row here comes from an accepted typed role edge with retained source
 * evidence. A capacity with no accepted edge is not rendered at all — an empty
 * capacity section would read as a finding, and absence of evidence is not one.
 */

import { renderNodeSection } from "../civic_document_chrome.mjs";

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function countLine(group) {
  const total = Number(group.total_count) || 0;
  const shown = Number(group.shown_count) || 0;
  if (group.availability !== "matched") {
    return `${total} in this profile's retained sources`;
  }
  return shown < total ? `Showing ${shown} of ${total}` : `${total}`;
}

function recordRow(item) {
  const when = item.when_label
    ? `<span class="muted node-muted" data-capacity-when="${esc(item.when || "")}">${esc(item.when_label)}</span>`
    : "";
  const title = item.href
    ? `<a class="ui-constellation-link agency-edge-link" href="${esc(item.href)}">${esc(item.record_label)}</a>`
    : esc(item.record_label);
  const counterparty = item.counterparty_id
    ? `Other party: <a class="ui-constellation-link agency-edge-link" href="/agencies/${esc(item.counterparty_id)}/">${esc(item.counterparty_name || item.counterparty_id)}</a> (${esc(item.counterparty_label || "other party")})`
    : "";
  const evidence = [
    item.source_system ? `Source ${item.source_system}` : "",
    item.source_field && item.source_value
      ? `${item.source_field}: “${item.source_value}”`
      : "",
    item.source_receipt ? `Receipt ${item.source_receipt}` : "",
  ].filter(Boolean).join(" · ");
  return `<li class="node-record agency-record-capacity-record"
    data-record-capacity="${esc(item.capacity_id)}"
    data-role-relation="${esc(item.relation_id)}"
    data-record-ref="${esc(item.record_ref)}"
    data-record-kind="${esc(item.record_kind)}"
    data-browse-relation="${esc(item.browse_relation)}">
    <div class="node-record-main">${title}</div>
    <p class="node-record-capacity-line"><span class="agency-record-capacity-badge">${esc(item.label)}</span> ${esc(item.sentence)}</p>
    <span class="muted node-muted">${when ? `${when} · ` : ""}${esc(evidence)}</span>
    ${counterparty ? `<p class="muted node-muted">${counterparty}</p>` : ""}
  </li>`;
}

function capacityGroup(group) {
  const rows = group.items.map(recordRow).join("");
  if (!rows) return "";
  const action = group.view_all_href
    ? `<p class="node-inline-actions civic-object-inline-actions"><a class="node-action civic-object-action" href="${esc(group.view_all_href)}">Browse all ${esc(group.label.toLowerCase())}</a></p>`
    : "";
  const snapshot = group.as_of
    ? `<p class="muted node-muted agency-category-asof" data-as-of="${esc(group.as_of)}">Records as of ${esc(group.as_of)}</p>`
    : "";
  const unavailable = group.availability === "matched"
    ? ""
    : `<p class="muted node-muted" data-capacity-availability="${esc(group.availability)}">The full browse list for this capacity is not available right now. These are the records this profile resolved; this is not a count of zero elsewhere.</p>`;
  return `<section class="agency-record-capacity-group"
    data-record-capacity-group="${esc(group.group_id)}"
    data-capacity="${esc(group.capacity_id)}"
    data-browse-relation="${esc(group.browse_relation)}"
    data-total-count="${esc(String(group.total_count))}"
    data-count-basis="${esc(group.count_basis)}"
    aria-labelledby="agency-record-capacity-${esc(group.group_id)}-heading">
    <h3 id="agency-record-capacity-${esc(group.group_id)}-heading">${esc(group.label)} (${esc(countLine(group))})</h3>
    <p class="node-muted muted">${esc(group.boundary)}</p>
    ${unavailable}${snapshot}
    <ul class="node-record-list">${rows}</ul>
    ${action}
  </section>`;
}

export function renderAgencyRecordCapacitySection(view = {}) {
  const capacities = view?.record_capacities;
  const groups = Array.isArray(capacities?.groups) ? capacities.groups : [];
  const rendered = groups.map(capacityGroup).filter(Boolean).join("");
  if (!rendered) return "";
  return renderNodeSection({
    heading: "What this institution did in each record",
    headingId: "agency-record-capacity-heading",
    exportClass: "object_role_edges",
    extraClass: "node-card civic-object-section agency-record-capacity",
    attrs: {
      id: "agency-record-capacity",
      "data-record-capacity-schema": capacities.schema || "",
      "data-record-capacity-groups": String(groups.length),
    },
    body: `<p class="node-muted">Each record below names this institution in an exact source field, and that field is what the capacity says. Capacities are counted separately and never added together: a contract received is not a procurement issued, and being an applicant is not authority to approve.</p>
      ${rendered}`,
  });
}

export const recordCapacitySection = Object.freeze({
  id: "record-capacity",
  order: 6,
  render: (view) => renderAgencyRecordCapacitySection(view.view),
  styleOrder: 6,
  style: `.agency-record-capacity-group{margin:0 0 1.25rem}
.agency-record-capacity-group:last-child{margin-bottom:0}
.node-record-capacity-line{margin:.15rem 0;display:flex;flex-wrap:wrap;gap:.4rem;align-items:baseline;min-width:0}
.agency-record-capacity-badge{display:inline-block;padding:.05rem .45rem;border:1px solid currentColor;border-radius:.65rem;font-size:.78em;font-weight:600;white-space:nowrap}
.agency-record-capacity-record{overflow-wrap:anywhere}
.agency-record-capacity .node-action{display:inline-block;min-height:44px;line-height:44px;padding:0 .75rem}`,
});
