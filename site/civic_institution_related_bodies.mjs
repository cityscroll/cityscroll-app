/**
 * Sourced relationship links on existing public-body profiles.
 *
 * A profile already names a body and its purpose. This projection adds a
 * small set of typed, plainly worded links to the other bodies a reader is
 * most likely to need next: the department that staffs a commission, the
 * operating bodies an authority lists, the office, board, Community Board and
 * geography around a borough president. Each link keeps its destination's
 * own identity. Appointment, chairing, staffing and directory listing never
 * become general control, and a statutory seat is never a current member.
 *
 * No panel is rendered when a body has no sourced relationship. The links
 * are static markup so they remain anchors with scripting unavailable.
 */

import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { REVIEWED_BOROUGH_BOARDS } from "./borough_board_identity.mjs";
import { communityBoardPlaceHref } from "./community_board_links.mjs";
import {
  BROOKLYN_CB15_BODY_ID,
  BROOKLYN_OFFICE_CANONICAL_ID,
} from "./civic_institution_borough_office.mjs";
import {
  institutionClassification,
} from "./civic_institution_classification.mjs";
import { projectResidentInstitutionIdentity } from "./civic_institution_resident_identity.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";

export const RELATED_PUBLIC_BODIES_SCHEMA = "cityscroll.related_public_bodies.v1";
export const RELATED_PUBLIC_BODIES_METHOD = "reviewed_sourced_related_bodies_v1";
export const RELATED_PUBLIC_BODIES_ANCHOR = "related-public-bodies";
export const RELATED_PUBLIC_BODIES_NEGATIVE_RULE =
  "Never mint current members from statutory seat composition, treat appointment or chairing as general control, or assign every operating body the same legal form. Omit the panel when no sourced relationship exists.";

const SOURCE = Object.freeze({
  charter_85: Object.freeze({
    citation: "New York City Charter § 85",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-512",
  }),
  charter_191: Object.freeze({
    citation: "New York City Charter § 191",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-796",
  }),
  charter_2800: Object.freeze({
    citation: "New York City Charter § 2800",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-4249",
  }),
  cpc_about: Object.freeze({
    citation: "City Planning Commission, About the Commission",
    url: "https://www.nyc.gov/content/planning/pages/commission/about-city-planning-commission",
  }),
  mta_agencies: Object.freeze({
    citation: "Metropolitan Transportation Authority, Agencies",
    url: "https://www.mta.info/agency",
  }),
});

const DCP = "city-planning";
const CPC = "city-planning-commission";
const MTA = "metropolitan-transportation-authority";
const MTA_OPERATING_BODIES = Object.freeze([
  "n-y-c-transit-authority",
  "long-island-rail-road",
  "mta-construction-and-development",
  "triborough-bridge-and-tunnel-authority",
]);
const PUBLISHED_BOROUGH_OFFICES = Object.freeze(new Set([
  "borough-president-bronx",
  "borough-president-brooklyn",
  "borough-president-queens",
]));

