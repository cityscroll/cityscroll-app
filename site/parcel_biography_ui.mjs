/** Pure HTML renderer for the observed parcel biography view model. */

import { officialSourceLink } from "./affordance_grammar.mjs";
import { bblReaderLabel } from "./bbl_reader.mjs";
import { normalizeEdgeSummaryRecords, renderEdgeSummaryRail } from "./edge_summary.mjs";
import { PARCEL_PROCESS_SECTION_ORDER, parcelItemOfficialSource } from "./parcel_scope.mjs";

export const PARCEL_EDGE_FAMILIES = Object.freeze({
  property: Object.freeze({ target_kind: "notice", edge_type: "sits_on_parcel", label: "Property disposition", target_name: "Property" }),
  land: Object.freeze({ target_kind: "project", edge_type: "sits_on_parcel", label: "Land-use process", target_name: "Land use" }),
  tax_lien: Object.freeze({ target_kind: "tax-lien", edge_type: "appeared_on_published_list", label: "Tax-lien status", target_name: "Tax liens" }),
  ll48: Object.freeze({ target_kind: "suitability", edge_type: "suitability_record_for_exact_bbl", label: "City-owned or leased property suitability", target_name: "Suitability" }),
  cofo: Object.freeze({ target_kind: "certificate-of-occupancy", edge_type: "legal_occupancy_on_parcel", label: "Certificates of Occupancy", target_name: "Occupancy" }),
});

const UNKNOWN_SECTION_STATUSES = new Set([
  "unknown",
  "not_indexed",
  "unindexed",
  "not_yet_ingested",
]);

function parcelEdgeState(section) {
  if (UNKNOWN_SECTION_STATUSES.has(String(section?.status || "").toLowerCase())) return "unknown";
  if ((section?.items || []).length) return "matched";
  if (section?.coverage
    && (Object.hasOwn(section.coverage, "eligible") || Object.hasOwn(section.coverage, "linked"))
    && section.coverage.eligible == null
    && section.coverage.linked == null) return "unknown";
  return "empty";
}

/** Convert parcel evidence groups to the shared edge-summary contract. */
export function buildParcelBiographyEdgeSummary(view, { hrefForKind = (kind) => `#parcel-biography-${kind}` } = {}) {
  return normalizeEdgeSummaryRecords(PARCEL_PROCESS_SECTION_ORDER.map((kind) => {
    const family = PARCEL_EDGE_FAMILIES[kind];
    const section = view?.sections?.[kind] || {};
    const state = parcelEdgeState(section);
    return {
      source_kind: "parcel",
      source_id: view?.parcel_ref || null,
      edge_type: family.edge_type,
      label: family.label,
      target_kind: family.target_kind,
      target_name: family.target_name,
      count: state === "unknown" ? null : (section.items || []).length,
      state,
      href: hrefForKind(kind),
      scope: { parcel_ref: view?.parcel_ref || null, relation_family: kind },
      as_of: section.coverage?.vintage || null,
    };
  }));
}

function safeHelpers(helpers = {}) {
  const escape = typeof helpers.escape === "function"
    ? helpers.escape
    : (value) => String(value ?? "").replace(/[<>&'"]/g, (char) => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;",
    })[char]);
  return {
    t: typeof helpers.t === "function" ? helpers.t : (key) => key,
    escape,
    pivot: typeof helpers.pivot === "function" ? helpers.pivot : (_href, label) => label,
    parcelPivot: typeof helpers.parcelPivot === "function" ? helpers.parcelPivot : (_bbl, label) => label,
    formatDate: typeof helpers.formatDate === "function" ? helpers.formatDate : (value) => String(value || ""),
    stageLabel: typeof helpers.stageLabel === "function" ? helpers.stageLabel : (value) => String(value || ""),
    outcomeLabel: typeof helpers.outcomeLabel === "function" ? helpers.outcomeLabel : (value) => String(value || ""),
  };
}

function biographyDate(value, h) {
  return value ? h.formatDate(value) : h.t("property_xd_date_unknown");
}

