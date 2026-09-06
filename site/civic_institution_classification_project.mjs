/**
 * Build-time projection of reviewed browse classification.
 *
 * Kept off the browser scope-link graph: this file imports the civic-institution
 * identity constructor, which the public static site does not publish.
 */

import { civicInstitutionIdentity } from "../ontology/civic_institution.mjs";
import { statutoryInstitutionIdentity } from "./civic_institution_statutory_identity.mjs";
import {
  CIVIC_INSTITUTION_CLASSIFICATION_METHOD,
  CIVIC_INSTITUTION_CLASSIFICATION_SCHEMA,
  COMMUNITY_BOARD_CLASSIFICATION,
  institutionClassification,
} from "./civic_institution_classification.mjs";

function frozenSources(sources) {
  return Object.freeze((sources || []).map((source) => Object.freeze({
    citation: source.citation,
    source_url: source.url || source.source_url,
  })));
}

/**
 * Project one institution's reviewed classification.
 *
 * Returns null when no reviewed row covers the institution, so an unclassified
 * body renders as its name and destination with no badge and no empty panel.
 * A row that delegates to the statutory-identity register takes its kind,
 * purpose and basis from there rather than restating them.
 */
export function projectInstitutionClassification(value, { canonicalName = null } = {}) {
  const row = institutionClassification(value);
  if (!row) return null;
  const statutory = row.statutory_identity ? statutoryInstitutionIdentity(row.canonical_id) : null;
  if (row.statutory_identity && !statutory) return null;
  const institutionKind = statutory?.institution_kind || row.institution_kind || null;
  const kindLabel = statutory?.kind_label || row.kind_label || null;
  const purpose = statutory?.purpose || row.purpose || null;
  const kindBasis = statutory
    ? `${statutory.legal_basis.citation} establishes this body; ${statutory.definition_basis.citation} defines it separately.`
    : row.kind_basis || null;
  const kindSources = statutory
    ? frozenSources([statutory.legal_basis, statutory.definition_basis])
    : frozenSources(row.kind_sources);
  const institution = civicInstitutionIdentity({
    canonicalId: row.canonical_id,
    canonicalName: canonicalName || statutory?.canonical_name || null,
    institutionKind,
    institutionKindBasis: kindBasis,
    legalForm: row.legal_form?.form || null,
  });
  return Object.freeze({
    schema: CIVIC_INSTITUTION_CLASSIFICATION_SCHEMA,
    method: CIVIC_INSTITUTION_CLASSIFICATION_METHOD,
    institution,
    canonical_id: row.canonical_id,
    browse_group: row.browse_group,
    secondary_groups: Object.freeze([...(row.secondary_groups || [])]),
    kind_label: kindLabel,
    purpose,
    kind_basis: kindBasis,
    kind_sources: kindSources,
    legal_form: row.legal_form ? Object.freeze({ ...row.legal_form }) : null,
    statutory_regimes: Object.freeze((row.statutory_regimes || []).map((regime) => Object.freeze({ ...regime }))),
    jurisdiction: row.jurisdiction || null,
    jurisdiction_basis: row.jurisdiction_basis || null,
    acronyms: Object.freeze([...(row.acronyms || [])]),
  });
}

/** The class-level projection every reviewed community board shares. */
export function projectCommunityBoardClassification(bodyId, canonicalName) {
  const canonicalId = String(bodyId ?? "").trim().toLowerCase();
  if (!canonicalId) return null;
  return Object.freeze({
    schema: CIVIC_INSTITUTION_CLASSIFICATION_SCHEMA,
    method: CIVIC_INSTITUTION_CLASSIFICATION_METHOD,
    institution: civicInstitutionIdentity({
      canonicalId,
      canonicalName,
      institutionKind: COMMUNITY_BOARD_CLASSIFICATION.institution_kind,
      institutionKindBasis: COMMUNITY_BOARD_CLASSIFICATION.kind_basis,
    }),
    canonical_id: canonicalId,
    browse_group: COMMUNITY_BOARD_CLASSIFICATION.browse_group,
    secondary_groups: Object.freeze([]),
    kind_label: COMMUNITY_BOARD_CLASSIFICATION.kind_label,
    purpose: null,
    kind_basis: COMMUNITY_BOARD_CLASSIFICATION.kind_basis,
    kind_sources: frozenSources(COMMUNITY_BOARD_CLASSIFICATION.kind_sources),
    legal_form: null,
    statutory_regimes: Object.freeze([]),
    jurisdiction: null,
    jurisdiction_basis: null,
    acronyms: Object.freeze([]),
  });
}
