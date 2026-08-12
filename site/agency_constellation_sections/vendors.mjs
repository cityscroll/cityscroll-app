import { renderNodeSection } from "../civic_document_chrome.mjs";
import { entityChipHTML } from "../entity_pivot.mjs";
import { normalizeEdgeSummaryRecords, renderEdgeSummaryRail } from "../edge_summary.mjs";

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const money = (value) => Number.isFinite(Number(value))
  ? new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(value))
  : "Award total unavailable";

export function renderAgencyTopVendorsSection(category, source = {}) {
  if (!category || category.status !== "matched" || !category.items?.length) return "";
  const edgeSummary = normalizeEdgeSummaryRecords([{
    source_kind: "agency",
    source_id: category.agency_id || null,
    edge_type: category.relation || "top_vendor_by_award_12mo",
    label: category.label || "Top vendors by award value",
    target_kind: "vendor",
    target_name: category.label || "Top vendors by award value",
    count: category.count ?? category.items.length,
    state: "matched",
    href: category.view_all_href || null,
    source: {
      kind: source.kind || "agency",
      id: source.id || category.agency_id || null,
      name: source.name || "this agency",
      canonical_href: source.canonical_href || null,
    },
    scope: { relation_family: "top_vendors", as_of: category.as_of || null },
    as_of: category.as_of || null,
  }]);
  const list = `<ul class="node-record-list agency-top-vendors-list">${category.items.map((item) => {
    const vendor = entityChipHTML({
      ref: item.subject_ref,
      label: item.label,
      link_confidence: item.confidence || "strong",
      relation: item.relation || "top_vendor_by_award_12mo",
    }, {
      className: "agency-top-vendor-link",
      source: {
        kind: "agency",
        id: source.id || null,
        name: source.name || "this agency",
        canonical_href: source.canonical_href || null,
      },
    });
    const awards = `${Number(item.award_count) || 0} award${Number(item.award_count) === 1 ? "" : "s"}`;
    return `<li class="node-record" data-vendor-ref="${esc(item.subject_ref)}">
      <div class="node-record-main">${vendor}</div>
      <span class="muted node-muted">${esc(money(item.award_total))} · ${esc(awards)}</span>
    </li>`;
  }).join("")}</ul>`;
  const action = category.view_all_href
    ? `<p class="node-inline-actions civic-object-inline-actions"><a class="node-action civic-object-action" href="${esc(category.view_all_href)}">Open all agency contracts</a></p>`
    : "";
  return renderNodeSection({
    heading: category.label,
    exportClass: "object_members",
    extraClass: "node-card civic-object-section",
    attrs: {
      "data-agency-constellation-category": category.id,
      "data-status": category.status,
      "data-window-start": category.window_start || "",
      "data-window-as-of": category.as_of || "",
    },
    body: `${renderEdgeSummaryRail(edgeSummary, { heading: "Vendor connections", id: "agency-vendor-edge-summary-heading", className: "agency-vendor-edge-summary" })}${list}${action}`,
  });
}

export const vendorsSection = Object.freeze({
  id: "vendors",
  order: 41,
  render(view) {
    const category = view.displayView.categories.find((entry) => entry.id === "vendors");
    return renderAgencyTopVendorsSection(
      category ? { ...category, agency_id: view.displayView.canonical_id } : category,
      {
        kind: "agency",
        id: view.displayView.canonical_id,
        name: view.displayView.display_name,
        canonical_href: view.displayView.path,
      },
    );
  },
});