function itemHTML(item, kind, h) {
  let label = h.escape(item.label || item.id || "—");
  if (item.href && String(item.href).startsWith("#")) label = h.pivot(item.href, label);
  if (kind === "tax_lien") {
    label = `${h.escape(h.stageLabel(item.stage))} · ${h.escape(h.outcomeLabel(item.outcome))}${item.nta_name ? ` · ${h.escape(item.nta_name)}` : ""}`;
  }
  const relationKey = {
    property: "property_xd_relation_property",
    land: "property_xd_relation_land",
    tax_lien: "property_xd_relation_tax_lien",
    cofo: "property_xd_relation_cofo",
    ll48: "property_xd_relation_ll48",
  }[kind];
  // Provenance is trailing ↗ only (omit-by-default source-name prose).
  const official = parcelItemOfficialSource(item);
  const provenance = official
    ? ` ${officialSourceLink({
      href: official.href,
      label: official.label,
      className: "parcel-biography-source",
      escape: h.escape,
    })}`
    : "";
  // Always keep a date line so undated rows stay explicit ("date not published")
  // without reintroducing source-name organizers.
  const dateLine = `<span class="muted parcel-biography-item-meta">${h.escape(biographyDate(item.date, h))}</span>`;
  const conflicts = (item.conflicts || []).map((conflict) => `<span class="note parcel-biography-conflict">${h.escape(conflict.note || "Conflicting source values retained")}: ${conflict.values.map((value) => `${h.escape(value.source)} = ${h.escape(value.value)}`).join(" · ")}</span>`).join("");
  return `<li data-parcel-biography-item="${h.escape(kind)}" data-link-confidence="strong">
    <span class="ei-obj-main" lang="en" dir="ltr">${label}${provenance}</span>
    ${dateLine}
    <span class="muted parcel-biography-relation">${h.t(relationKey)}</span>
    ${conflicts}
  </li>`;
}

export function parcelBiographySectionHTML(view, kind, helpers = {}) {
  const h = safeHelpers(helpers);
  const section = view.sections?.[kind];
  if (!section) return "";
  const headingKey = {
    property: "property_xd_property_heading",
    land: "property_xd_land_heading",
    tax_lien: "property_xd_tax_lien_heading",
    cofo: "property_xd_cofo_heading",
    ll48: "property_xd_ll48_heading",
  }[kind];
  const items = (section.items || []).map((item) => itemHTML(item, kind, h)).join("");
  const emptyKey = {
    property: "property_xd_property_empty",
    land: "property_xd_land_empty",
    tax_lien: "property_xd_tax_lien_empty",
    cofo: "property_xd_cofo_empty",
    ll48: "property_xd_ll48_empty",
  }[kind];
  return `<section id="parcel-biography-${h.escape(kind)}" class="parcel-biography-domain property-xd-${h.escape(kind)}" data-parcel-biography-domain="${h.escape(kind)}" data-status="${h.escape(section.status || "")}">
    <h3 class="ei-domain-h">${h.t(headingKey)}</h3>
    ${items ? `<ul class="ei-list">${items}</ul>` : `<div class="note">${h.t(emptyKey)}</div>`}
  </section>`;
}

export function observedParcelBiographyHTML(view, { href = "", ...helpers } = {}) {
  const h = safeHelpers(helpers);
  if (!view?.ok) return "";
  const sections = PARCEL_PROCESS_SECTION_ORDER
    .map((kind) => parcelBiographySectionHTML(view, kind, h))
    .join("");
  const edgeSummary = renderEdgeSummaryRail(buildParcelBiographyEdgeSummary(view), {
    heading: "Connected parcel records",
    id: "parcel-edge-summary-heading",
    className: "parcel-edge-summary",
  });
  return `<section class="parcel-biography" data-parcel-biography="1" data-parcel-ref="${h.escape(view.parcel_ref)}">
    <div class="chain-h">${h.t("property_xd_heading")}</div>
    <p class="parcel-biography-bbl">${h.parcelPivot(view.bbl, bblReaderLabel(view.bbl) || h.t("property_xd_bbl_label", { bbl: view.bbl }))}</p>
    <p class="note">${h.t("property_xd_deck")}</p>
    ${edgeSummary}
    <div class="parcel-biography-domains">
      ${sections}
    </div>
    <div class="factions"><a class="act" href="${h.escape(href)}">${h.t("property_xd_view_scope")}</a></div>
  </section>`;
}
