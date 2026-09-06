/**
 * Reviewed browse classification for the public-body directory.
 *
 * The directory at /agencies/ has to help a reader choose between a
 * department, a commission, an elected office, a local board, an authority and
 * a nonprofit before they open the wrong destination. That is a recognition
 * problem, so this register answers it with reviewed, separately sourced
 * dimensions rather than one exclusive class column:
 *
 *   browse_group        where a reader is most likely to look for this body.
 *                       A navigation placement, not a legal category, and not
 *                       exclusive: `secondary_groups` lists the other groups a
 *                       reader could reasonably browse to the same body under.
 *   institution_kind    a reviewed descriptive kind, with its own basis. The
 *                       civic-institution identity refuses a kind that arrives
 *                       without one, so an unsourced body stays unclassified
 *                       and the directory shows it no badge.
 *   purpose             a short sentence the cited source supports.
 *   legal_form          a separately sourced corporate-form assertion, present
 *                       only where a source states one. A body can carry a
 *                       legal form and a statutory regime at once; neither
 *                       overwrites the other.
 *   statutory_regimes   named statutory definitions or reporting regimes that
 *                       reach this body, each with its own citation and the
 *                       date it was observed. "Agency" and "local authority"
 *                       are context-specific terms, so they are recorded as
 *                       regimes rather than as the body's class.
 *   jurisdiction        the territory served, kept apart from who created the
 *                       body: a state-created body can serve the city.
 *
 * Nothing here is inferred from a name, a directory listing, a publisher
 * `org_type`, an appointment, funding or co-occurrence. A body appears below
 * only when a primary legal source or the body's own official account
 * separates it from the bodies it would otherwise be read as. Most published
 * institutions therefore have no row, which is the intended outcome: they stay
 * findable by name in the directory's All group with no invented type.
 */

export const CIVIC_INSTITUTION_CLASSIFICATION_SCHEMA =
  "cityscroll.civic_institution_browse_classification.v1";
export const CIVIC_INSTITUTION_CLASSIFICATION_METHOD =
  "reviewed_primary_source_browse_classification_v1";

/** Primary sources this register cites. Nothing is fetched at render time. */
const SOURCE = Object.freeze({
  charter_21: Object.freeze({
    citation: "New York City Charter § 21",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-294",
  }),
  charter_85: Object.freeze({
    citation: "New York City Charter § 85",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-512",
  }),
  charter_191: Object.freeze({
    citation: "New York City Charter § 191",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-796",
  }),
  charter_1150: Object.freeze({
    citation: "New York City Charter § 1150",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-3317",
  }),
  charter_2601: Object.freeze({
    citation: "New York City Charter § 2601",
    url: "https://www.nyc.gov/site/coib/the-law/chapter-68-of-the-new-york-city-charter.page",
  }),
  charter_2800: Object.freeze({
    citation: "New York City Charter § 2800",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-4249",
  }),
  cpc_about: Object.freeze({
    citation: "City Planning Commission, About the Commission",
    url: "https://www.nyc.gov/content/planning/pages/commission/about-city-planning-commission",
  }),
  general_construction_66: Object.freeze({
    citation: "General Construction Law § 66",
    url: "https://www.nysenate.gov/legislation/laws/GCN/66",
  }),
  public_authorities_2: Object.freeze({
    citation: "Public Authorities Law § 2",
    url: "https://www.nysenate.gov/legislation/laws/PBA/2",
  }),
  public_housing_3: Object.freeze({
    citation: "Public Housing Law § 3",
    url: "https://www.nysenate.gov/legislation/laws/PBG/3",
  }),
  public_housing_401: Object.freeze({
    citation: "Public Housing Law § 401",
    url: "https://www.nysenate.gov/legislation/laws/PBG/401",
  }),
  home_rule_36: Object.freeze({
    citation: "Municipal Home Rule Law § 36",
    url: "https://www.nysenate.gov/legislation/laws/MHR/36",
  }),
  mta_network: Object.freeze({
    citation: "Metropolitan Transportation Authority, The MTA network",
    url: "https://www.mta.info/about-us/the-mta-network",
  }),
  mta_agencies: Object.freeze({
    citation: "Metropolitan Transportation Authority, Agencies",
    url: "https://www.mta.info/agency",
  }),
  edc_public_documents: Object.freeze({
    citation: "NYCEDC, Financial and public documents",
    url: "https://edc.nyc/about-nycedc/financial-public-documents-recordings",
  }),
  edc_board_minutes_2021: Object.freeze({
    citation: "NYCEDC Board of Directors minutes, 9 November 2021",
    url: "https://edc.nyc/sites/default/files/2022-02/EDC%20Board%20of%20Directors%20Minutes%2011-9-2021.pdf",
  }),
});

