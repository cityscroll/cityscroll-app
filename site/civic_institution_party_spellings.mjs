/**
 * Reviewed exact party spellings for civic institutions.
 *
 * A row names a party by writing a publisher's own spelling into a named
 * source field. This registry is the single reviewed statement of which exact
 * spelling, in which exact field, resolves to which canonical institution.
 *
 * The mapping is keyed on the source field and the exact retained value. It is
 * never keyed on a record identifier, so a reviewed mapping applies to every
 * retained record carrying that field value, not to one specimen. Equally, it
 * is never derived from a name, an acronym, a substring, a publisher
 * classification, or co-occurrence: an unreviewed spelling resolves to nothing
 * and stays non-linking.
 *
 * `capacity` is what the field means about the institution in that record. It
 * is a party position, not a power: being named in `vendor_name` says the
 * institution received a contract and says nothing about what it may approve
 * or issue.
 */

const partySpellingText = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

/**
 * Party capacities a source field can establish.
 *
 * `contracting_agency` and `contractor` are deliberately separate entries on
 * the same record: a contract has both, they are different institutions, and
 * neither may be read as the other.
 */
export const CIVIC_INSTITUTION_PARTY_CAPACITIES = Object.freeze({
  applicant: Object.freeze({
    capacity_id: "applicant",
    relation_id: "applicant_on",
    source_field: "primary_applicant",
    basis: "exact_zap_primary_applicant",
  }),
  contractor: Object.freeze({
    capacity_id: "contractor",
    relation_id: "contractor_on",
    source_field: "vendor_name",
    basis: "exact_contract_vendor_party",
  }),
  contracting_agency: Object.freeze({
    capacity_id: "contracting_agency",
    relation_id: "contracted_by",
    source_field: "agency_name",
    basis: "exact_contract_agency_party",
  }),
});

/**
 * Reviewed spellings. Every entry names the exact publisher value, the exact
 * field it was reviewed in, and the institution it resolves to.
 *
 * The Small Business Services spellings differ between the PASSPort master
 * contract row (`Small Business Services`) and the Checkbook registered
 * contract rows (`Department of Small Business Services`). Both are the same
 * publisher naming the same contracting agency, so both are reviewed here;
 * neither spelling is inferred from the other.
 */
export const CIVIC_INSTITUTION_PARTY_SPELLINGS = Object.freeze([
  Object.freeze({
    canonical_id: "economic-development-corporation",
    capacity_id: "applicant",
    source_field: "primary_applicant",
    spelling: "EDC - Economic Development Corporation for NYC",
    source_system: "zap_projects",
  }),
  Object.freeze({
    canonical_id: "economic-development-corporation",
    capacity_id: "contractor",
    source_field: "vendor_name",
    spelling: "NEW YORK CITY ECONOMIC DEVELOPMENT CORPORATION",
    source_system: "checkbook_contracts",
  }),
  Object.freeze({
    canonical_id: "economic-development-corporation",
    capacity_id: "contractor",
    source_field: "vendor_name",
    spelling: "New York City Economic Development Corporation",
    source_system: "passport_public_contracts",
  }),
  Object.freeze({
    canonical_id: "small-business-services",
    capacity_id: "contracting_agency",
    source_field: "agency_name",
    spelling: "DEPARTMENT OF SMALL BUSINESS SERVICES",
    source_system: "checkbook_contracts",
  }),
  Object.freeze({
    canonical_id: "small-business-services",
    capacity_id: "contracting_agency",
    source_field: "agency_name",
    spelling: "Department of Small Business Services",
    source_system: "checkbook_contracts",
  }),
  Object.freeze({
    canonical_id: "small-business-services",
    capacity_id: "contracting_agency",
    source_field: "agency_name",
    spelling: "Small Business Services",
    source_system: "passport_public_contracts",
  }),
]);

/**
 * Reviewed reader-facing names for the institutions this registry resolves.
 *
 * The general agency alias table does not name every reviewed institution —
 * NYCEDC has a profile but no alias entry — so a capacity sentence built only
 * from that table would address a reader with a route slug. These names are a
 * reviewed assertion alongside the spellings they belong to, not a guess
 * derived from a source value or a slug.
 */
export const CIVIC_INSTITUTION_REVIEWED_NAMES = Object.freeze({
  "economic-development-corporation": "Economic Development Corporation",
  "small-business-services": "Small Business Services",
});

/** The reviewed name for an institution, or "" when none is reviewed. */
export function reviewedInstitutionName(canonicalId) {
  return CIVIC_INSTITUTION_REVIEWED_NAMES[partySpellingText(canonicalId, 120)] || "";
}

const PARTY_SPELLINGS_BY_FIELD = new Map();
for (const entry of CIVIC_INSTITUTION_PARTY_SPELLINGS) {
  if (!PARTY_SPELLINGS_BY_FIELD.has(entry.source_field)) PARTY_SPELLINGS_BY_FIELD.set(entry.source_field, new Map());
  PARTY_SPELLINGS_BY_FIELD.get(entry.source_field).set(entry.spelling, entry);
}

/**
 * Resolve one exact retained field value to its reviewed party entry.
 * Case, punctuation, and near matches are not consulted: only the exact
 * reviewed spelling in the exact reviewed field resolves.
 */
export function civicInstitutionPartyFor(sourceField, value) {
  return PARTY_SPELLINGS_BY_FIELD.get(partySpellingText(sourceField, 80))?.get(partySpellingText(value, 500)) || null;
}

/** The canonical institution a reviewed field value names, or null. */
export function civicInstitutionIdForPartyValue(sourceField, value) {
  return civicInstitutionPartyFor(sourceField, value)?.canonical_id || null;
}

/** Every reviewed spelling one institution is named by, for one capacity. */
export function reviewedPartySpellings(canonicalId, capacityId = null) {
  const id = partySpellingText(canonicalId, 120);
  return Object.freeze(CIVIC_INSTITUTION_PARTY_SPELLINGS
    .filter((entry) => entry.canonical_id === id
      && (!capacityId || entry.capacity_id === partySpellingText(capacityId, 80)))
    .map((entry) => entry.spelling));
}

/** True when the exact value is a reviewed spelling of this institution. */
export function isReviewedPartySpelling(canonicalId, sourceField, value) {
  const entry = civicInstitutionPartyFor(sourceField, value);
  return Boolean(entry) && entry.canonical_id === partySpellingText(canonicalId, 120);
}
