/** Canonical Community Board identity and watch-picker helpers. */

var COMMUNITY_BOARD_BOROUGH_SLUGS = Object.freeze({
  Manhattan: "manhattan",
  Bronx: "bronx",
  Brooklyn: "brooklyn",
  Queens: "queens",
  "Staten Island": "staten-island",
});
var COMMUNITY_BOARD_BOROUGH_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(COMMUNITY_BOARD_BOROUGH_SLUGS).map(([name, slug]) => [slug, name]),
));
var BOARD_REF = /^community-board:([a-z]+(?:-[a-z]+)*-cb-(\d{2}))$/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boroughName(value) {
  const wanted = clean(value).toLowerCase();
  return Object.keys(COMMUNITY_BOARD_BOROUGH_SLUGS).find((name) => name.toLowerCase() === wanted)
    || COMMUNITY_BOARD_BOROUGH_NAMES[wanted]
    || null;
}

/** Resolve the picker’s borough + board number to the exact institution ref. */
export function communityBoardIdFromSelection(borough, number) {
  const name = boroughName(borough);
  const n = Number(number);
  if (!name || !Number.isInteger(n) || n < 1 || n > 18) return null;
  return `community-board:${COMMUNITY_BOARD_BOROUGH_SLUGS[name]}-cb-${String(n).padStart(2, "0")}`;
}

/** Accept only a canonical, borough-qualified Community Board identity. */
export function normalizeCommunityBoardRef(value) {
  const match = clean(value).match(BOARD_REF);
  if (!match) return null;
  const [, id, number] = match;
  const borough = id.slice(0, -`-cb-${number}`.length);
  return communityBoardIdFromSelection(borough, Number(number));
}

/** Resident-facing name for an exact Community Board identity. */
export function communityBoardLabel(value) {
  const ref = normalizeCommunityBoardRef(value);
  if (!ref) return null;
  const match = ref.match(/^community-board:(.+)-cb-(\d{2})$/);
  if (!match) return null;
  const borough = COMMUNITY_BOARD_BOROUGH_NAMES[match[1]];
  return borough ? `${borough} Community Board ${Number(match[2])}` : null;
}

export function communityBoardSelectionFromRef(value) {
  const ref = normalizeCommunityBoardRef(value);
  if (!ref) return { borough: "", number: "" };
  const match = ref.match(/^community-board:(.+)-cb-(\d{2})$/);
  return {
    borough: COMMUNITY_BOARD_BOROUGH_NAMES[match[1]] || "",
    number: String(Number(match[2])),
  };
}

export var COMMUNITY_BOARD_PICKER_BOROUGHS = Object.freeze(Object.keys(COMMUNITY_BOARD_BOROUGH_SLUGS));
export var COMMUNITY_BOARD_PICKER_NUMBERS = Object.freeze(Array.from({ length: 18 }, (_, i) => String(i + 1)));
