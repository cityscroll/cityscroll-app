/** Pure HTML renderer for the observed parcel biography view model. */

import { officialSourceLink } from "./affordance_grammar.mjs";
import { bblReaderLabel } from "./bbl_reader.mjs";
import { PARCEL_PROCESS_SECTION_ORDER, parcelItemOfficialSource } from "./parcel_scope.mjs";

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
  return `<section class="parcel-biography-domain property-xd-${h.escape(kind)}" data-parcel-biography-domain="${h.escape(kind)}" data-status="${h.escape(section.status || "")}">
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
  return `<section class="parcel-biography" data-parcel-biography="1" data-parcel-ref="${h.escape(view.parcel_ref)}">
    <div class="chain-h">${h.t("property_xd_heading")}</div>
    <p class="parcel-biography-bbl">${h.parcelPivot(view.bbl, bblReaderLabel(view.bbl) || h.t("property_xd_bbl_label", { bbl: view.bbl }))}</p>
    <p class="note">${h.t("property_xd_deck")}</p>
    <div class="parcel-biography-domains">
      ${sections}
    </div>
    <div class="factions"><a class="act" href="${h.escape(href)}">${h.t("property_xd_view_scope")}</a></div>
  </section>`;
}
