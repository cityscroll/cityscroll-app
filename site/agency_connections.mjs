/**
 * Pure agency-connection view model over the entity-intelligence read model.
 *
 * The response remains the evidence owner. This adapter only separates strong
 * from tentative observations and composes canonical scope-v0 links.
 */

export const AGENCY_CONNECTION_DOMAINS = Object.freeze([
  { domain: "money", relation: "published_by_agency", role_key: "entity_intel_role_bought" },
  { domain: "land", relation: "applicant_agency", role_key: "entity_intel_role_land" },
  { domain: "property", relation: "published_by_agency", role_key: "entity_intel_role_property" },
  { domain: "rules", relation: "issued_rule", role_key: "entity_intel_role_rules" },
  { domain: "meetings", relation: "hosts_meeting", role_key: "entity_intel_role_meetings" },
  { domain: "people", relation: "votes_as_official", role_key: "entity_intel_role_votes" },
  { domain: "franchise", relation: "named_franchisee", role_key: "entity_intel_role_franchise" },
]);

const publicConfidence = (value) => {
  const confidence = String(value || "").trim().toLowerCase();
  return confidence === "strong" || confidence === "tentative" ? confidence : null;
};

function scopeApi(provided) {
  const api = provided || globalThis.CrolScope;
  if (!api) throw new Error("Agency connections require the scope-v0 adapter");
  return api;
}

function agencyDescriptor(response) {
  const root = response?.root || {};
  return {
    ref: String(root.ref || "").trim(),
    name: String(root.display_name || root.canonical_name || root.ref || "").trim(),
  };
}

function agencyConstraint(response, language = "en", providedScopeApi) {
  const { emptyScope, normalizeScope, scopeWithEntity } = scopeApi(providedScopeApi);
  const agency = agencyDescriptor(response);
  let scope = emptyScope(language);
  if (agency.name) scope.facets.agencies = [agency.name];
  scope = scopeWithEntity(scope, agency.ref);
  return normalizeScope(scope, { language });
}

function relationForDomain(response, domain) {
  const objects = response?.domains?.[domain]?.objects || [];
  const accepted = objects.filter((object) => publicConfidence(object?.confidence));
  const linked = accepted.find((object) => publicConfidence(object.confidence) === "strong" && object.link_type)
    || accepted.find((object) => object.link_type);
  return String(linked?.link_type || "").trim()
    || AGENCY_CONNECTION_DOMAINS.find((entry) => entry.domain === domain)?.relation
    || "";
}

/** Compose one populated relation/domain into a canonical, reload-safe scope. */
export function connectionScopeHash(response, domain, { language = "en", scope: providedScopeApi } = {}) {
  const { normalizeScope, routeHashFromScope } = scopeApi(providedScopeApi);
  const spec = AGENCY_CONNECTION_DOMAINS.find((entry) => entry.domain === domain);
  if (!spec) return "";
  const domainBlock = response?.domains?.[domain];
  if (!domainBlock || domainBlock.status !== "matched" || !(domainBlock.objects || []).length) return "";

  const scoped = agencyConstraint(response, language, providedScopeApi);
  scoped.facets.domains = [domain];
  scoped.facets.values.connection_relation = relationForDomain(response, domain);
  if (domain === "money" && (domainBlock.objects || []).some((object) => object.object_kind === "award")) {
    scoped.facets.values.mode = "award";
  }
  return routeHashFromScope(normalizeScope(scoped, { language }), { surface: domain });
}

/** Intersect this agency with the view that opened its profile. */
export function agencyApplyScopeHash(
  response,
  currentHash = "#money",
  { language = "en", scope: providedScopeApi } = {},
) {
  const { intersectScopes, routeHashFromScope, scopeFromRouteHash } = scopeApi(providedScopeApi);
  const current = scopeFromRouteHash(currentHash, { language });
  const agency = agencyConstraint(response, language, providedScopeApi);
  const composed = intersectScopes(current, agency);
  const surface = current.facets.domains?.[0] || "money";
  return routeHashFromScope(composed, { surface });
}

/** Build bounded role groups while keeping weak/review-only candidates out. */
export function buildAgencyConnectionView(
  response,
  { currentHash = "#money", language = "en", scope: providedScopeApi } = {},
) {
  scopeApi(providedScopeApi);
  const groups = AGENCY_CONNECTION_DOMAINS.map((spec) => {
    const block = response?.domains?.[spec.domain] || {};
    const objects = (Array.isArray(block.objects) ? block.objects : [])
      .map((object) => ({ ...object, confidence: publicConfidence(object?.confidence) }))
      .filter((object) => object.confidence);
    const strongCount = objects.filter((object) => object.confidence === "strong").length;
    const tentativeCount = objects.filter((object) => object.confidence === "tentative").length;
    return {
      ...spec,
      relation: relationForDomain(response, spec.domain),
      status: block.status || "empty",
      gap_class: block.gap_class || null,
      note: block.note || null,
      objects,
      strong_count: strongCount,
      tentative_count: tentativeCount,
      view_all_href: connectionScopeHash(response, spec.domain, {
        language,
        scope: providedScopeApi,
      }),
    };
  });

  const strongCount = groups.reduce((total, group) => total + group.strong_count, 0);
  const tentativeCount = groups.reduce((total, group) => total + group.tentative_count, 0);
  const coverage = response?.coverage || {};
  return {
    root: response?.root || null,
    groups,
    apply_scope_href: agencyApplyScopeHash(response, currentHash, {
      language,
      scope: providedScopeApi,
    }),
    summary: {
      observed_domains: groups.filter((group) => group.status === "matched").length,
      strong_count: strongCount,
      tentative_count: tentativeCount,
      coverage_eligible: Number.isFinite(coverage.eligible) ? coverage.eligible : null,
      coverage_linked: Number.isFinite(coverage.linked) ? coverage.linked : strongCount,
      coverage_rate: Number.isFinite(coverage.rate) ? coverage.rate : null,
      vintage: coverage.vintage || response?.materialization_meta?.generated_at || null,
    },
  };
}
