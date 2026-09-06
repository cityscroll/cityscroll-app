import { renderNodeSection } from "../civic_document_chrome.mjs";
import {
  renderWhyBelieveControl,
  sourceSystemReaderLabel,
} from "../graph_edge_provenance.mjs";
import { renderMandatesConformanceSection } from "../process_conformance.mjs";
import { constellationLink, officialSourceDisclosure } from "../affordance_grammar.mjs";
import {
  EDGE_SUMMARY_STATE_MEANINGS,
  edgeSummaryStateCopy,
  renderEntityPivotLink,
} from "../edge_summary.mjs";
import { capacityForRecordRef } from "../civic_institution_record_capacity.mjs";

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function itemLink(item, source = {}) {
  const label = esc(item.label || item.subject_ref || item.id);
  if (!item.href) return label;
  const subject = String(item.subject_ref || "").match(/^([a-z-]+):(.+)$/);
  const targetKind = item.target_kind || ({ notice: "notice", project: "project", exam: "exam", vendor: "vendor" }[subject?.[1]] || "record");
  return renderEntityPivotLink({
    relation_label: item.relation || "related record",
    target_kind: targetKind,
    target_id: item.target_id || subject?.[2] || item.id || null,
    target_name: item.label || item.subject_ref || item.id,
    canonical_href: item.href,
    cross_spine: item.claim?.cross_spine || null,
    cross_spine_confidence: item.claim?.cross_spine?.confidence || null,
    cross_spine_explicit: item.claim?.cross_spine?.explicit || false,
    source,
  }, { className: "agency-edge-link", escape: esc });
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
  if (category.status !== "matched") {
    return edgeSummaryStateCopy({ state: category.status, count: category.count });
  }
  if (category.id === "obligations") return `${category.count} mandates`;
  if (category.total_count != null) {
    const shown = category.items?.length || 0;
    const noun = category.universe === "open" ? "open" : "linked";
    return `Showing ${shown} of ${Number(category.total_count) || 0} ${noun}`;
  }
  return `${Number(category.count) || category.items?.length || 0} linked`;
}

/**
 * A category row states which records name this institution. When a record
 * also has an accepted typed role for it, the row says what the institution
 * did there — so a reader does not have to open the record to learn whether
 * this body awarded it or received it. A record with no accepted role gets no
 * capacity line; the row still lists, it just makes no claim.
 */
function capacityLine(item, capacities) {
  const match = capacityForRecordRef(capacities, item?.subject_ref, item?.id, item?.procurement_id, item?.contract_id);
  if (!match) return "";
  return `
      <p class="node-record-capacity-line" data-record-capacity="${esc(match.capacity_id)}" data-role-relation="${esc(match.relation_id)}"><span class="agency-record-capacity-badge">${esc(match.label)}</span> ${esc(match.sentence)}</p>`;
}

