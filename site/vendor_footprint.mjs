import {
  emptyScope,
  intersectScopes,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";

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

function browseHref(hash, surface) {
  const facet = { money: "contracts", land: "zoning", property: "property", rules: "rules", meetings: "meetings" }[surface];
  if (!facet || !String(hash).startsWith("#")) return hash;
  return canonicalizeBrowseUrl(`/browse/${facet}/?${String(hash).split("?", 2)[1] || ""}`);
}

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
  return browseHref(routeHashFromScope(composed, { surface: group.surface }), group.surface);
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
  // Vendor/agency intersections are award-backed edges. The default money
  // route is open RFPs, whose records cannot carry a vendor ref.
  domainScope.facets.values.mode = "award";
  const agency = resolveAgencyIdentity(name);
  domainScope.facets.agencies = [agency.canonical_name];
  if (query) {
    domainScope.topic.query = String(query);
    domainScope.topic.keywords = [String(query)];
  }
  const entityScope = scopeWithEntity(emptyScope(language), ref);
  const agencyScope = scopeWithEntity(emptyScope(language), `agency:id:${agency.canonical_id}`);
  const composed = intersectScopes(intersectScopes(domainScope, agencyScope), entityScope);
  return browseHref(routeHashFromScope(composed, { surface: "money" }), "money");
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
  return `<li class="ei-obj"><span class="ei-obj-main">${linkedLabel}${when}</span></li>`;
}

export function renderVendorFootprintHTML(response = {}, { formatDate = (value) => value } = {}) {
  const model = vendorFootprintModel(response);
  if (!model) return "";
  const displayName = model.root.display_name || model.root.stem || "this vendor";
  const sections = model.groups.filter((group) => group.scope_count > 0).map((group) => {
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
      <p class="vendor-footprint-match-summary">${escapeHTML(identitySummary)}</p>
      ${body}
      ${viewAll}
    </section>`;
  }).join("");
  return `<div class="eicard vendor-footprint" data-vendor-ref="${escapeHTML(model.root.ref)}" data-coverage-status="${model.qualifier_required ? "qualified" : "promoted"}" lang="en">
    <div class="chain-h" style="margin:0 0 8px">Vendor city footprint</div>
    <p class="ei-lead">Published records connected with ${escapeHTML(displayName)}, grouped by what they show.</p>
    <div class="ei-domains">${sections}</div>
    <p class="aidprov ei-method">This summary groups the public records connected with this name.</p>
  </div>`;
}
