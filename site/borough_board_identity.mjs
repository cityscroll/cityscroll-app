/**
 * Reviewed five-borough Borough Board identity table.
 *
 * This is a civic-institution reference, not a public roster or recommendation
 * source. Land affected-review-body edges consume these ids.
 */

export const BOROUGH_BOARD_IDENTITY_BASIS = "NYC Charter § 85";
export const BOROUGH_BOARD_IDENTITY_SOURCE_URL =
  "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-512";
export const BOROUGH_BOARD_ID = /^borough-board:([a-z]+(?:-[a-z]+)*)$/;

const BOROUGH_BOARD_ROWS = Object.freeze([
  Object.freeze({ slug: "bronx", borough: "Bronx" }),
  Object.freeze({ slug: "brooklyn", borough: "Brooklyn" }),
  Object.freeze({ slug: "manhattan", borough: "Manhattan" }),
  Object.freeze({ slug: "queens", borough: "Queens" }),
  Object.freeze({ slug: "staten-island", borough: "Staten Island" }),
]);

export const REVIEWED_BOROUGH_BOARDS = Object.freeze(BOROUGH_BOARD_ROWS.map((row) => Object.freeze({
  id: `borough-board:${row.slug}`,
  civic_institution_id: `civic-institution:${row.slug}-borough-board`,
  borough: row.borough,
  borough_slug: row.slug,
  canonical_name: `${row.borough} Borough Board`,
  legal_basis: Object.freeze({
    citation: BOROUGH_BOARD_IDENTITY_BASIS,
    source_url: BOROUGH_BOARD_IDENTITY_SOURCE_URL,
  }),
})));

const BY_SLUG = new Map(REVIEWED_BOROUGH_BOARDS.map((row) => [row.borough_slug, row]));
const BY_NAME = new Map(REVIEWED_BOROUGH_BOARDS.map((row) => [row.borough.toLowerCase(), row]));

export function boroughBoardIdentity(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase().replace(/^borough-board:/, "");
  return BY_SLUG.get(text) || BY_NAME.get(text) || null;
}

export function parseBoroughBoardIdentity(value) {
  const id = String(value ?? "").trim();
  const match = id.match(BOROUGH_BOARD_ID);
  if (!match) return null;
  return boroughBoardIdentity(match[1]);
}