export function renderAgencyCategorySection(category, source = {}, capacities = []) {
  if (!category) return "";

  const items = Array.isArray(category.items) ? category.items : [];
  const horizonItems = category.id === "rules" && Array.isArray(category.horizon_items)
    ? category.horizon_items
    : [];
  if (category.status === "empty" && !items.length && !category.conformance?.items?.length && !horizonItems.length) return "";

  const horizon = horizonItems.length
    ? `<section class="agency-rules-horizon" data-agency-rules-horizon="anticipated" aria-labelledby="agency-rules-horizon-heading">
      <h3 id="agency-rules-horizon-heading">On the horizon</h3>
      <p class="muted">These are agency planning signals, not formal rulemaking proceedings.</p>
      <ul class="node-record-list">${horizonItems.slice(0, 12).map((item) => `<li class="node-record" data-agenda-item-id="${esc(item.id)}" data-lifecycle-stage="anticipated">
        <div class="node-record-main"><a class="agency-edge-link" href="${esc(item.canonical_href || item.href || "")}">${esc(item.subject || item.label || item.id)}</a></div>
        <span class="muted node-muted">${esc(item.approximate_schedule || "Schedule not stated")} · Anticipated</span>
        <p class="node-inline-actions civic-object-inline-actions"><a class="node-action civic-object-action" href="${esc(item.follow_href || "/following/")}">Follow anticipated topic</a></p>
      </li>`).join("")}</ul>
    </section>`
    : "";

  if (category.id === "obligations" && category.conformance?.items?.length) {
    const refine = [
        category.mandate_follow_hrefs?.report
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.report)}">Watch report duties</a>`
          : "",
        category.mandate_follow_hrefs?.rulemaking
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.rulemaking)}">Watch rule duties</a>`
          : "",
        category.mandate_follow_hrefs?.window_90
          ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.window_90)}">Watch upcoming deadlines</a>`
          : "",
        category.follow_href
          ? `<a class="node-action civic-object-action" href="${esc(category.follow_href)}">Watch mandates and deadlines</a>`
          : "",
      ].filter(Boolean).join("");
    const body = renderMandatesConformanceSection(category.conformance, { limit: 12 });
    if (body) {
      if (refine && body.includes("</section>")) {
        return body.replace(
          "</section>",
          `<p class="node-inline-actions civic-object-inline-actions">${refine}</p></section>`,
        );
      }
      return body;
    }
  }

  const status = category.id === "obligations" && category.status === "matched"
    ? `${category.count} mandates`
    : (statusLabel(category) || `${category.count} linked`);
  const sourceItems = category.id === "obligations"
    ? category.items.filter((item) => item.href).map((item) => ({ href: item.href, label: item.label || "Source law" }))
    : [];
  const list = items.length ? `<ul class="node-record-list">${items.map((item) => {
    const warrant = item.claim?.how?.warrant_class || "";
    const why = item.claim ? renderWhyBelieveControl(item.claim) : "";
    if (category.id === "obligations" || item.kind === "obligation") {
      return `<li class="node-record" data-obligation-id="${esc(item.id)}" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
        <div class="node-record-main">${esc(item.label)}${why ? ` ${why}` : ""}</div>
        <span class="muted node-muted">${esc(obligationMeta(item))}</span>
      </li>`;
    }
    const meta = [item.operating_entity_name || sourceSystemReaderLabel(item.source) || item.source, item.date]
      .filter(Boolean).join(" · ");
    return `<li class="node-record" data-edge-claim-row="${esc(item.claim?.claim_id || item.subject_ref || item.id)}" data-warrant-class="${esc(warrant)}">
      <div class="node-record-main">${itemLink(item, source)}${why ? ` ${why}` : ""}</div>${capacityLine(item, capacities)}
      ${meta ? `<span class="muted node-muted">${esc(meta)}</span>` : ""}
    </li>`;
  }).join("")}</ul>` : "";
  const availability = EDGE_SUMMARY_STATE_MEANINGS[category.status] || EDGE_SUMMARY_STATE_MEANINGS.unknown;
  const stateNotice = category.status === "matched"
    ? ""
    : `<p class="node-muted muted agency-category-state" data-edge-state="${esc(category.status)}" data-edge-availability="${esc(availability)}">${esc(edgeSummaryStateCopy({ state: category.status, count: category.count }))}</p>`;
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
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.report)}">Watch report duties</a>`
        : "",
      category.mandate_follow_hrefs.rulemaking
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.rulemaking)}">Watch rule duties</a>`
        : "",
      category.mandate_follow_hrefs.window_90
        ? `<a class="node-action civic-object-action" href="${esc(category.mandate_follow_hrefs.window_90)}">Watch upcoming deadlines</a>`
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
    horizon,
    stateNotice,
    category.status !== "matched" && category.note ? `<p class="node-muted muted">${esc(category.note)}</p>` : "",
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
      ...(category.id === "obligations" ? { id: "agency-statutory-mandates" } : {}),
      "data-agency-constellation-category": category.id,
      "data-status": category.status,
      "data-edge-state": category.status,
      "data-edge-availability": availability,
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
        {
          kind: "agency",
          id: view.displayView.canonical_id,
          name: view.displayView.display_name,
          canonical_href: view.displayView.path,
        },
      );
    },
  });
}
