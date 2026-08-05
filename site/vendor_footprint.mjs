import {
  emptyScope,
  intersectScopes,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";

const GROUPS = Object.freeze([
  { id: "awards", label: "Awards", domain: "money", kind: "award", surface: "money", mode: "award" },
  { id: "payments", label: "Payments", domain: "money", kind: "payment", surface: "money" },
  { id: "land", label: "Land use", domain: "land", surface: "land" },
  { id: "property", label: "Property", domain: "property", surface: "property" },
  { id: "rules", label: "Rules", domain: "rules", surface: "rules" },
  { id: "meetings", label: "Meetings", domain: "meetings", surface: "meetings" },
  { id: "franchise", label: "Franchises and concessions", domain: "franchise", surface: null },
]);

const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

function strongObjects(response, group) {
  const objects = response?.domains?.[group.domain]?.objects || [];
  return objects.filter((object) => object?.confidence === "strong"
    && (!group.kind || object?.object_kind === group.kind));
}

/** Compose a domain scope with the typed vendor constraint from gc-01. */
export function vendorFootprintScopeHref(ref, groupId, { language = "en" } = {}) {
  const group = GROUPS.find((candidate) => candidate.id === groupId);
  if (!group?.surface || !ref) return "";
  const domainScope = emptyScope(language);
  domainScope.facets.domains = [group.surface];
  if (group.mode) domainScope.facets.values.mode = group.mode;
  const entityScope = scopeWithEntity(emptyScope(language), ref);
  const composed = intersectScopes(domainScope, entityScope);
  return routeHashFromScope(composed, { surface: group.surface });
}

export function vendorFootprintModel(response = {}) {
  const footprint = response?.vendor_footprint;
  if (!footprint || response?.root?.kind !== "vendor") return null;
  return {
    root: response.root,
    qualifier_required: footprint.qualifier_required !== false,
    award_coverage: footprint.award_coverage || null,
    promotion: footprint.promotion || null,
    provenance: footprint.provenance || null,
    groups: GROUPS.map((group) => ({
      ...group,
      objects: strongObjects(response, group),
      href: vendorFootprintScopeHref(response.root.ref, group.id),
      coverage_kind: group.id === "awards" ? "measured" : "unknown",
    })),
  };
}

function objectHTML(object, formatDate) {
  const label = escapeHTML(object?.label || object?.subject_ref || "Published record");
  const href = String(object?.href || "");
  const linkedLabel = href.startsWith("#")
    ? `<a class="pivot" href="${escapeHTML(href)}">${label}</a>`
    : label;
  const when = object?.when ? `<span class="ei-when">${escapeHTML(formatDate(object.when))}</span>` : "";
  const provenance = object?.provenance
    ? `<span class="ei-prov">${escapeHTML(object.provenance.source_system || "")} · ${escapeHTML(object.provenance.source_record_id || "")}</span>`
    : "";
  return `<li class="ei-obj"><span class="ei-obj-main">${linkedLabel}${when}</span>${provenance}</li>`;
}

export function renderVendorFootprintHTML(response = {}, { formatDate = (value) => value } = {}) {
  const model = vendorFootprintModel(response);
  if (!model) return "";
  const awardCoverage = model.award_coverage;
  const sections = model.groups.map((group) => {
    let coverage = "";
    if (model.qualifier_required && group.coverage_kind === "measured" && awardCoverage?.label) {
      coverage = `<p class="vendor-footprint-coverage" data-coverage-kind="measured">${escapeHTML(awardCoverage.label)}</p>`;
    } else if (model.qualifier_required) {
      coverage = `<p class="vendor-footprint-coverage" data-coverage-kind="unknown">coverage not measured for this section; showing strong links only</p>`;
    }
    const objects = group.objects.slice(0, 4);
    const body = objects.length
      ? `<ul class="ei-list">${objects.map((object) => objectHTML(object, formatDate)).join("")}</ul>`
      : `<p class="ei-empty">No strongly linked records in this build.</p>`;
    const viewAll = group.href
      ? `<a class="vendor-footprint-scope" href="${escapeHTML(group.href)}">View this vendor as a ${escapeHTML(group.label.toLowerCase())} scope →</a>`
      : "";
    return `<section class="ei-domain vendor-footprint-section" data-footprint-section="${group.id}">
      <h3 class="ei-domain-h">${escapeHTML(group.label)} <span class="ct">${group.objects.length}</span></h3>
      ${coverage}
      ${body}
      ${viewAll}
    </section>`;
  }).join("");
  const method = model.qualifier_required
    ? "This is a partial view. Exact-stem strong links appear; possible and review-only matches stay out."
    : "This view passed the documented coverage and precision promotion gates. Possible and review-only matches stay out.";
  const asOf = model.provenance?.denominator_materialized_at
    ? ` Award denominator rebuilt ${escapeHTML(formatDate(model.provenance.denominator_materialized_at))}.`
    : "";
  return `<div class="eicard vendor-footprint" data-vendor-ref="${escapeHTML(model.root.ref)}" data-coverage-status="${model.qualifier_required ? "qualified" : "promoted"}" lang="en">
    <div class="chain-h" style="margin:0 0 8px">Vendor city footprint</div>
    <p class="ei-lead">Published records linked to ${escapeHTML(model.root.display_name || model.root.stem || "this vendor")}, grouped by what they show.</p>
    <div class="ei-domains">${sections}</div>
    <p class="aidprov ei-method">${method}${asOf}</p>
  </div>`;
}
