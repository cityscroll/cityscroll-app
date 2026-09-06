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

const recordCapacityEsc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function recordCapacityCountLine(group) {
  const total = Number(group.total_count) || 0;
  const shown = Number(group.shown_count) || 0;
  if (group.availability !== "matched") {
    return `${total} in this profile's retained sources`;
  }
  return shown < total ? `Showing ${shown} of ${total}` : `${total}`;
}

function recordCapacityRow(item) {
  const when = item.when_label
    ? `<span class="muted node-muted" data-capacity-when="${recordCapacityEsc(item.when || "")}">${recordCapacityEsc(item.when_label)}</span>`
    : "";
  const title = item.href
    ? `<a class="ui-constellation-link agency-edge-link" href="${recordCapacityEsc(item.href)}">${recordCapacityEsc(item.record_label)}</a>`
    : recordCapacityEsc(item.record_label);
  const counterparty = item.counterparty_id
    ? `Other party: <a class="ui-constellation-link agency-edge-link" href="/agencies/${recordCapacityEsc(item.counterparty_id)}/">${recordCapacityEsc(item.counterparty_name || item.counterparty_id)}</a> (${recordCapacityEsc(item.counterparty_label || "other party")})`
    : "";
  const evidence = [
    item.source_system ? `Source ${item.source_system}` : "",
    item.source_field && item.source_value
      ? `${item.source_field}: “${item.source_value}”`
      : "",
    item.source_receipt ? `Receipt ${item.source_receipt}` : "",
  ].filter(Boolean).join(" · ");
  return `<li class="node-record agency-record-capacity-record"
    data-record-capacity="${recordCapacityEsc(item.capacity_id)}"
    data-role-relation="${recordCapacityEsc(item.relation_id)}"
    data-record-ref="${recordCapacityEsc(item.record_ref)}"
    data-record-kind="${recordCapacityEsc(item.record_kind)}"
    data-browse-relation="${recordCapacityEsc(item.browse_relation)}">
    <div class="node-record-main">${title}</div>
    <p class="node-record-capacity-line"><span class="agency-record-capacity-badge">${recordCapacityEsc(item.label)}</span> ${recordCapacityEsc(item.sentence)}</p>
    <span class="muted node-muted">${when ? `${when} · ` : ""}${recordCapacityEsc(evidence)}</span>
    ${counterparty ? `<p class="muted node-muted">${counterparty}</p>` : ""}
  </li>`;
}

function recordCapacityGroup(group) {
  const rows = group.items.map(recordCapacityRow).join("");
  if (!rows) return "";
  const action = group.view_all_href
    ? `<p class="node-inline-actions civic-object-inline-actions"><a class="node-action civic-object-action" href="${recordCapacityEsc(group.view_all_href)}">Browse all ${recordCapacityEsc(group.label.toLowerCase())}</a></p>`
    : "";
  const snapshot = group.as_of
    ? `<p class="muted node-muted agency-category-asof" data-as-of="${recordCapacityEsc(group.as_of)}">Records as of ${recordCapacityEsc(group.as_of)}</p>`
    : "";
  const unavailable = group.availability === "matched"
    ? ""
    : `<p class="muted node-muted" data-capacity-availability="${recordCapacityEsc(group.availability)}">The full browse list for this capacity is not available right now. These are the records this profile resolved; this is not a count of zero elsewhere.</p>`;
  return `<section class="agency-record-capacity-group"
    data-record-capacity-group="${recordCapacityEsc(group.group_id)}"
    data-capacity="${recordCapacityEsc(group.capacity_id)}"
    data-browse-relation="${recordCapacityEsc(group.browse_relation)}"
    data-total-count="${recordCapacityEsc(String(group.total_count))}"
    data-count-basis="${recordCapacityEsc(group.count_basis)}"
    aria-labelledby="agency-record-capacity-${recordCapacityEsc(group.group_id)}-heading">
    <h3 id="agency-record-capacity-${recordCapacityEsc(group.group_id)}-heading">${recordCapacityEsc(group.label)} (${recordCapacityEsc(recordCapacityCountLine(group))})</h3>
    <p class="node-muted muted">${recordCapacityEsc(group.boundary)}</p>
    ${unavailable}${snapshot}
    <ul class="node-record-list">${rows}</ul>
    ${action}
  </section>`;
}

export function renderAgencyRecordCapacitySection(view = {}) {
  const capacities = view?.record_capacities;
  const groups = Array.isArray(capacities?.groups) ? capacities.groups : [];
  const rendered = groups.map(recordCapacityGroup).filter(Boolean).join("");
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
