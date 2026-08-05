import {
  emptyScope,
  intersectScopes,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";

const GROUPS = Object.freeze([
  { id: "awards", label: "Awards", domain: "money", kind: "award", surface: "money", mode: "award" },
  // PASSPort Public + Checkbook Contracts corroboration (VI-02 procurement spine):
  // a distinct evidence kind from the award notice, so it gets its own labeled,
  // separately counted section instead of folding into "awards" or "payments".
  { id: "contracts", label: "Contract corroboration", domain: "money", kind: "contract", surface: null },
  { id: "payments", label: "Payments", domain: "money", kind: "payment", surface: null },
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
export function vendorFootprintScopeHref(
  ref,
  groupId,
  { language = "en", query = "", resultCount = null } = {},
) {
  const group = GROUPS.find((candidate) => candidate.id === groupId);
  if (!group?.surface || !ref) return "";
  const domainScope = emptyScope(language);
  domainScope.facets.domains = [group.surface];
  if (group.mode) domainScope.facets.values.mode = group.mode;
  if (query) {
    domainScope.topic.query = String(query);
    domainScope.topic.keywords = [String(query)];
  }
  const entityScope = scopeWithEntity(emptyScope(language), ref);
  const composed = intersectScopes(domainScope, entityScope);
  const count = Number(resultCount);
  if (Number.isInteger(count) && count >= 0) {
    composed.facets.values.result_count_receipt = count;
  }
  return routeHashFromScope(composed, { surface: group.surface });
}

/**
 * Suggest one fast, reliable composition move: this vendor scope intersected
 * with a named agency (the money "agency=" facet, already load-bearing across
 * every lens). Reuses the same typed-entity + intersectScopes primitive as
 * vendorFootprintScopeHref — never invents a link when either side is empty.
 */
export function vendorAgencyIntersectionHref(
  ref,
  agencyName,
  { language = "en", query = "" } = {},
) {
  const name = String(agencyName || "").trim();
  if (!ref || !name) return "";
  const domainScope = emptyScope(language);
  domainScope.facets.domains = ["money"];
  domainScope.facets.agencies = [name];
  if (query) {
    domainScope.topic.query = String(query);
    domainScope.topic.keywords = [String(query)];
  }
  const entityScope = scopeWithEntity(emptyScope(language), ref);
  const composed = intersectScopes(domainScope, entityScope);
  return routeHashFromScope(composed, { surface: "money" });
}

export function vendorFootprintModel(response = {}) {
  const footprint = response?.vendor_footprint;
  if (!footprint || response?.root?.kind !== "vendor") return null;
  return {
    root: response.root,
    qualifier_required: footprint.qualifier_required !== false,
    award_coverage: footprint.award_coverage || null,
    census: footprint.census || null,
    promotion: footprint.promotion || null,
    provenance: footprint.provenance || null,
    groups: GROUPS.map((group) => {
      const objects = strongObjects(response, group);
      const explicit = footprint.section_counts?.[group.id] || {};
      const awardFallback = group.id === "awards" ? footprint.award_coverage || {} : {};
      const confirmedCount = Number.isInteger(explicit.confirmed_count)
        ? explicit.confirmed_count
        : Number.isInteger(awardFallback.linked)
          ? awardFallback.linked
          : objects.length;
      const mentionCount = Number.isInteger(explicit.mention_count)
        ? explicit.mention_count
        : Number.isInteger(awardFallback.eligible)
          ? awardFallback.eligible
          : confirmedCount;
      const scopeCount = Number.isInteger(explicit.scope_count)
        ? explicit.scope_count
        : Math.max(confirmedCount, mentionCount);
      const query = response.root.stem || response.root.display_name || "";
      return {
        ...group,
        objects,
        confirmed_count: confirmedCount,
        mention_count: Math.max(confirmedCount, mentionCount),
        scope_count: Math.max(confirmedCount, scopeCount),
        href: scopeCount > 0
          ? vendorFootprintScopeHref(response.root.ref, group.id, {
              query,
              resultCount: scopeCount,
            })
          : "",
        coverage_kind: group.id === "awards" ? "measured" : "unknown",
      };
    }),
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
  const displayName = model.root.display_name || model.root.stem || "this vendor";
  const sections = model.groups.map((group) => {
    const coverage = model.qualifier_required && group.coverage_kind === "unknown"
      ? `<p class="vendor-footprint-coverage" data-coverage-kind="unknown">We haven’t measured how complete this section is yet.</p>`
      : "";
    const confirmed = group.confirmed_count;
    const mentions = group.mention_count;
    let identitySummary = "";
    if (!confirmed && mentions) {
      identitySummary = `${mentions.toLocaleString("en-US")} record${mentions === 1 ? "" : "s"} mention this name — identity not yet confirmed`;
    } else if (confirmed && mentions > confirmed) {
      identitySummary = `${confirmed.toLocaleString("en-US")} link${confirmed === 1 ? "" : "s"} we’ve confirmed · ${mentions.toLocaleString("en-US")} records mention this name`;
    } else if (confirmed) {
      identitySummary = `${confirmed.toLocaleString("en-US")} link${confirmed === 1 ? "" : "s"} we’ve confirmed`;
    } else {
      identitySummary = "No records mentioning this name are in this summary yet.";
    }
    const objects = group.objects.slice(0, 4);
    const body = objects.length
      ? `<ul class="ei-list">${objects.map((object) => objectHTML(object, formatDate)).join("")}</ul>`
      : "";
    const viewAll = group.href
      ? `<a class="vendor-footprint-scope" href="${escapeHTML(group.href)}">See ${escapeHTML(displayName)}&#39;s ${escapeHTML(group.label.toLowerCase())} (${group.scope_count.toLocaleString("en-US")}) →</a>`
      : "";
    return `<section class="ei-domain vendor-footprint-section" data-footprint-section="${group.id}">
      <h3 class="ei-domain-h">${escapeHTML(group.label)} <span class="ct">${group.scope_count.toLocaleString("en-US")}</span></h3>
      ${coverage}
      <p class="vendor-footprint-match-summary">${escapeHTML(identitySummary)}</p>
      ${body}
      ${viewAll}
    </section>`;
  }).join("");
  const asOf = model.provenance?.denominator_materialized_at
    ? ` Awards last counted ${escapeHTML(formatDate(model.provenance.denominator_materialized_at))}.`
    : "";
  return `<div class="eicard vendor-footprint" data-vendor-ref="${escapeHTML(model.root.ref)}" data-coverage-status="${model.qualifier_required ? "qualified" : "promoted"}" lang="en">
    <div class="chain-h" style="margin:0 0 8px">Vendor city footprint</div>
    <p class="ei-lead">Published records connected with ${escapeHTML(displayName)}, grouped by what they show.</p>
    <div class="ei-domains">${sections}</div>
    <p class="aidprov ei-method">This summary separates links we’ve confirmed from records that mention the name.${asOf}</p>
  </div>`;
}
