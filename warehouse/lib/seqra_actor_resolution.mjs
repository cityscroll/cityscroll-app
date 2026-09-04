/**
 * SEQRA-07: actor resolution across the six institutional-signal sources
 * (Council, City Record, Community Board, agency, eLobbyist, COELIG).
 *
 * This module does not re-implement organization-name matching. It resolves
 * a raw per-source actor string to the same comparison key
 * entity_resolution/officials/org_resolve.mjs already uses product-wide
 * (orgKeyPreferringVendorStem, precision-favoring: "ABC Services" stays
 * distinct from "ABC Consulting"), then narrows that comparison key into a
 * SEQRA ontology `organization_key` via
 * warehouse/lib/seqra_stable_keys.mjs#buildOrganizationKey. Two source rows
 * that resolve to the same comparison key under the same organization_type
 * always resolve to the same organization_key, regardless of which of the
 * six source systems observed them (A1).
 *
 * `organization_type` classification is deliberately conservative: it comes
 * from the source system's own known role (a Council office is always
 * "elected_official_office"; a Community Board adapter row is always
 * "community_board"), never from guessing at a name or activity description.
 * eLobbyist and COELIG rows carry a lobbying *client*, whose type this
 * module cannot responsibly infer from a name string alone -- those resolve
 * to "unknown" unless the caller supplies an explicit, source-independent
 * hint. Falling back to "unknown" rather than guessing is the point: a
 * wrong guess here (e.g. labeling a tenant association a "developer") is
 * exactly the kind of unsupported characterization the commission's negative
 * rule exists to prevent.
 */

import { orgKeyPreferringVendorStem } from "../../entity_resolution/officials/org_resolve.mjs";
import { buildOrganizationKey, normalizeKeyToken } from "./seqra_stable_keys.mjs";

export const SEQRA_ORGANIZATION_TYPES = Object.freeze([
  "community_board",
  "elected_official_office",
  "advocacy_group",
  "developer",
  "government_agency",
  "labor_organization",
  "other",
  "unknown",
]);

/** Source systems whose actor role is fixed by the adapter itself, never inferred per-row. */
export const SEQRA_SOURCE_SYSTEM_ORGANIZATION_TYPE = Object.freeze({
  nyc_council_legislative_records: "elected_official_office",
  community_board_positions: "community_board",
  agency_position_records: "government_agency",
  // eLobbyist and COELIG rows name a lobbying client, not a fixed role -- the
  // caller must supply organizationTypeHint or this resolves to "unknown".
  nyc_elobbyist: null,
  nys_coelig_lobbying: null,
  // City Record notices can originate from any agency or, in a hearing
  // notice, name the requesting party; not a fixed role either.
  nyc_city_record_notices: null,
});

class SeqraActorResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraActorResolutionError";
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeqraActorResolutionError(`${fieldName} is required and must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Resolve one raw actor string into a SEQRA organization identity.
 *
 * @param {object} input
 * @param {string} input.rawName - the actor string as published by the source.
 * @param {string} input.sourceSystem - one of SEQRA_SOURCE_SYSTEM_ORGANIZATION_TYPE's keys.
 * @param {string|null} [input.organizationTypeHint] - required when the source
 *   system has no fixed role; must be one of SEQRA_ORGANIZATION_TYPES.
 * @returns {{ organization_key: string, name: string, organization_type: string,
 *             comparison_key: string, match_basis: string }}
 */
export function resolveOrganization({ rawName, sourceSystem, organizationTypeHint = null } = {}) {
  const name = requireNonEmptyString(rawName, "rawName");
  requireNonEmptyString(sourceSystem, "sourceSystem");
  if (!(sourceSystem in SEQRA_SOURCE_SYSTEM_ORGANIZATION_TYPE)) {
    throw new SeqraActorResolutionError(`unknown SEQRA-07 source system: ${JSON.stringify(sourceSystem)}`);
  }

  const comparisonKey = orgKeyPreferringVendorStem(name);
  if (!comparisonKey) {
    throw new SeqraActorResolutionError(`rawName ${JSON.stringify(rawName)} normalized to no usable organization identity`);
  }

  const fixedType = SEQRA_SOURCE_SYSTEM_ORGANIZATION_TYPE[sourceSystem];
  let organizationType;
  let matchBasis;
  if (fixedType) {
    organizationType = fixedType;
    matchBasis = "source_system_fixed_role";
  } else if (organizationTypeHint) {
    if (!SEQRA_ORGANIZATION_TYPES.includes(organizationTypeHint)) {
      throw new SeqraActorResolutionError(`organizationTypeHint ${JSON.stringify(organizationTypeHint)} is not a recognized organization_type`);
    }
    organizationType = organizationTypeHint;
    matchBasis = "caller_supplied_hint";
  } else {
    organizationType = "unknown";
    matchBasis = "no_hint_defaulted_unknown";
  }

  const resolvedName = normalizeKeyToken(comparisonKey, "comparisonKey");
  const organizationKey = buildOrganizationKey({ organizationType, resolvedName });

  return {
    organization_key: organizationKey,
    name,
    organization_type: organizationType,
    comparison_key: comparisonKey,
    match_basis: matchBasis,
  };
}

export { SeqraActorResolutionError };
