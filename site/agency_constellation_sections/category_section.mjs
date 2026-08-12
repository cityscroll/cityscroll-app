import { renderNodeSection } from "../civic_document_chrome.mjs";
import {
  renderWhyBelieveControl,
  sourceSystemReaderLabel,
} from "../graph_edge_provenance.mjs";
import { renderMandatesConformanceSection } from "../process_conformance.mjs";
import { constellationLink, officialSourceDisclosure } from "../affordance_grammar.mjs";

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function itemLink(item) {
  const label = esc(item.label || item.subject_ref || item.id);
  if (!item.href) return label;
  return constellationLink({
    href: item.href,
    label: item.label || item.subject_ref || item.id,
    className: "agency-edge-link",
    attributes: { "data-subject-ref": item.subject_ref || "" },
    escape: esc,
  });
}

function obligationMeta(item) {
  return [
    item.observation_label || null,
    item.expected_event_label || null,
    item.deliverable_type,
    item.date ? `deadline ${item.date}` : (item.deadline_text ? `deadline: ${item.deadline_text}` : null),
    item.recurrence,
    item.source,
  ].filter(Boolean).join(" · ");
}

function statusLabel(category) {
  if (category.status !== "matched") return "";
  if (category.id === "obligations") return `${category.count} mandates`;
  if (category.total_count != null) {
    const shown = category.items?.length || 0;
    const noun = category.universe === "open" ? "open" : "linked";
    return `Showing ${shown} of ${Number(category.total_count) || 0} ${noun}`;
  }
  return `${Number(category.count) || category.items?.length || 0} linked`;
}

export function renderAgencyCategorySection(category) {
  if (
    !category
    || category.status === "empty"
    || category.status === "not_yet_ingested"
    || (!(category?.items?.length) && !(category?.conformance?.items?.length))
  ) {
    return "";
  }

  if (category.id === "obligations" && category.conformance?.items?.length) {
    const refine = category.mandate_follow_hrefs
      ? [
        category.mandate_follow_hrefs.report
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.report)}">Watch report mandates</a>`
          : "",
        category.mandate_follow_hrefs.rulemaking
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.rulemaking)}">Watch rulemaking mandates</a>`
          : "",
        category.mandate_follow_hrefs.window_90
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.window_90)}">Watch deadlines in 90 days</a>`
          : "",
        category.follow_href
          ? `<a class="node-action civic-object-action" href="${esc(category.follow_href)}">Watch mandates and deadlines</a>`
          : "",
      ].filter(Boolean).join("")
      : "";
    const body = renderMandatesConformanceSection(category.conformance, { limit: 12 });
    if (refine && body.includes("</section>")) {
      return body.replace(
        "</section>",
        `<p class="node-inline-actions civic-object-inline-actions">${refine}</p></section>`,
      );
    }
    return body;
  }

  const status = category.id === "obligations"
    ? `${category.count} mandates`
    : (statusLabel(category) || `${category.count} linked`);
  const sourceItems = category.id === "obligations"
    ? category.items.filter((item) => item.href).map((item) => ({ href: item.href, label: item.label || "Source law" }))
    : [];
  const list = `<ul class="node-record-list">${category.items.map((item) => {
    const warrant = item.claim?.how?.warrant_class || "";
    const why = item.claim ? renderWhyBelieveControl(item.claim) : "";
    if (category.id === "obligations" || item.kind === "obligation") {
      return `<li class="node-record" data-obligation-id="${esc(item.id)}" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
        <div class="node-record-main">${esc(item.label)}${why ? ` ${why}` : ""}</div>
        <span class="muted node-muted">${esc(obligationMeta(item))}</span>
      </li>`;
    }
    const meta = [sourceSystemReaderLabel(item.source) || item.source, item.date]
      .filter(Boolean).join(" · ");
    return `<li class="node-record" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
      <div class="node-record-main">${itemLink(item)}${why ? ` ${why}` : ""}</div>
      ${meta ? `<span class="muted node-muted">${esc(meta)}</span>` : ""}
    </li>`;
  }).join("")}</ul>`;
  const honesty = category.id === "obligations" && category.honesty
    ? `<p class="node-muted muted">${esc(category.honesty)}</p>`
    : "";
  const snapshot = category.as_of
    ? `<p class="muted node-muted agency-category-asof" data-as-of="${esc(category.as_of)}">${category.universe === "open" ? "Open records" : "Linked records"} as of ${esc(category.as_of)}</p>`
    : "";
  const followLabel = category.id === "obligations"
    ? "Watch mandates and deadlines"
    : `Follow ${category.label.toLowerCase()}`;
  const refine = category.id === "obligations" && category.mandate_follow_hrefs
    ? [
      category.mandate_follow_hrefs.report
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.report)}">Watch report mandates</a>`
        : "",
      category.mandate_follow_hrefs.rulemaking
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.rulemaking)}">Watch rulemaking mandates</a>`
        : "",
      category.mandate_follow_hrefs.window_90
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.window_90)}">Watch deadlines in 90 days</a>`
        : "",
    ].filter(Boolean).join("")
    : "";
  const actions = [
    category.view_all_href
      ? `<a class="node-action civic-object-action" href="${esc(category.view_all_href)}">Open in ${esc(category.label)}</a>`
      : "",
    category.archive_href
      ? `<a class="node-action civic-object-action" href="${esc(category.archive_href)}">Browse archived awards and contracts</a>`
      : "",
    category.follow_href
      ? `<a class="node-action civic-object-action" href="${esc(category.follow_href)}">${esc(followLabel)}</a>`
      : "",
    refine,
  ].filter(Boolean).join("");
  const body = [
    honesty,
    snapshot,
    list,
    officialSourceDisclosure({ items: sourceItems, label: "Open source laws", escape: esc }),
    actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : "",
  ].join("");
  return renderNodeSection({
    heading: `${category.label} (${status})`,
    exportClass: "object_members",
    extraClass: "node-card civic-object-section",
    attrs: {
      "data-agency-constellation-category": category.id,
      "data-status": category.status,
      ...(category.as_of ? { "data-as-of": category.as_of } : {}),
      ...(category.total_count != null ? { "data-total-count": category.total_count } : {}),
      ...(category.universe ? { "data-universe": category.universe } : {}),
      ...(category.certification_basis
        ? { "data-certification-basis": category.certification_basis }
        : {}),
    },
    body,
  });
}

export function categorySection(id, order, extras = {}) {
  return Object.freeze({
    id,
    order,
    ...extras,
    render(view) {
      return renderAgencyCategorySection(
        view.displayView.categories.find((category) => category.id === id),
      );
    },
  });
}
