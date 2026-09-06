/**
 * Reviewed statutory identity for institutions a similar name can hide.
 *
 * This is the legal-basis layer over the existing agency identity, keyed by
 * the same canonical id. It is not a second institution registry: it mints no
 * id, owns no route, and adds nothing to an institution the reviewed sources
 * below do not say. A row exists only where a primary legal source separates
 * one body from another body sharing its subject, so a reader who searched for
 * one of them can tell which page they are on.
 *
 * Each row carries its own citation and source URL. Where an earlier reviewed
 * group merged two of these bodies, the correction from
 * `site/agency_identity.mjs` is projected alongside the row so the old
 * reference stays visible and the correction stays auditable.
 */

import { civicInstitutionIdentity } from "../ontology/civic_institution.mjs";
import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";
import { escapeHtml } from "./text_clean.mjs";
import { AGENCY_IDENTITY_CORRECTIONS } from "./agency_identity.mjs";

export const CIVIC_INSTITUTION_STATUTORY_IDENTITY_SCHEMA =
  "cityscroll.civic_institution_statutory_identity.v1";
export const CIVIC_INSTITUTION_STATUTORY_IDENTITY_METHOD =
  "reviewed_primary_source_statutory_identity_v1";
export const CIVIC_INSTITUTION_STATUTORY_IDENTITY_ANCHOR = "institution-statutory-identity";

const RACIAL_EQUITY_OFFICE_CHARTER_URL = "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-6483";
const RACIAL_EQUITY_COMMISSION_CHARTER_URL = "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-6480";
const RACIAL_EQUITY_ADMIN_CODE_URL = "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-228871";

/**
 * The two racial equity bodies. Charter § 3401 establishes an office inside
 * the executive office of the mayor; Charter § 3404 establishes a commission.
 * Administrative Code § 34-102 defines each of them separately. Nothing here
 * describes what either body decided, spent or published — those stay with the
 * records that carry their own sources.
 */
export const REVIEWED_STATUTORY_INSTITUTIONS = Object.freeze([
  Object.freeze({
    canonical_id: "office-of-racial-equity",
    canonical_name: "Office of Racial Equity",
    institution_kind: "office",
    kind_label: "Mayoral office",
    purpose: "A city office established inside the executive office of the mayor.",
    legal_basis: Object.freeze({
      citation: "New York City Charter § 3401",
      source_url: RACIAL_EQUITY_OFFICE_CHARTER_URL,
    }),
    definition_basis: Object.freeze({
      citation: "Administrative Code § 34-102",
      source_url: RACIAL_EQUITY_ADMIN_CODE_URL,
    }),
    distinguished_from: Object.freeze({
      canonical_id: "commission-on-racial-equity",
      canonical_name: "Commission on Racial Equity",
      citation: "New York City Charter § 3404",
      source_url: RACIAL_EQUITY_COMMISSION_CHARTER_URL,
    }),
  }),
  Object.freeze({
    canonical_id: "commission-on-racial-equity",
    canonical_name: "Commission on Racial Equity",
    institution_kind: "commission",
    kind_label: "Commission",
    purpose: "A city commission established in its own Charter section.",
    legal_basis: Object.freeze({
      citation: "New York City Charter § 3404",
      source_url: RACIAL_EQUITY_COMMISSION_CHARTER_URL,
    }),
    definition_basis: Object.freeze({
      citation: "Administrative Code § 34-102",
      source_url: RACIAL_EQUITY_ADMIN_CODE_URL,
    }),
    distinguished_from: Object.freeze({
      canonical_id: "office-of-racial-equity",
      canonical_name: "Office of Racial Equity",
      citation: "New York City Charter § 3401",
      source_url: RACIAL_EQUITY_OFFICE_CHARTER_URL,
    }),
  }),
]);

const STATUTORY_INSTITUTION_BY_ID = new Map(REVIEWED_STATUTORY_INSTITUTIONS.map((row) => [row.canonical_id, row]));

function statutoryCanonicalIdOf(value) {
  return String(value ?? "")
    .replace(/^agency:id:/, "")
    .replace(/^civic-institution:/, "")
    .trim()
    .toLowerCase();
}

/** The reviewed statutory row for one canonical id, subject ref or institution ref. */
export function statutoryInstitutionIdentity(value) {
  return STATUTORY_INSTITUTION_BY_ID.get(statutoryCanonicalIdOf(value)) || null;
}

/** Corrections whose corrected identity points at this canonical id. */
function statutoryCorrectionsApplied(canonicalId) {
  return AGENCY_IDENTITY_CORRECTIONS.filter((row) => row.corrected_id === canonicalId);
}

/** Corrections whose superseded identity was this canonical id. */
function statutoryCorrectionsReleased(canonicalId) {
  return AGENCY_IDENTITY_CORRECTIONS.filter((row) => row.superseded_id === canonicalId);
}

/**
 * Project the statutory identity a profile shows at first paint, with the
 * source-name history a correction preserved. Returns null when no reviewed
 * row covers this institution — an absent statutory basis renders nothing
 * rather than an empty panel.
 */
