/** Canonical agency scope links for browse lenses. */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { routeHashFromScope, scopeFromRouteHash, scopeWithEntity } from "./scope_v0.mjs";
import { renderCardinalityAdaptiveFacet } from "./cardinality_adaptive_facets.mjs";

export const AGENCY_SCOPE_LINKS_SCHEMA = "cityscroll.agency_scope_links.v1";

function cleanAgencyScopeValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeAgencyScopeHtml(value) {
  return cleanAgencyScopeValue(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isAgencyRef(value) {
  return /^agency:/.test(String(value || ""));
}

function agencyEntityRef(value) {
  const identity = resolveAgencyIdentity(cleanAgencyScopeValue(value));
  return identity?.matched && identity.canonical_id ? `agency:id:${identity.canonical_id}` : "";
}

function unresolvedAgencyLabels(rows, knownLabels) {
  const labels = new Set();
  for (const row of rows) {
    const label = cleanAgencyScopeValue(typeof row === "string" ? row : row?.agency_name);
    const identity = resolveAgencyIdentity(label);
    if (label && (!identity?.matched || !identity.canonical_id) && !knownLabels.has(label)) labels.add(label);
  }
  return [...labels].sort((left, right) => left.localeCompare(right));
}

function withoutAgency(scope) {
  const next = scopeFromRouteHash(routeHashFromScope(scope, { surface: "rules" }));
  next.facets.agencies = [];
  const refs = Array.isArray(next.facets.values?.entity_refs_all)
    ? next.facets.values.entity_refs_all.filter((ref) => !isAgencyRef(ref))
    : [];
  if (refs.length) next.facets.values.entity_refs_all = refs;
  else delete next.facets.values.entity_refs_all;
  return next;
}

/** Replace the agency axis while preserving every other parsed scope facet. */
export function agencyScopeHref(surface, agency, currentHash = `#${surface}`) {
  const base = withoutAgency(scopeFromRouteHash(currentHash));
  const ref = agencyEntityRef(agency);
  const scoped = ref ? scopeWithEntity(base, ref) : base;
  return routeHashFromScope(scoped, { surface });
}

/** Collapse source agency rows to reviewed canonical agency identities. */
export function canonicalAgencyChoices(rows = []) {
  const choices = new Map();
  for (const row of rows) {
    const label = cleanAgencyScopeValue(typeof row === "string" ? row : row?.agency_name);
    const identity = resolveAgencyIdentity(label);
    if (!label || !identity?.matched || !identity.canonical_id) continue;
    if (!choices.has(identity.canonical_id)) {
      choices.set(identity.canonical_id, {
        id: identity.canonical_id,
        label: identity.canonical_name || label,
      });
    }
  }
  return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function agencyScopeLinksHTML({
  surface = "rules",
  agencies = [],
  selected = "",
  currentHash = `#${surface}`,
  t = (key) => key,
  escape = escapeAgencyScopeHtml,
} = {}) {
  const selectedIdentity = resolveAgencyIdentity(selected);
  const selectedId = selectedIdentity?.matched ? selectedIdentity.canonical_id : "";
  const choices = canonicalAgencyChoices(agencies).map((choice) => ({
    ...choice,
    scopeEdge: `${surface}.agency.${choice.id}`,
  }));
  const unresolved = unresolvedAgencyLabels(agencies, new Set(choices.map((choice) => choice.label)));
  const allHref = agencyScopeHref(surface, "", currentHash);
  return renderCardinalityAdaptiveFacet({
    id: `${surface}-agency`,
    label: t("agency_label"),
    choices,
    selectedId,
    allLabel: t("all_agencies"),
    allHref,
    entityHref: (choice) => `/agencies/${encodeURIComponent(choice.id)}/`,
    scopeHref: (choice) => agencyScopeHref(surface, choice.label, currentHash),
    unresolvedLabels: unresolved,
    escape,
  });
}
