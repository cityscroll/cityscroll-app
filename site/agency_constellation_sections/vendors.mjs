import { renderNodeSection } from "../civic_document_chrome.mjs";
import { entityChipHTML } from "../entity_pivot.mjs";

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

export function renderAgencyTopVendorsSection(category) {
  if (!category || category.status !== "matched" || !category.items?.length) return "";
  const list = `<ul class="node-record-list agency-top-vendors-list">${category.items.map((item) => {
    const vendor = entityChipHTML({
      ref: item.subject_ref,
      label: item.label,
      link_confidence: item.confidence || "strong",
      relation: item.relation || "top_vendor_by_award_12mo",
    }, { className: "agency-top-vendor-link" });
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
    body: `${list}${action}`,
  });
}

export const vendorsSection = Object.freeze({
  id: "vendors",
  order: 41,
  render(view) {
    return renderAgencyTopVendorsSection(
      view.displayView.categories.find((category) => category.id === "vendors"),
    );
  },
});