export function projectStatutoryInstitutionIdentity(value) {
  const row = statutoryInstitutionIdentity(value);
  if (!row) return null;
  const institution = civicInstitutionIdentity({
    canonicalId: row.canonical_id,
    canonicalName: row.canonical_name,
    institutionKind: row.institution_kind,
    institutionKindBasis: `${row.legal_basis.citation} establishes this body; ${row.definition_basis.citation} defines it separately.`,
  });
  const applied = statutoryCorrectionsApplied(row.canonical_id);
  const releasedFrom = statutoryCorrectionsReleased(row.canonical_id);
  return Object.freeze({
    schema: CIVIC_INSTITUTION_STATUTORY_IDENTITY_SCHEMA,
    method: CIVIC_INSTITUTION_STATUTORY_IDENTITY_METHOD,
    anchor: CIVIC_INSTITUTION_STATUTORY_IDENTITY_ANCHOR,
    institution,
    canonical_id: row.canonical_id,
    canonical_name: row.canonical_name,
    kind_label: row.kind_label,
    purpose: row.purpose,
    legal_basis: row.legal_basis,
    definition_basis: row.definition_basis,
    distinguished_from: row.distinguished_from,
    // A spelling this identity took over, and a spelling it gave up. Both stay
    // listed so an old reference remains findable from either side.
    corrections_applied: Object.freeze(applied.map((correction) => Object.freeze({ ...correction }))),
    corrections_released: Object.freeze(releasedFrom.map((correction) => Object.freeze({ ...correction }))),
  });
}

function renderStatutoryCorrectionRow(correction, direction) {
  const heldNow = direction === "applied";
  const sentence = heldNow
    ? `Records published as “${correction.source_spelling}” were read under ${correction.superseded_name} before this correction. They are read here now.`
    : `Records published as “${correction.source_spelling}” were read here before this correction. They are read under ${correction.corrected_name} now.`;
  const otherId = heldNow ? correction.superseded_id : correction.corrected_id;
  const otherName = heldNow ? correction.superseded_name : correction.corrected_name;
  return `<li class="institution-statutory-correction" data-correction-source-spelling="${escapeHtml(correction.source_spelling)}" data-correction-direction="${escapeHtml(direction)}">
      <p>${escapeHtml(sentence)}</p>
      <p class="muted node-muted">${escapeHtml(correction.basis)}</p>
      <p class="institution-statutory-correction-meta">Corrected ${escapeHtml(correction.corrected_on)} · ${constellationLink({
        href: `/agencies/${otherId}/`,
        label: otherName,
        className: "agency-edge-link",
        escape: escapeHtml,
      })}</p>
      <ul class="institution-statutory-sources">${correction.sources
        .map((source) => `<li>${officialSourceLink({
          href: source.url,
          label: source.citation,
          newTabLabel: "(opens in new tab)",
          escape: escapeHtml,
        })}</li>`)
        .join("")}</ul>
    </li>`;
}

/**
 * The static first-paint block: what kind of body this is, the section that
 * establishes it, the separate body it is not, and — behind a disclosure that
 * needs no script — the source-name history a correction preserved.
 */
export function renderStatutoryInstitutionIdentity(projection) {
  if (!projection) return "";
  const corrections = [
    ...projection.corrections_applied.map((row) => [row, "applied"]),
    ...projection.corrections_released.map((row) => [row, "released"]),
  ];
  const history = corrections.length
    ? `<details class="institution-statutory-history" data-statutory-history="1">
      <summary>Source name history</summary>
      <ul class="institution-statutory-correction-list">${corrections
        .map(([correction, direction]) => renderStatutoryCorrectionRow(correction, direction))
        .join("")}</ul>
    </details>`
    : "";
  const establishedBy = officialSourceLink({
    href: projection.legal_basis.source_url,
    label: projection.legal_basis.citation,
    newTabLabel: "(opens in new tab)",
    escape: escapeHtml,
  });
  const definedBy = officialSourceLink({
    href: projection.definition_basis.source_url,
    label: projection.definition_basis.citation,
    newTabLabel: "(opens in new tab)",
    escape: escapeHtml,
  });
  const otherBody = constellationLink({
    href: `/agencies/${projection.distinguished_from.canonical_id}/`,
    label: projection.distinguished_from.canonical_name,
    className: "agency-edge-link",
    escape: escapeHtml,
  });
  const otherBasis = officialSourceLink({
    href: projection.distinguished_from.source_url,
    label: projection.distinguished_from.citation,
    newTabLabel: "(opens in new tab)",
    escape: escapeHtml,
  });
  return `<div class="institution-statutory-identity" id="${escapeHtml(CIVIC_INSTITUTION_STATUTORY_IDENTITY_ANCHOR)}" data-statutory-schema="${escapeHtml(projection.schema)}" data-institution-kind="${escapeHtml(projection.institution.institution_kind)}" data-canonical-id="${escapeHtml(projection.canonical_id)}">
    <p class="institution-statutory-kind"><span class="institution-statutory-kind-label">${escapeHtml(projection.kind_label)}</span> · ${escapeHtml(projection.purpose)}</p>
    <p class="institution-statutory-basis">Established by ${establishedBy} and defined by ${definedBy}.</p>
    <p class="institution-statutory-distinction" data-distinguished-from="${escapeHtml(projection.distinguished_from.canonical_id)}">This is not the ${otherBody}, a separate body established by ${otherBasis}.</p>
    ${history}
  </div>`;
}