/**
 * The launch browse groups, in reading order.
 *
 * `note` states, on the page, what these groups are and are not, so a reader
 * never takes a placement for a legal holding. General Construction Law § 66
 * and Public Authorities Law § 2 are cited on the two groups whose everyday
 * names ("authority", "public corporation") carry statutory meanings that do
 * not line up with each other.
 */
export const INSTITUTION_BROWSE_GROUPS = Object.freeze([
  Object.freeze({
    id: "departments-executive-offices",
    label: "Departments & executive offices",
    note: "City departments and offices inside the executive branch.",
    sources: Object.freeze([]),
  }),
  Object.freeze({
    id: "council-elected-offices",
    label: "Council & elected offices",
    note: "The city's legislative body and the offices filled by city-wide or borough election.",
    sources: Object.freeze([SOURCE.charter_21, SOURCE.charter_2601]),
  }),
  Object.freeze({
    id: "boards-commissions",
    label: "Boards & commissions",
    note: "Bodies that hold hearings, vote or make recommendations, separately from the departments that staff them.",
    sources: Object.freeze([]),
  }),
  Object.freeze({
    id: "community-borough-boards",
    label: "Community & borough boards",
    note: "Local bodies established at community-district and borough geography.",
    sources: Object.freeze([SOURCE.charter_85, SOURCE.charter_2800]),
  }),
  Object.freeze({
    id: "authorities-public-corporations",
    label: "Authorities & public corporations",
    note: "Bodies created by state law, or reached by an authority reporting regime. These statutes define overlapping categories, so a body here may also appear under another group.",
    sources: Object.freeze([SOURCE.general_construction_66, SOURCE.public_authorities_2]),
  }),
  Object.freeze({
    id: "nonprofit-organizations",
    label: "Nonprofit organizations",
    note: "Organizations doing public work whose own corporate form is a nonprofit corporation.",
    sources: Object.freeze([SOURCE.public_authorities_2]),
  }),
]);

const BROWSE_GROUP_IDS = new Set(INSTITUTION_BROWSE_GROUPS.map((group) => group.id));

/**
 * Reviewed rows. `kind_basis` is the sentence the cited source supports; the
 * civic-institution identity rejects a kind offered without one.
 */
