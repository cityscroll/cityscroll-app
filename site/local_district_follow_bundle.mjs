/**
 * The reviewed Follow this district bundle.
 *
 * This is deliberately a template builder, not a second subscription engine. It
 * produces the child payload consumed by /subscribe-pack; each child remains an
 * ordinary, exact-scope watch and the server supplies the one digest rollup.
 */
import {
  normalizeScope,
  watchFromGeographyScope,
} from "./scope_v0.mjs";
import {
  communityBoardIdFromSelection,
  communityBoardLabel,
  normalizeCommunityBoardRef,
} from "./community_board_watch.mjs";
import { normalizeFilter, monitorPackSubscribePayload } from "./watch_templates.mjs";

export const LOCAL_DISTRICT_FOLLOW_BUNDLE_ID = "local-district-follow";
export const LOCAL_DISTRICT_SUPPORTED_LENSES = Object.freeze([
  "land", "property", "rules", "money",
]);
export const LOCAL_DISTRICT_UNSUPPORTED_LENSES = Object.freeze([
  "people", "entity", "award", "district", "legal_code", "mandates", "obligations",
]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boardRef(input) {
  const direct = normalizeCommunityBoardRef(input?.communityBoard || input?.board);
  if (direct) return direct;
  const bodyId = clean(input?.body_id || input?.bodyId);
  if (/^[a-z-]+-cb-\d{2}$/i.test(bodyId)) return normalizeCommunityBoardRef(`community-board:${bodyId}`);
  if (input?.borough && input?.number != null) {
    return communityBoardIdFromSelection(input.borough, input.number);
  }
  return null;
}

function districtKey(scope) {
  const normalized = normalizeScope(scope);
  const district = normalized.place.community_districts[0];
  return district ? `geography:community_district:${district}` : null;
}

/**
 * Build the exact reviewed children for one community district.
 * Unsupported lenses are returned as disclosure metadata and never become children.
 */
export function buildLocalDistrictFollowBundle(input = {}) {
  const scope = normalizeScope(input.scope || input);
  const geography = districtKey(scope);
  const board = boardRef(input);
  const requested = Array.isArray(input.supportedLenses)
    ? input.supportedLenses.map(clean).filter(Boolean)
    : [...LOCAL_DISTRICT_SUPPORTED_LENSES];
  const admitted = [...new Set(requested)].filter((lens) => LOCAL_DISTRICT_SUPPORTED_LENSES.includes(lens));
  const unsupported = [...new Set([
    ...LOCAL_DISTRICT_UNSUPPORTED_LENSES,
    ...requested.filter((lens) => !LOCAL_DISTRICT_SUPPORTED_LENSES.includes(lens)),
  ])];
  const children = [];
  if (board && geography) {
    const meetings = watchFromGeographyScope(scope, { lens: "meetings" });
    meetings.filter = normalizeFilter({ ...meetings.filter, communityBoard: board, geographies: [geography] });
    children.push({
      label: `${communityBoardLabel(board) || board} meetings`,
      lens: "meetings",
      filter: meetings.filter,
    });
    for (const lens of admitted) {
      const watch = watchFromGeographyScope(scope, { lens });
      const filter = normalizeFilter({ ...watch.filter, geographies: [geography] });
      children.push({ label: `${lens} in this district`, lens, filter });
    }
  }
  return {
    id: LOCAL_DISTRICT_FOLLOW_BUNDLE_ID,
    title: "Follow this district",
    description: "One digest with the exact board meetings and supported local activity for this district.",
    district: scope.place.community_districts[0] || null,
    board,
    geography,
    children,
    supported_lenses: admitted,
    unsupported_lenses: unsupported,
    unavailable: !geography ? "Choose a community district first." : !board ? "The covering Community Board is not identified in the retained geography sources." : null,
  };
}

export function localDistrictFollowPayload(input, options = {}) {
  const bundle = input?.children ? input : buildLocalDistrictFollowBundle(input);
  return monitorPackSubscribePayload({ ...bundle, watches: bundle.children }, options);
}

export function localDistrictFollowDisclosure(bundle) {
  const value = bundle || buildLocalDistrictFollowBundle({});
  return {
    title: value.title,
    frequency: "one weekly digest",
    included: value.children.map((child) => ({ label: child.label, lens: child.lens, scope: child.filter })),
    omitted: value.unsupported_lenses || [],
    unavailable: value.unavailable,
  };
}
