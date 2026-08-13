import {
  emptyScope,
  intersectScopes,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { constellationLink } from "./affordance_grammar.mjs";
import {
  edgeSummaryStateCopy,
  normalizeEdgeSummaryRecords,
  renderEdgeSummaryRail,
} from "./edge_summary.mjs";
import { buildLocalConstellation, ensureLocalConstellationStylesheet, renderLocalConstellationHTML } from "./local_constellation.mjs";

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
  const query = response.root.stem || response.root.display_name || "";
  const groups = GROUPS.map((group) => {
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
      const denominator = footprint.summary?.section_denominators?.[group.id] || null;
      const edgeState = denominator?.status === "unknown" && scopeCount === 0
        ? "unknown"
        : scopeCount > 0 ? "matched" : "empty";
      return {
        ...group,
        objects,
        confirmed_count: confirmedCount,
        mention_count: Math.max(confirmedCount, mentionCount),
        scope_count: Math.max(confirmedCount, scopeCount),
        edge_state: edgeState,
        edge_count: edgeState === "unknown" ? null : Math.max(confirmedCount, scopeCount),
        denominator_status: denominator?.status || null,
        href: scopeCount > 0
          ? vendorFootprintScopeHref(response.root.ref, group.id, {
              query,
              resultCount: scopeCount,
            })
          : "",
        coverage_kind: group.id === "awards" ? "measured" : "unknown",
      };
    });
  const localConstellation = buildLocalConstellation({
    kind: "vendor",
    subject_ref: response.root.ref || null,
    subject_id: response.root.ref || null,
    subject_name: response.root.display_name || response.root.stem || null,
    source: footprint.provenance || null,
    provenance: footprint.provenance || null,
    neighbors: groups.flatMap((group) => group.objects.map((object) => ({
      edge_type: "linked_to_vendor",
      relation_label: group.label,
      target_kind: group.kind || group.id,
      target_id: object.subject_ref || object.request_id || null,
      target_name: object.label || object.subject_ref || group.label,
      href: object.href || null,
      state: object.href ? "matched" : "unknown",
      provenance: object.provenance || null,
    }))),
  });
  return {
    root: response.root,
    qualifier_required: footprint.qualifier_required !== false,
    award_coverage: footprint.award_coverage || null,
    census: footprint.census || null,
    promotion: footprint.promotion || null,
    provenance: footprint.provenance || null,
    groups,
    local_constellation: localConstellation,
  };
}

function objectHTML(object, formatDate) {
  const label = escapeHTML(object?.label || object?.subject_ref || "Published record");
  const href = String(object?.href || "");
  const linkedLabel = href.startsWith("#")
    ? constellationLink({ href, label: object?.label || object?.subject_ref || "Published record", className: "pivot vendor-record-link", escape: escapeHTML })
    : label;
  const when = object?.when ? `<span class="ei-when">${escapeHTML(formatDate(object.when))}</span>` : "";
  return `<li class="ei-obj"><span class="ei-obj-main">${linkedLabel}${when}</span></li>`;
}

export function renderVendorFootprintHTML(response = {}, { formatDate = (value) => value } = {}) {
  const model = vendorFootprintModel(response);
  if (!model) return "";
  ensureLocalConstellationStylesheet();
  const displayName = model.root.display_name || model.root.stem || "this vendor";
  const edgeSummary = normalizeEdgeSummaryRecords(model.groups.map((group) => ({
    source_kind: "vendor",
    source_id: model.root.ref || null,
    edge_type: "linked_to_vendor",
    label: `${group.label}: linked to this vendor`,
    target_kind: group.id === "awards" ? "award" : group.id === "contracts" ? "contract" : group.id === "payments" ? "payment" : group.id,
    target_name: group.label,
    count: group.edge_count,
    state: group.edge_state,
    href: group.href || null,
    source: {
      kind: "vendor",
      id: model.root.ref || null,
      name: displayName,
      canonical_href: model.root.ref ? `/vendors/${encodeURIComponent(model.root.stem || displayName)}/` : null,
    },
    scope: { domain: group.domain, object_kind: group.kind || null },
    as_of: model.provenance?.observed_on || null,
  })));
  const edgeByGroup = new Map(edgeSummary.map((record, index) => [model.groups[index].id, record]));
  const sections = model.groups.map((group) => {
    const edge = edgeByGroup.get(group.id);
    const confirmed = group.confirmed_count;
    const mentions = group.mention_count;
    let identitySummary = "";
    if (group.edge_state !== "matched") {
      identitySummary = edgeSummaryStateCopy(edge);
    } else if (!confirmed && mentions) {
      identitySummary = `${mentions.toLocaleString("en-US")} record${mentions === 1 ? "" : "s"} mention this name`;
    } else if (confirmed && mentions > confirmed) {
      identitySummary = `${confirmed.toLocaleString("en-US")} link${confirmed === 1 ? "" : "s"} we’ve confirmed · ${mentions.toLocaleString("en-US")} records mention this name`;
    } else if (confirmed) {
      identitySummary = `${confirmed.toLocaleString("en-US")} link${confirmed === 1 ? "" : "s"} we’ve confirmed`;
    }
    const objects = group.edge_state === "matched" ? group.objects.slice(0, 4) : [];
    const body = objects.length
      ? `<ul class="ei-list">${objects.map((object) => objectHTML(object, formatDate)).join("")}</ul>`
      : "";
    const viewAll = group.href
      ? constellationLink({ href: group.href, label: `See ${displayName}'s ${group.label.toLowerCase()} (${group.scope_count.toLocaleString("en-US")})`, className: "vendor-footprint-scope", escape: escapeHTML })
      : "";
    const countLabel = group.edge_count == null
      ? edgeSummaryStateCopy(edge)
      : group.scope_count.toLocaleString("en-US");
    return `<section class="ei-domain vendor-footprint-section" data-footprint-section="${group.id}" data-edge-state="${escapeHTML(group.edge_state)}" data-edge-availability="${escapeHTML(edge?.state === "empty" ? "empty-in-scope" : edge?.state === "unknown" ? "unknown-unindexed" : "available")}">
      <h3 class="ei-domain-h">${escapeHTML(group.label)} <span class="ct">${escapeHTML(countLabel)}</span></h3>
      <p class="vendor-footprint-match-summary">${escapeHTML(identitySummary)}</p>
      ${body}
      ${viewAll}
    </section>`;
  }).join("");
  return `<div class="eicard vendor-footprint" data-vendor-ref="${escapeHTML(model.root.ref)}" data-coverage-status="${model.qualifier_required ? "qualified" : "promoted"}" lang="en">
    <div class="chain-h" style="margin:0 0 8px">Vendor city footprint</div>
    <p class="ei-lead">Published records connected with ${escapeHTML(displayName)}, grouped by what they show.</p>
    ${renderEdgeSummaryRail(edgeSummary, { heading: "Vendor connections", id: "vendor-edge-summary-heading", className: "vendor-edge-summary" })}
    ${renderLocalConstellationHTML(model.local_constellation, { heading: "Nearby vendor records", id: "vendor-local-constellation-heading" })}
    <div class="ei-domains">${sections}</div>
  </div>`;
}
