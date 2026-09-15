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

const DIGEST_SECTION_LABELS = Object.freeze({
  meetings: "Community Board meetings",
  land: "Land and zoning",
  property: "Property",
  rules: "Rules and notices",
  money: "City contracts",
});

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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

/** Canonical identity for the child predicate, independent of email or cadence. */
export function canonicalLocalDistrictFollowWatchId(child) {
  const input = stableStringify({ lens: child?.lens, filter: child?.filter || {} });
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `local-district-watch:${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
  for (const child of children) child.id = canonicalLocalDistrictFollowWatchId(child);
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

/**
 * Apply every missing child through the caller's storage function. A successful
 * child is retained in the supplied ID set so a later pass cannot recreate it.
 */
export async function applyLocalDistrictFollowBundle(bundle, createChild, existingIds = []) {
  if (typeof createChild !== "function" || !bundle?.children?.length) {
    return { status: "invalid", created: [], failed: [], remaining: bundle?.children || [], digest: localDistrictFollowDigest(bundle) };
  }
  const existing = new Set(existingIds);
  const created = [], failed = [], remaining = [];
  for (const child of bundle.children) {
    if (existing.has(child.id)) continue;
    try {
      await createChild(child);
      existing.add(child.id);
      created.push(child.id);
    } catch (error) {
      failed.push({ id: child.id, reason: clean(error?.message || "creation failed") });
      remaining.push(child);
    }
  }
  return {
    status: failed.length ? (created.length ? "partial" : "failed") : "created",
    created,
    failed,
    remaining,
    digest: localDistrictFollowDigest(bundle),
  };
}

/** Materialize one immutable source snapshot for both preview and delivery. */
export function materializeLocalDistrictFollowSnapshot(bundle, snapshot = {}) {
  const rowsById = snapshot?.children && typeof snapshot.children === "object"
    ? snapshot.children
    : snapshot;
  return {
    snapshot_id: clean(snapshot?.snapshot_id) || "local-district-follow-snapshot",
    children: (bundle?.children || []).map((child) => ({
      id: child.id,
      lens: child.lens,
      label: child.label,
      items: Array.isArray(rowsById?.[child.id]) ? rowsById[child.id] : [],
    })),
  };
}

function localDistrictFollowDigest(bundle, snapshot = {}) {
  const materialized = materializeLocalDistrictFollowSnapshot(bundle, snapshot);
  return {
    title: "District activity digest",
    snapshot_id: materialized.snapshot_id,
    sections: materialized.children.map((child) => ({
      label: DIGEST_SECTION_LABELS[child.lens] || child.label,
      watch_id: child.id,
      items: child.items,
    })),
  };
}

export function previewLocalDistrictFollow(bundle, snapshot = {}) {
  return { mode: "preview", ...localDistrictFollowDigest(bundle, snapshot) };
}

export function deliverLocalDistrictFollow(bundle, snapshot = {}) {
  return { mode: "delivery", ...localDistrictFollowDigest(bundle, snapshot) };
}