export const REVIEWED_INSTITUTION_CLASSIFICATIONS = Object.freeze([
  // ---- Departments & executive offices ----
  Object.freeze({
    canonical_id: "city-planning",
    browse_group: "departments-executive-offices",
    institution_kind: "department",
    kind_label: "City department",
    purpose: "Prepares the city's planning work; its director also chairs the City Planning Commission, and its staff assist that commission.",
    kind_basis: "New York City Charter § 191 establishes the department of city planning and provides for its director to chair the city planning commission.",
    kind_sources: Object.freeze([SOURCE.charter_191]),
    acronyms: Object.freeze(["DCP"]),
  }),
  Object.freeze({
    canonical_id: "office-of-racial-equity",
    browse_group: "departments-executive-offices",
    // Kind, purpose and basis are the statutory-identity register's to state.
    statutory_identity: true,
    acronyms: Object.freeze(["ORE"]),
  }),

  // ---- Council & elected offices ----
  Object.freeze({
    canonical_id: "city-council",
    browse_group: "council-elected-offices",
    institution_kind: "legislative_body",
    kind_label: "Legislative body",
    purpose: "The city's legislative body, made up of members elected by district.",
    kind_basis: "New York City Charter § 21 vests the legislative power of the city in the council.",
    kind_sources: Object.freeze([SOURCE.charter_21]),
    statutory_regimes: Object.freeze([
      Object.freeze({
        regime: "Conflicts-of-interest “agency”",
        note: "Chapter 68's definition of agency expressly reaches the council, which is a definition for that chapter's purposes and not a description of the council's legislative role.",
        citation: SOURCE.charter_2601.citation,
        source_url: SOURCE.charter_2601.url,
      }),
    ]),
    acronyms: Object.freeze([]),
  }),
  Object.freeze({
    canonical_id: "office-of-the-mayor",
    browse_group: "council-elected-offices",
    secondary_groups: Object.freeze(["departments-executive-offices"]),
    institution_kind: "elected_office",
    kind_label: "Elected office",
    purpose: "The office of the mayor, one of the offices Chapter 68 names as elected.",
    kind_basis: "New York City Charter § 2601 defines elected official to include the mayor.",
    kind_sources: Object.freeze([SOURCE.charter_2601]),
    acronyms: Object.freeze([]),
  }),
  ...["comptroller", "public-advocate"].map((canonical_id) => Object.freeze({
    canonical_id,
    browse_group: "council-elected-offices",
    institution_kind: "elected_office",
    kind_label: "Elected office",
    purpose: "A city-wide office Chapter 68 names as elected.",
    kind_basis: "New York City Charter § 2601 defines elected official to include this office.",
    kind_sources: Object.freeze([SOURCE.charter_2601]),
    acronyms: Object.freeze([]),
  })),
  ...["borough-president-bronx", "borough-president-brooklyn", "borough-president-queens"]
    .map((canonical_id) => Object.freeze({
      canonical_id,
      browse_group: "council-elected-offices",
      institution_kind: "elected_office",
      kind_label: "Elected office",
      purpose: "A borough office Chapter 68 names as elected. Borough presidents also sit on their borough board.",
      kind_basis: "New York City Charter § 2601 defines elected official to include borough presidents; § 85 provides for borough-president participation in the borough board.",
      kind_sources: Object.freeze([SOURCE.charter_2601, SOURCE.charter_85]),
      acronyms: Object.freeze([]),
    })),

  // ---- Boards & commissions ----
  Object.freeze({
    canonical_id: "city-planning-commission",
    browse_group: "boards-commissions",
    institution_kind: "commission",
    kind_label: "Commission",
    purpose: "Holds public hearings and votes on planning and land use matters. A separate body from the Department of City Planning, which staffs it.",
    kind_basis: "New York City Charter § 191 establishes the city planning commission separately from the department of city planning, and the commission's own account describes its hearing and voting work.",
    kind_sources: Object.freeze([SOURCE.charter_191, SOURCE.cpc_about]),
    acronyms: Object.freeze(["CPC"]),
  }),
  Object.freeze({
    canonical_id: "commission-on-racial-equity",
    browse_group: "boards-commissions",
    statutory_identity: true,
    acronyms: Object.freeze(["CORE"]),
  }),
  Object.freeze({
    canonical_id: "charter-revision-commission",
    browse_group: "boards-commissions",
    institution_kind: "commission",
    kind_label: "Charter revision commission",
    purpose: "A commission of the kind that may propose charter amendments for the voters to approve, rather than run a department or adopt agency rules.",
    kind_basis: "Municipal Home Rule Law § 36 provides the charter revision process a commission of this kind follows.",
    kind_sources: Object.freeze([SOURCE.home_rule_36]),
    acronyms: Object.freeze([]),
  }),

  // ---- Community & borough boards ----
  ...["bronx", "brooklyn", "manhattan", "queens", "staten-island"].map((slug) => Object.freeze({
    canonical_id: `${slug}-borough-board`,
    browse_group: "community-borough-boards",
    institution_kind: "board",
    kind_label: "Borough board",
    purpose: "A borough board with the borough president, the borough's council members and the community board chairs as statutory seats. Those seats are not a roster of current members.",
    kind_basis: "New York City Charter § 85 establishes borough boards with borough-president, council-member and community-board-chair participation.",
    kind_sources: Object.freeze([SOURCE.charter_85]),
    acronyms: Object.freeze([]),
  })),
  Object.freeze({
    canonical_id: "community-boards",
    browse_group: "community-borough-boards",
    institution_kind: "community_board",
    kind_label: "Community boards",
    purpose: "The city's community boards as a group. Each board is its own body with its own district.",
    kind_basis: "New York City Charter § 2800 establishes community boards and their appointment structure.",
    kind_sources: Object.freeze([SOURCE.charter_2800]),
    statutory_regimes: Object.freeze([
      Object.freeze({
        regime: "Conflicts-of-interest “agency”",
        note: "Chapter 68's definition of agency expressly reaches community boards, for that chapter's purposes.",
        citation: SOURCE.charter_2601.citation,
        source_url: SOURCE.charter_2601.url,
      }),
    ]),
    acronyms: Object.freeze([]),
  }),

  // ---- Authorities & public corporations ----
  Object.freeze({
    canonical_id: "housing-authority",
    browse_group: "authorities-public-corporations",
    institution_kind: "authority",
    kind_label: "Public housing authority",
    purpose: "A body corporate and politic established by state law to provide public housing in the city.",
    kind_basis: "Public Housing Law § 401 establishes the New York City housing authority as a body corporate and politic; § 3 supplies the housing-authority definition.",
    kind_sources: Object.freeze([SOURCE.public_housing_401, SOURCE.public_housing_3]),
    legal_form: Object.freeze({
      form: "Body corporate and politic",
      citation: SOURCE.public_housing_401.citation,
      source_url: SOURCE.public_housing_401.url,
    }),
    jurisdiction: "Serves New York City; created by state law.",
    jurisdiction_basis: "Public Housing Law § 401 establishes this authority for the city by state statute.",
    acronyms: Object.freeze(["NYCHA"]),
  }),
  Object.freeze({
    canonical_id: "metropolitan-transportation-authority",
    browse_group: "authorities-public-corporations",
    institution_kind: "public_benefit_corporation",
    kind_label: "Public benefit corporation",
    purpose: "A state-created public benefit corporation running transit and commuter services for the region, with a state-level appointment process for its board.",
    kind_basis: "The authority's own account of its network states its public-benefit-corporation status and its state-level appointment process.",
    kind_sources: Object.freeze([SOURCE.mta_network]),
    jurisdiction: "Serves New York City and the surrounding region; created by state law.",
    jurisdiction_basis: "The authority's own network account describes a regional service area and a state appointment process.",
    acronyms: Object.freeze(["MTA"]),
  }),
  // The MTA's own directory lists these as distinct operating bodies. That
  // supports family navigation and nothing more: it does not establish that a
  // listed unit shares the parent authority's legal form, so no row below
  // carries a legal_form assertion.
  ...[
    ["n-y-c-transit-authority", ["NYCT"]],
    ["long-island-rail-road", ["LIRR"]],
    ["mta-construction-and-development", []],
    ["triborough-bridge-and-tunnel-authority", ["TBTA"]],
  ].map(([canonical_id, acronyms]) => Object.freeze({
    canonical_id,
    browse_group: "authorities-public-corporations",
    institution_kind: "operating_body",
    kind_label: "MTA operating body",
    purpose: "One of the distinct operating bodies the MTA lists in its own directory. Being listed there does not establish that this body shares the authority's legal form.",
    kind_basis: "The Metropolitan Transportation Authority's own agency directory lists this as a distinct operating body.",
    kind_sources: Object.freeze([SOURCE.mta_agencies]),
    acronyms: Object.freeze(acronyms),
  })),

  // ---- Nonprofit organizations ----
  Object.freeze({
    canonical_id: "economic-development-corporation",
    browse_group: "nonprofit-organizations",
    // A reader looking under authorities should still find this body. The
    // secondary placement is what the authority regime below supports; it does
    // not restate the corporate form, and the corporate form does not cancel
    // the regime.
    secondary_groups: Object.freeze(["authorities-public-corporations"]),
    institution_kind: "nonprofit",
    kind_label: "Nonprofit organization",
    purpose: "A nonprofit corporation doing economic development work in the city. Its own board materials discuss obligations that apply to local authorities.",
    kind_basis: "The corporation describes itself as a nonprofit in its own financial and public documents.",
    kind_sources: Object.freeze([SOURCE.edc_public_documents]),
    legal_form: Object.freeze({
      form: "Nonprofit corporation",
      citation: SOURCE.edc_public_documents.citation,
      source_url: SOURCE.edc_public_documents.url,
    }),
    statutory_regimes: Object.freeze([
      Object.freeze({
        regime: "Local authority",
        note: "The local-authority definition can reach an affiliated nonprofit corporation. This regime applies alongside the corporate form above; it does not replace it.",
        citation: SOURCE.public_authorities_2.citation,
        source_url: SOURCE.public_authorities_2.url,
      }),
      Object.freeze({
        regime: "Local authority obligations, as discussed by the corporation's own board",
        note: "Dated evidence: what the board discussed on 9 November 2021. Read later governance details from a later source.",
        citation: SOURCE.edc_board_minutes_2021.citation,
        source_url: SOURCE.edc_board_minutes_2021.url,
        observed_on: "2021-11-09",
      }),
    ]),
    acronyms: Object.freeze(["NYCEDC", "EDC"]),
  }),
]);