function clean(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function canonicalIdOf(value) {
  return clean(value, 160)
    .replace(/^agency:id:/, "")
    .replace(/^civic-institution:/, "")
    .replace(/^community-board:/, "")
    .replace(/^borough-board:/, "")
    .toLowerCase();
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function displayNameOf(canonicalId) {
  const id = canonicalIdOf(canonicalId);
  const classified = institutionClassification(id);
  if (classified?.canonical_id) {
    return projectResidentInstitutionIdentity(id)?.canonical_name
      || resolveAgencyIdentity(id)?.canonical_name
      || id;
  }
  const board = REVIEWED_BOROUGH_BOARDS.find((row) => (
    row.borough_slug === id
    || row.civic_institution_id === `civic-institution:${id}`
    || `${row.borough_slug}-borough-board` === id
  ));
  if (board) return board.canonical_name;
  return projectResidentInstitutionIdentity(id)?.canonical_name
    || resolveAgencyIdentity(id)?.canonical_name
    || id;
}

export function boroughBoardCanonicalId(slug) {
  const id = clean(slug, 40).toLowerCase();
  return id ? `${id}-borough-board` : "";
}

export function boroughBoardHref(slug) {
  const id = boroughBoardCanonicalId(slug);
  return id ? `/agencies/${id}/` : "";
}

export function boroughGeographyHref(slug) {
  const id = clean(slug, 40).toLowerCase();
  return id ? `/near-you/borough/${id}/` : "";
}

function officeIdForBorough(slug) {
  return `borough-president-${clean(slug, 40).toLowerCase()}`;
}

function boroughSlugFromOffice(canonicalId) {
  const match = canonicalIdOf(canonicalId).match(/^borough-president-(.+)$/);
  return match?.[1] || "";
}

function boroughSlugFromBoard(canonicalId) {
  const id = canonicalIdOf(canonicalId).replace(/-borough-board$/, "");
  return REVIEWED_BOROUGH_BOARDS.some((row) => row.borough_slug === id) ? id : "";
}

function link(fields) {
  return Object.freeze({
    relation_id: fields.relation_id,
    verb: fields.verb,
    object_id: fields.object_id,
    object_name: fields.object_name,
    object_kind: fields.object_kind,
    href: fields.href,
    explanation: fields.explanation,
    boundary: fields.boundary,
    source: Object.freeze({
      citation: fields.source.citation,
      source_url: fields.source.url || fields.source.source_url,
    }),
  });
}

function planningLinks(canonicalId) {
  if (canonicalId === DCP) {
    return [
      link({
        relation_id: "staffs",
        verb: "Staffs",
        object_id: CPC,
        object_name: displayNameOf(CPC),
        object_kind: "commission",
        href: `/agencies/${CPC}/`,
        explanation: "Department staff assist the City Planning Commission.",
        boundary: "Staffing the commission is not the same as holding its hearings or votes, and is not a general power to direct it.",
        source: SOURCE.charter_191,
      }),
      link({
        relation_id: "director_chairs",
        verb: "Its director chairs",
        object_id: CPC,
        object_name: displayNameOf(CPC),
        object_kind: "commission",
        href: `/agencies/${CPC}/`,
        explanation: "The department's director also chairs the City Planning Commission.",
        boundary: "Chairing the commission is a sourced role of the director, not proof that the department controls every commission decision.",
        source: SOURCE.charter_191,
      }),
    ];
  }
  if (canonicalId === CPC) {
    return [
      link({
        relation_id: "has_staffing_from",
        verb: "Staffed by",
        object_id: DCP,
        object_name: displayNameOf(DCP),
        object_kind: "department",
        href: `/agencies/${DCP}/`,
        explanation: "The Department of City Planning staffs this commission.",
        boundary: "Shared staffing does not make the department and the commission the same body.",
        source: SOURCE.charter_191,
      }),
      link({
        relation_id: "chaired_by_director_of",
        verb: "Chaired by the director of",
        object_id: DCP,
        object_name: displayNameOf(DCP),
        object_kind: "department",
        href: `/agencies/${DCP}/`,
        explanation: "The director of City Planning chairs this commission.",
        boundary: "That chairing role is not a general power of the department over the commission's hearings and votes.",
        source: SOURCE.cpc_about,
      }),
    ];
  }
  return [];
}

function mtaLinks(canonicalId) {
  if (canonicalId === MTA) {
    return MTA_OPERATING_BODIES.map((objectId) => link({
      relation_id: "lists_operating_body",
      verb: "Lists as an operating body",
      object_id: objectId,
      object_name: displayNameOf(objectId),
      object_kind: "operating_body",
      href: `/agencies/${objectId}/`,
      explanation: "The authority's own directory lists this as a distinct operating body.",
      boundary: "Being listed there does not give this body the authority's legal form.",
      source: SOURCE.mta_agencies,
    }));
  }
  if (MTA_OPERATING_BODIES.includes(canonicalId)) {
    return [link({
      relation_id: "listed_as_operating_body_of",
      verb: "Listed by",
      object_id: MTA,
      object_name: displayNameOf(MTA),
      object_kind: "public_benefit_corporation",
      href: `/agencies/${MTA}/`,
      explanation: "The MTA lists this as one of its operating bodies.",
      boundary: "That listing does not make this body inherit the authority's public-benefit-corporation form.",
      source: SOURCE.mta_agencies,
    })];
  }
  return [];
}

function boroughOfficeLinks(canonicalId) {
  const slug = boroughSlugFromOffice(canonicalId);
  if (!slug || !PUBLISHED_BOROUGH_OFFICES.has(canonicalId)) return [];
  const board = REVIEWED_BOROUGH_BOARDS.find((row) => row.borough_slug === slug);
  const rows = [];
  if (board) {
    rows.push(link({
      relation_id: "chairs_body",
      verb: "Chairs",
      object_id: boroughBoardCanonicalId(slug),
      object_name: board.canonical_name,
      object_kind: "board",
      href: boroughBoardHref(slug),
      explanation: `The borough president chairs the ${board.canonical_name}.`,
      boundary: "Chairing the board is not a power to direct every board decision.",
      source: SOURCE.charter_85,
    }));
  }
  if (canonicalId === BROOKLYN_OFFICE_CANONICAL_ID) {
    const boardName = "Brooklyn Community Board 15";
    rows.push(link({
      relation_id: "appoints_members_of",
      verb: "Appoints members of",
      object_id: BROOKLYN_CB15_BODY_ID,
      object_name: boardName,
      object_kind: "community_board",
      href: `/community-boards/${BROOKLYN_CB15_BODY_ID}/`,
      explanation: "Charter § 2800 gives borough presidents a power to appoint community board members.",
      boundary: "A power of appointment is not a list of current members, and it is not a general power to direct every board decision.",
      source: SOURCE.charter_2800,
    }));
  }
  rows.push(link({
    relation_id: "serves_territory",
    verb: "Serves the borough of",
    object_id: `geography:borough:${slug}`,
    object_name: board?.borough || slug,
    object_kind: "geography",
    href: boroughGeographyHref(slug),
    explanation: "The office serves this borough. The borough is a place, not the office or the borough board.",
    boundary: "Shared geography does not merge the office, the borough board, a Community Board, or the place.",
    source: SOURCE.charter_85,
  }));
  return rows;
}

function boroughBoardLinks(canonicalId) {
  const slug = boroughSlugFromBoard(canonicalId);
  if (!slug) return [];
  const board = REVIEWED_BOROUGH_BOARDS.find((row) => row.borough_slug === slug);
  if (!board) return [];
  const officeId = officeIdForBorough(slug);
  const rows = [];
  if (PUBLISHED_BOROUGH_OFFICES.has(officeId)) {
    rows.push(link({
      relation_id: "body_chaired_by",
      verb: "Chaired by",
      object_id: officeId,
      object_name: displayNameOf(officeId),
      object_kind: "elected_office",
      href: `/agencies/${officeId}/`,
      explanation: "The borough president chairs this board.",
      boundary: "The office, this board, Community Boards and the borough are different destinations. Chairing is not general control.",
      source: SOURCE.charter_85,
    }));
  }
  if (slug === "brooklyn") {
    rows.push(link({
      relation_id: "has_community_board_chair_seats",
      verb: "Has statutory seats for chairs of bodies such as",
      object_id: BROOKLYN_CB15_BODY_ID,
      object_name: "Brooklyn Community Board 15",
      object_kind: "community_board",
      href: `/community-boards/${BROOKLYN_CB15_BODY_ID}/`,
      explanation: "Charter § 85 gives community board chairs seats on the borough board.",
      boundary: "A statutory seat is not evidence of who currently occupies it, and this page does not name current members.",
      source: SOURCE.charter_85,
    }));
  }
  rows.push(link({
    relation_id: "serves_territory",
    verb: "Covers the borough of",
    object_id: `geography:borough:${slug}`,
    object_name: board.borough,
    object_kind: "geography",
    href: boroughGeographyHref(slug),
    explanation: "This board is a body. The borough is a place.",
    boundary: "The board is not the borough, and it is not the borough president's office.",
    source: SOURCE.charter_85,
  }));
  return rows;
}

function communityBoardLinks(canonicalId) {
  const match = canonicalId.match(/^([a-z]+(?:-[a-z]+)*)-cb-\d{2}$/);
  if (!match) return [];
  const slug = match[1] === "staten-island" ? "staten-island" : match[1];
  const board = REVIEWED_BOROUGH_BOARDS.find((row) => row.borough_slug === slug);
  const rows = [];
  if (canonicalId === BROOKLYN_CB15_BODY_ID && PUBLISHED_BOROUGH_OFFICES.has(BROOKLYN_OFFICE_CANONICAL_ID)) {
    rows.push(link({
      relation_id: "members_appointed_by",
      verb: "Members appointed by",
      object_id: BROOKLYN_OFFICE_CANONICAL_ID,
      object_name: displayNameOf(BROOKLYN_OFFICE_CANONICAL_ID),
      object_kind: "elected_office",
      href: `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`,
      explanation: "Borough presidents appoint community board members under Charter § 2800.",
      boundary: "That appointment authority is not a current roster and is not a general power to direct this board.",
      source: SOURCE.charter_2800,
    }));
  }
  if (board) {
    rows.push(link({
      relation_id: "chair_has_seat_on",
      verb: "Its chair has a statutory seat on",
      object_id: boroughBoardCanonicalId(slug),
      object_name: board.canonical_name,
      object_kind: "board",
      href: boroughBoardHref(slug),
      explanation: "Community board chairs sit on the borough board.",
      boundary: "The statute describes a seat, not the person who currently holds it.",
      source: SOURCE.charter_85,
    }));
  }
  const placeHref = communityBoardPlaceHref(canonicalId);
  if (placeHref) {
    rows.push(link({
      relation_id: "covers_district",
      verb: "Covers a community district in",
      object_id: `geography:community-district:${canonicalId}`,
      object_name: board?.borough || slug,
      object_kind: "geography",
      href: placeHref,
      explanation: "This Community Board is a body. Its district is a place.",
      boundary: "The board is not the district, and it is not the borough board or the borough president's office.",
      source: SOURCE.charter_2800,
    }));
  }
  return rows;
}

/**
 * The sourced relationship links a reader can follow from one institution.
 * Returns null when there is nothing sourced to show.
 */
export function projectRelatedPublicBodies(value) {
  const canonicalId = canonicalIdOf(value);
  if (!canonicalId) return null;
  const links = Object.freeze([
    ...planningLinks(canonicalId),
    ...mtaLinks(canonicalId),
    ...boroughOfficeLinks(canonicalId),
    ...boroughBoardLinks(canonicalId),
    ...communityBoardLinks(canonicalId),
  ]);
  if (!links.length) return null;
  return Object.freeze({
    schema: RELATED_PUBLIC_BODIES_SCHEMA,
    method: RELATED_PUBLIC_BODIES_METHOD,
    canonical_id: canonicalId,
    negative_rule: RELATED_PUBLIC_BODIES_NEGATIVE_RULE,
    links,
  });
}

function renderLink(row) {
  return `<li class="related-public-bodies-item" data-relation="${esc(row.relation_id)}" data-object-id="${esc(row.object_id)}" data-object-kind="${esc(row.object_kind)}">
    <p class="related-public-bodies-statement">
      <span class="related-public-bodies-verb">${esc(row.verb)}</span>
      <a class="ui-constellation-link agency-edge-link related-public-bodies-link" href="${esc(row.href)}">${esc(row.object_name)}</a>
    </p>
    <p class="muted node-muted related-public-bodies-explanation">${esc(row.explanation)} ${esc(row.boundary)}</p>
    <details class="related-public-bodies-source" data-related-source="1">
      <summary>Connection source</summary>
      <p>${esc(row.source.citation)}. ${esc(row.boundary)}</p>
      <p><a class="ui-constellation-link" href="${esc(row.source.source_url)}">${esc(row.source.citation)}</a></p>
    </details>
  </li>`;
}

/** First-paint relationship panel. Empty when the optional evidence is absent. */
export function renderRelatedPublicBodies(projection) {
  const links = projection?.links;
  if (!Array.isArray(links) || !links.length) return "";
  const body = `<p class="node-muted">These connections use the verb the source supports. Staffing, chairing, appointment or a directory listing is not a claim that one body controls the other.</p>
    <ul class="related-public-bodies-list">${links.map(renderLink).join("")}</ul>`;
  return renderNodeSection({
    heading: "Related public bodies",
    headingId: "related-public-bodies-heading",
    exportClass: "object_related_bodies",
    extraClass: "node-card civic-object-section related-public-bodies",
    attrs: {
      id: RELATED_PUBLIC_BODIES_ANCHOR,
      "data-related-bodies-schema": projection.schema,
      "data-related-count": String(links.length),
    },
    body,
  });
}

export function renderRelatedPublicBodiesFor(value) {
  return renderRelatedPublicBodies(projectRelatedPublicBodies(value));
}

function boroughBoardPurpose(board) {
  return `A borough board for ${board.borough}, with the borough president, the borough's council members and the community board chairs as statutory seats. Those seats are not a roster of current members.`;
}

/** Thin canonical document for a reviewed Borough Board identity. */
export function renderBoroughBoardDocument(board, options = {}) {
  const row = typeof board === "string"
    ? REVIEWED_BOROUGH_BOARDS.find((item) => item.borough_slug === canonicalIdOf(board) || boroughBoardCanonicalId(item.borough_slug) === canonicalIdOf(board))
    : board;
  if (!row?.borough_slug) return "";
  const canonicalId = boroughBoardCanonicalId(row.borough_slug);
  const related = projectRelatedPublicBodies(canonicalId);
  const title = row.canonical_name;
  const path = boroughBoardHref(row.borough_slug);
  const assetPrefix = options.assetPrefix || "/";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CityScroll</title>
<meta name="description" content="${esc(boroughBoardPurpose(row))}">
<link rel="canonical" href="https://cityscroll.org${esc(path)}">${renderCivicDocumentAssets(assetPrefix)}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
<main id="main" class="node-document civic-object-document" data-civic-object-kind="borough-board" data-subject-ref="${esc(row.id)}" data-canonical-id="${esc(canonicalId)}" data-node-document="1">
${renderNodeBack({ href: "/agencies/", label: "Back to agencies", extraClass: "civic-object-back" })}
<header class="node-hero civic-object-hero" data-export-class="object_identity">
  <p class="node-kicker civic-object-kicker">Borough board</p>
  <h1>${esc(title)}</h1>
  <div class="institution-resident-identity" id="institution-resident-identity" data-canonical-id="${esc(canonicalId)}" data-kind-label="Borough board">
    <p class="institution-statutory-kind"><span class="institution-statutory-kind-label">Borough board</span> · ${esc(boroughBoardPurpose(row))}</p>
  </div>
</header>
${renderRelatedPublicBodies(related)}
<details class="related-public-bodies-source" data-related-source="1" id="borough-board-composition">
  <summary>Board composition</summary>
  <p>${esc(SOURCE.charter_85.citation)} establishes borough boards with the borough president, the borough's council members, and the community board chairs. That is a description of seats, not a list of the people who currently hold them.</p>
  <p><a class="ui-constellation-link" href="${esc(SOURCE.charter_85.url)}">${esc(SOURCE.charter_85.citation)}</a></p>
</details>
</main>
${renderNodeFooter({ extraClass: "civic-object-footer" })}
</body></html>`;
  return gateNodePageRender(html);
}

export function reviewedBoroughBoardDestinations() {
  return Object.freeze(REVIEWED_BOROUGH_BOARDS.map((row) => Object.freeze({
    canonical_id: boroughBoardCanonicalId(row.borough_slug),
    name: row.canonical_name,
    href: boroughBoardHref(row.borough_slug),
    subject_ref: row.id,
    borough_slug: row.borough_slug,
  })));
}

export { SOURCE as RELATED_PUBLIC_BODY_SOURCES, MTA_OPERATING_BODIES };
