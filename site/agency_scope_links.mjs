/** Canonical agency scope links for browse lenses. */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { routeHashFromScope, scopeFromRouteHash, scopeWithEntity } from "./scope_v0.mjs";

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
  const choices = canonicalAgencyChoices(agencies);
  const allHref = agencyScopeHref(surface, "", currentHash);
  const allActive = !selectedId;
  const all = `<a class="chip agency-scope-link${allActive ? " on" : ""}" href="${escape(allHref)}" data-agency-scope-link="all" data-scope-edge="${escape(`${surface}.agency.all`)}"${allActive ? ' aria-current="page"' : ""}>${escape(t("all_agencies"))}</a>`;
  const links = choices.map((choice) => {
    const active = choice.id === selectedId;
    const href = agencyScopeHref(surface, choice.label, currentHash);
    const edge = `${surface}.agency.${choice.id}`;
    return `<a class="chip agency-scope-link${active ? " on" : ""}" href="${escape(href)}" data-agency-scope-link="${escape(choice.id)}" data-scope-edge="${escape(edge)}"${active ? ' aria-current="page"' : ""}>${escape(choice.label)}</a>`;
  }).join("");
  return `<div class="agency-scope-links" data-agency-scope="${escape(surface)}" role="group" aria-label="${escape(t("agency_label"))}">${all}${links}</div>`;
}