/**
 * Every community board is a body of the kind Charter § 2800 establishes. The
 * class-level source carries to each reviewed board identity; nothing here
 * claims anything about an individual board beyond the kind it is.
 */
export const COMMUNITY_BOARD_CLASSIFICATION = Object.freeze({
  browse_group: "community-borough-boards",
  institution_kind: "community_board",
  kind_label: "Community board",
  kind_basis: "New York City Charter § 2800 establishes community boards and their appointment structure.",
  kind_sources: Object.freeze([SOURCE.charter_2800]),
});

const CLASSIFICATION_BY_ID = new Map(
  REVIEWED_INSTITUTION_CLASSIFICATIONS.map((row) => [row.canonical_id, row]),
);

for (const row of REVIEWED_INSTITUTION_CLASSIFICATIONS) {
  if (!BROWSE_GROUP_IDS.has(row.browse_group)) {
    throw new TypeError(`${row.canonical_id}: unknown browse group ${row.browse_group}`);
  }
  for (const secondary of row.secondary_groups || []) {
    if (!BROWSE_GROUP_IDS.has(secondary)) {
      throw new TypeError(`${row.canonical_id}: unknown secondary group ${secondary}`);
    }
    if (secondary === row.browse_group) {
      throw new TypeError(`${row.canonical_id}: secondary group repeats the primary placement`);
    }
  }
}

function classificationCanonicalIdOf(value) {
  return String(value ?? "")
    .replace(/^agency:id:/, "")
    .replace(/^civic-institution:/, "")
    .trim()
    .toLowerCase();
}

/** The reviewed row for one canonical id, subject ref or institution ref. */
export function institutionClassification(value) {
  return CLASSIFICATION_BY_ID.get(classificationCanonicalIdOf(value)) || null;
}

/** The reviewed browse group for one group id, or null. */
export function institutionBrowseGroup(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return INSTITUTION_BROWSE_GROUPS.find((group) => group.id === id) || null;
}
