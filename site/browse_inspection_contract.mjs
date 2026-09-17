/**
 * Maintained browsing-continuity contract for resident collection surfaces.
 *
 * Semantic authority for affordance roles stays in `affordance_grammar.mjs`.
 * Calendar preview and browse-return remain their existing owners. This module
 * states what every browsing renderer or host must declare — primary intent,
 * domain adapter, canonical destination policy, detail host, restoration
 * adapter, and journey ownership — and keeps a fingerprinted legacy baseline
 * that can only shrink.
 */

import { createHash } from "node:crypto";
import { AFFORDANCE_ACTION_ROLES } from "./affordance_grammar.mjs";

export const BROWSE_INSPECTION_CONTRACT_ID = "cityscroll.browse_inspection_contract.v1";
export const BROWSE_INSPECTION_CATALOG_SCHEMA = "cityscroll.browse_inspection_catalog.v1";
export { AFFORDANCE_ACTION_ROLES };

/** Principles every browsing surface must satisfy or declare as legacy. */
export const BROWSE_INSPECTION_PRINCIPLES = Object.freeze({
  overview:
    "Show a scannable overview: faithful title, kind, relevant agency or board, honest date or time precision, and distinguishing status or place when available.",
  useful_inspection:
    "The enhanced primary control inspects in place and adds decision-relevant facts from existing CityScroll read models rather than repeating title and date alone.",
  explicit_navigation_and_actions:
    "Full-record destinations and consequential actions are separately named controls with native link behavior; inspection never submits, saves, subscribes, or opens a publisher.",
  coherent_restoration:
    "Dismiss and Back restore applicable scope, query, view, selection, and useful focus through existing route and history owners.",
  identity:
    "Domain adapters retain canonical IDs, provenance, and distinct absent, failed, and negative states without inventing joins, times, or approvals.",
  failure:
    "Failed detail keeps the last coherent summary and explicit record link, announces failure plainly, and allows recovery without diagnostic fields.",
  accessibility:
    "Modal hosts expose an accessible name, inert background, keyboard reachability, Escape, visible Close, and return focus; nonmodal panels do not claim modality or trap focus.",
});

/**
 * Closed primary-intent vocabulary for a browsing renderer or host.
 * `inspect` is the default for collections of civic objects.
 * `directory_navigation` is ordinary navigation whose sole purpose is travel.
 * `act` names an explicit consequential action that stays direct.
 */
export const BROWSE_PRIMARY_INTENTS = Object.freeze([
  "inspect",
  "directory_navigation",
  "act",
]);

/**
 * Closed classification vocabulary.
 * `conforming` meets the contract.
 * `legacy` is admitted only through the shrinking baseline.
 * `directory_navigation` is ordinary navigation with a semantic reason.
 */
export const BROWSE_CLASSIFICATIONS = Object.freeze([
  "conforming",
  "legacy",
  "directory_navigation",
]);

/** Closed detail-host vocabulary for where inspection appears. */
export const BROWSE_DETAIL_HOSTS = Object.freeze([
  "modal_preview",
  "selection_panel",
  "inline_detail",
  "day_agenda",
  "none_directory",
]);

/** Compact-calendar host ids — the eight shared month mounts. */
export const COMPACT_CALENDAR_HOST_IDS = Object.freeze([
  "calendar-host-now",
  "calendar-host-community-boards",
  "calendar-host-rules",
  "calendar-host-land-projects",
  "calendar-host-legislative-matters",
  "calendar-host-exams",
  "calendar-host-procurement",
  "calendar-host-property",
]);

/**
 * Stable identity fingerprint for one baseline entry. Content markers are
 * checked separately so unrelated source edits are not confused with admission
 * of a new legacy exception.
 */
export function baselineEntryFingerprint({ id, path, reason, marker }) {
  return createHash("sha256")
    .update(`${id}\0${path}\0${reason}\0${marker}`, "utf8")
    .digest("hex");
}

function freezeSurface(row) {
  return Object.freeze({
    ...row,
    principles: Object.freeze([...(row.principles || Object.keys(BROWSE_INSPECTION_PRINCIPLES))]),
  });
}

/**
 * Audited browsing families from the continuity findings, plus the eight
 * compact-calendar hosts and one positive directory-navigation control.
 */
export const BROWSE_INSPECTION_SURFACES = Object.freeze([
  freezeSurface({
    surface_id: "now-calendar",
    family: "now",
    kind: "collection",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/now_calendar.mjs",
    render_owner: "site/now_view.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/now/#now?calview=calendar",
  }),
  freezeSurface({
    surface_id: "now-cards",
    family: "now",
    kind: "collection",
    primary_intent: "inspect",
    classification: "legacy",
    domain_adapter: "site/now_view.mjs",
    render_owner: "site/primary_document_view.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "inline_detail",
    detail_host_module: "site/now_view.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/browse_inspection_contract.test.mjs",
    baseline_id: "now-card-title-navigates",
    route: "/now/",
  }),
  freezeSurface({
    surface_id: "contracts-money-list",
    family: "contracts",
    kind: "collection",
    primary_intent: "inspect",
    classification: "legacy",
    domain_adapter: "site/app/money-list.mjs",
    render_owner: "site/app/money-list.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "inline_detail",
    detail_host_module: "site/app/money-list.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/browse_inspection_contract.test.mjs",
    baseline_id: "contracts-row-click-diverges",
    route: "/browse/contracts/",
  }),
  freezeSurface({
    surface_id: "board-land-positions",
    family: "community_board",
    kind: "collection",
    primary_intent: "inspect",
    classification: "legacy",
    domain_adapter: "site/community_board_land_positions.mjs",
    render_owner: "site/community_board_land_positions.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "inline_detail",
    detail_host_module: "site/community_board_land_positions.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/browse_inspection_contract.test.mjs",
    baseline_id: "board-position-title-navigates",
    route: "/community-boards/brooklyn-cb-01/",
  }),
  freezeSurface({
    surface_id: "search-results",
    family: "search",
    kind: "collection",
    primary_intent: "inspect",
    classification: "legacy",
    domain_adapter: "site/search_document.mjs",
    render_owner: "site/universal_search_relevance_ux.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "inline_detail",
    detail_host_module: "site/search_document.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/browse_inspection_contract.test.mjs",
    baseline_id: "search-title-continues-collection",
    route: "/search/?q=shelter",
  }),
  freezeSurface({
    surface_id: "near-you-records",
    family: "near_you",
    kind: "collection",
    primary_intent: "inspect",
    classification: "legacy",
    domain_adapter: "site/near_you_view.mjs",
    render_owner: "site/near_you_view.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "inline_detail",
    detail_host_module: "site/near_you_view.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/browse_inspection_contract.test.mjs",
    baseline_id: "near-you-title-navigates",
    route: "/near-you",
  }),
  freezeSurface({
    surface_id: "near-you-scope",
    family: "near_you",
    kind: "scope",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/near_you_scope_adoption.mjs",
    render_owner: "site/app/map.mjs",
    canonical_destination_policy: "preserve_selected_place",
    detail_host: "inline_detail",
    detail_host_module: "site/app/map.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/near_you_scope_adoption.test.mjs",
    baseline_id: null,
    route: "/near-you?level=community_district&lens=people&boro=Brooklyn&cd=K15",
  }),
  freezeSurface({
    surface_id: "land-map-selection",
    family: "land",
    kind: "collection",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/land_map_selection.mjs",
    render_owner: "site/app/map_runtime.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "selection_panel",
    detail_host_module: "site/land_map_selection.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/land_selection_readable_authority.test.mjs",
    baseline_id: null,
    positive_fixture: "land-map-selection-panel",
    route: "/browse/zoning/?view=map",
  }),
  freezeSurface({
    surface_id: "calendar-host-now",
    family: "now",
    kind: "compact_calendar_host",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/now_calendar.mjs",
    render_owner: "site/now_view.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/now/#now?calview=calendar",
  }),
  freezeSurface({
    surface_id: "calendar-host-community-boards",
    family: "community_board",
    kind: "compact_calendar_host",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/community_board_constellation.mjs",
    render_owner: "site/community_board_constellation.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/community-boards/",
  }),
  freezeSurface({
    surface_id: "calendar-host-rules",
    family: "rules",
    kind: "compact_calendar_host",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/rules_calendar.mjs",
    render_owner: "site/app/rules.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/browse/rules/",
  }),
  freezeSurface({
    surface_id: "calendar-host-land-projects",
    family: "land",
    kind: "compact_calendar_host",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/land_project_connected_calendar.mjs",
    render_owner: "site/app/land.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/browse/zoning/",
  }),
  freezeSurface({
    surface_id: "calendar-host-legislative-matters",
    family: "legislative",
    kind: "compact_calendar_host",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/legislative_matter_calendar.mjs",
    render_owner: "site/legislative_matter_document.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/matters/",
  }),
  freezeSurface({
    surface_id: "calendar-host-exams",
    family: "exams",
    kind: "compact_calendar_host",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/exam_calendar.mjs",
    render_owner: "site/exam_document.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/browse/exams/",
  }),
  freezeSurface({
    surface_id: "calendar-host-procurement",
    family: "contracts",
    kind: "compact_calendar_host",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/opportunity_calendar.mjs",
    render_owner: "site/procurement_document.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/browse/contracts/",
  }),
  freezeSurface({
    surface_id: "calendar-host-property",
    family: "property",
    kind: "compact_calendar_host",
    primary_intent: "inspect",
    classification: "conforming",
    domain_adapter: "site/app/property.mjs",
    render_owner: "site/app/property.mjs",
    canonical_destination_policy: "explicit_full_record_link",
    detail_host: "modal_preview",
    detail_host_module: "site/calendar_event_preview.mjs",
    restoration_adapter: "site/browse_return_context.mjs",
    journey_owner: "test/calendar_primary_inspection.test.mjs",
    baseline_id: null,
    route: "/browse/property/",
  }),
  freezeSurface({
    surface_id: "agency-directory",
    family: "agency",
    kind: "directory",
    primary_intent: "directory_navigation",
    classification: "directory_navigation",
    domain_adapter: "site/agency_directory.mjs",
    render_owner: "site/agency_directory.mjs",
    canonical_destination_policy: "directory_entry_navigation",
    detail_host: "none_directory",
    detail_host_module: null,
    restoration_adapter: null,
    journey_owner: "test/browse_inspection_contract.test.mjs",
    baseline_id: null,
    semantic_reason:
      "The public-body directory's sole purpose is navigation to agency and community-board documents; it is not a collection of inspectable result rows.",
    positive_fixture: "agency-directory-navigation",
    route: "/agencies/",
  }),
]);

/**
 * Fingerprinted legacy baseline. Entries may only be removed once their marker
 * no longer appears in the named source. New entries are rejected.
 */
export const BROWSE_INSPECTION_LEGACY_BASELINE = Object.freeze([
  Object.freeze({
    id: "now-card-title-navigates",
    path: "site/now_view.mjs",
    marker: "nowCardHTML",
    reason:
      "Now card projections still expose the title as a direct navigational link rather than a primary inspect control.",
    fingerprint: null,
  }),
  Object.freeze({
    id: "contracts-row-click-diverges",
    path: "site/app/money-list.mjs",
    marker: "moneyListInteractionProjection",
    reason:
      "Contracts rows still diverge between title navigation, row selection, and source-native branches for the same collection.",
    fingerprint: null,
  }),
  Object.freeze({
    id: "board-position-title-navigates",
    path: "site/community_board_land_positions.mjs",
    marker: "positionMarkup",
    reason:
      "Board land positions keep rich inspection behind a secondary control while the project title navigates away.",
    fingerprint: null,
  }),
  Object.freeze({
    id: "search-title-continues-collection",
    path: "site/search_document.mjs",
    marker: "buildSearchLensHandoffHref",
    reason:
      "Search result titles can hand a reader into another collection instead of inspecting the exact result identity.",
    fingerprint: null,
  }),
  Object.freeze({
    id: "near-you-title-navigates",
    path: "site/near_you_view.mjs",
    marker: "recordCard",
    reason:
      "Near You record cards still lead with linked titles and geographic evidence before staged inspection.",
    fingerprint: null,
  }),
].map((entry) => Object.freeze({
  ...entry,
  fingerprint: baselineEntryFingerprint(entry),
})));

export const BROWSE_INSPECTION_JOURNEY = Object.freeze({
  id: "browse-inspection-contract-enforcement",
  sequence: Object.freeze([
    "declare_surface",
    "classify_intent",
    "reject_undeclared",
    "reject_baseline_growth",
    "accept_directory_navigation",
    "record_assertions",
  ]),
  rendered_reference: Object.freeze({
    route: "component-harness:browse-return-context",
    harness: "test/harness/browse_return_harness.html",
    assertion:
      "set scope or view, inspect, dismiss, open the explicit full record, return with Back, and continue from the restored collection state",
    variants: Object.freeze([
      "desktop",
      "narrow_touch",
      "keyboard",
      "no_javascript",
      "failed_detail",
    ]),
  }),
});

function requireText(value, label, problems) {
  if (typeof value !== "string" || !value.trim()) {
    problems.push(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

/**
 * Project the maintained inventory into the resident-surface catalog shape.
 */
export function browseInspectionCatalogProjection({
  surfaces = BROWSE_INSPECTION_SURFACES,
  baseline = BROWSE_INSPECTION_LEGACY_BASELINE,
  principles = BROWSE_INSPECTION_PRINCIPLES,
} = {}) {
  return Object.freeze({
    schema: BROWSE_INSPECTION_CATALOG_SCHEMA,
    contract_id: BROWSE_INSPECTION_CONTRACT_ID,
    principles: Object.freeze({ ...principles }),
    primary_intents: BROWSE_PRIMARY_INTENTS,
    classifications: BROWSE_CLASSIFICATIONS,
    detail_hosts: BROWSE_DETAIL_HOSTS,
    compact_calendar_host_ids: COMPACT_CALENDAR_HOST_IDS,
    surfaces: Object.freeze(surfaces.map((row) => Object.freeze({ ...row }))),
    legacy_baseline: Object.freeze(baseline.map((row) => Object.freeze({ ...row }))),
    journey: BROWSE_INSPECTION_JOURNEY,
  });
}

/**
 * Validate the browsing contract inventory and optional source probes.
 *
 * @param {object} opts
 * @param {Array} [opts.surfaces]
 * @param {Array} [opts.baseline]
 * @param {object} [opts.principles]
 * @param {Map<string,string>|Record<string,string>} [opts.sourceTexts] path -> source text
 * @param {Array} [opts.committedBaseline] previously admitted baseline; growth is rejected
 * @param {Iterable<string>} [opts.declaredSurfaceIds] ids that must be declared when provided
 */
export function validateBrowseInspectionContract({
  surfaces = BROWSE_INSPECTION_SURFACES,
  baseline = BROWSE_INSPECTION_LEGACY_BASELINE,
  principles = BROWSE_INSPECTION_PRINCIPLES,
  sourceTexts = null,
  committedBaseline = BROWSE_INSPECTION_LEGACY_BASELINE,
  declaredSurfaceIds = null,
} = {}) {
  const problems = [];

  for (const key of Object.keys(BROWSE_INSPECTION_PRINCIPLES)) {
    if (!principles?.[key] || typeof principles[key] !== "string") {
      problems.push(`principle missing prose: ${key}`);
    }
  }

  const surfaceIds = new Set();
  const baselineIds = new Set((baseline || []).map((entry) => entry.id));
  const calendarHosts = [];

  for (const surface of surfaces || []) {
    if (!requireText(surface.surface_id, "surface_id", problems)) continue;
    if (surfaceIds.has(surface.surface_id)) {
      problems.push(`duplicate browsing surface: ${surface.surface_id}`);
    }
    surfaceIds.add(surface.surface_id);

    if (!BROWSE_PRIMARY_INTENTS.includes(surface.primary_intent)) {
      problems.push(`unsupported primary intent for ${surface.surface_id}: ${surface.primary_intent}`);
    }
    if (!BROWSE_CLASSIFICATIONS.includes(surface.classification)) {
      problems.push(`unsupported classification for ${surface.surface_id}: ${surface.classification}`);
    }
    if (!BROWSE_DETAIL_HOSTS.includes(surface.detail_host)) {
      problems.push(`unsupported detail host for ${surface.surface_id}: ${surface.detail_host}`);
    }
    if (!requireText(surface.domain_adapter, `domain adapter for ${surface.surface_id}`, problems)) {
      /* already recorded */
    }
    if (!requireText(surface.render_owner, `render owner for ${surface.surface_id}`, problems)) {
      /* already recorded */
    }
    if (!requireText(surface.canonical_destination_policy, `canonical destination for ${surface.surface_id}`, problems)) {
      /* already recorded */
    }
    if (!requireText(surface.journey_owner, `journey owner for ${surface.surface_id}`, problems)) {
      /* already recorded */
    }

    if (surface.classification === "legacy") {
      if (!surface.baseline_id || !baselineIds.has(surface.baseline_id)) {
        problems.push(`legacy surface lacks baseline entry: ${surface.surface_id}`);
      }
    } else if (surface.baseline_id) {
      problems.push(`non-legacy surface must not claim a baseline id: ${surface.surface_id}`);
    }

    if (surface.classification === "directory_navigation") {
      if (surface.primary_intent !== "directory_navigation") {
        problems.push(`directory classification requires directory_navigation intent: ${surface.surface_id}`);
      }
      if (!surface.semantic_reason || !String(surface.semantic_reason).trim()) {
        problems.push(`directory navigation lacks semantic reason: ${surface.surface_id}`);
      }
      if (!surface.positive_fixture || !String(surface.positive_fixture).trim()) {
        problems.push(`directory navigation lacks positive fixture: ${surface.surface_id}`);
      }
      if (surface.detail_host !== "none_directory") {
        problems.push(`directory navigation must use none_directory host: ${surface.surface_id}`);
      }
    }

    if (surface.kind === "compact_calendar_host") {
      calendarHosts.push(surface.surface_id);
    }

    if (surface.restoration_adapter == null && surface.classification !== "directory_navigation") {
      problems.push(`browsing surface lacks restoration adapter: ${surface.surface_id}`);
    }
  }

  for (const hostId of COMPACT_CALENDAR_HOST_IDS) {
    if (!surfaceIds.has(hostId)) {
      problems.push(`compact calendar host missing from inventory: ${hostId}`);
    }
  }
  for (const hostId of calendarHosts) {
    if (!COMPACT_CALENDAR_HOST_IDS.includes(hostId)) {
      problems.push(`unknown compact calendar host declared: ${hostId}`);
    }
  }

  const auditedFamilies = [
    "now-calendar",
    "now-cards",
    "contracts-money-list",
    "board-land-positions",
    "search-results",
    "near-you-records",
    "near-you-scope",
    "land-map-selection",
  ];
  for (const id of auditedFamilies) {
    if (!surfaceIds.has(id)) problems.push(`audited browsing family missing: ${id}`);
  }

  const committedIds = new Set((committedBaseline || []).map((entry) => entry.id));
  const seenBaseline = new Set();
  for (const entry of baseline || []) {
    if (!requireText(entry.id, "baseline id", problems)) continue;
    if (seenBaseline.has(entry.id)) problems.push(`duplicate baseline id: ${entry.id}`);
    seenBaseline.add(entry.id);
    if (!committedIds.has(entry.id)) {
      problems.push(`baseline growth is forbidden: ${entry.id}`);
    }
    if (!requireText(entry.path, `baseline path for ${entry.id}`, problems)) continue;
    if (!requireText(entry.reason, `baseline reason for ${entry.id}`, problems)) continue;
    if (!requireText(entry.marker, `baseline marker for ${entry.id}`, problems)) continue;
    const expected = baselineEntryFingerprint(entry);
    if (entry.fingerprint !== expected) {
      problems.push(`baseline fingerprint mismatch: ${entry.id}`);
    }
  }
  for (const id of committedIds) {
    if (!seenBaseline.has(id)) {
      // Shrinking is allowed only when the caller also proves the marker is gone.
      // A dropped entry while the marker remains is stale removal.
      const committed = (committedBaseline || []).find((row) => row.id === id);
      const sourceMap = sourceTexts instanceof Map
        ? sourceTexts
        : sourceTexts
          ? new Map(Object.entries(sourceTexts))
          : null;
      const text = sourceMap?.get(committed.path);
      if (text != null && text.includes(committed.marker)) {
        problems.push(`baseline entry removed while marker remains: ${id}`);
      }
    }
  }

  if (sourceTexts) {
    const sourceMap = sourceTexts instanceof Map
      ? sourceTexts
      : new Map(Object.entries(sourceTexts));
    for (const entry of baseline || []) {
      const text = sourceMap.get(entry.path);
      if (text == null) {
        problems.push(`baseline source unavailable for probe: ${entry.id}`);
        continue;
      }
      if (!text.includes(entry.marker)) {
        problems.push(`baseline marker missing; remove the entry to shrink: ${entry.id}`);
      }
    }
  }

  if (declaredSurfaceIds) {
    for (const id of declaredSurfaceIds) {
      if (!surfaceIds.has(id)) {
        problems.push(`undeclared browsing surface: ${id}`);
      }
    }
  }

  // Private planning frontmatter must not leak into the public contract inventory.
  const publicBlob = JSON.stringify({ surfaces, baseline, principles });
  for (const banned of [
    "needs_james",
    "card_standard",
    "richness_profile",
    "autodispatch",
    "realization_gate",
  ]) {
    if (publicBlob.includes(banned)) {
      problems.push(`public contract inventory contains private planning token: ${banned}`);
    }
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    contract_id: BROWSE_INSPECTION_CONTRACT_ID,
    surface_count: (surfaces || []).length,
    baseline_count: (baseline || []).length,
    compact_calendar_host_count: calendarHosts.length,
    directory_navigation_count: (surfaces || []).filter((row) => row.classification === "directory_navigation").length,
  });
}

/**
 * Behavioral negative checks: each mutation must make validation fail for the
 * stated reason class rather than pass because nearby prose still exists.
 */
export function mutateBrowseInspectionContract(kind) {
  if (kind === "undeclared_surface") {
    return {
      declaredSurfaceIds: ["undeclared-browsing-surface"],
    };
  }
  if (kind === "baseline_growth") {
    const extra = {
      id: "invented-legacy-exception",
      path: "site/affordance_grammar.mjs",
      marker: "AFFORDANCE_ACTION_ROLES",
      reason: "An unreviewed attempt to widen the legacy baseline.",
      fingerprint: null,
    };
    extra.fingerprint = baselineEntryFingerprint(extra);
    return {
      baseline: [...BROWSE_INSPECTION_LEGACY_BASELINE, Object.freeze(extra)],
    };
  }
  if (kind === "directory_navigation_without_reason") {
    return {
      surfaces: BROWSE_INSPECTION_SURFACES.map((row) => (
        row.surface_id === "agency-directory"
          ? { ...row, semantic_reason: "", positive_fixture: "" }
          : row
      )),
    };
  }
  if (kind === "drop_calendar_host") {
    return {
      surfaces: BROWSE_INSPECTION_SURFACES.filter((row) => row.surface_id !== "calendar-host-property"),
    };
  }
  throw new Error(`unknown browse-inspection mutation: ${kind}`);
}

export function validateMutatedBrowseInspection(kind, baseOptions = {}) {
  const mutation = mutateBrowseInspectionContract(kind);
  return validateBrowseInspectionContract({ ...baseOptions, ...mutation });
}

/** Accept an explicit directory-navigation fixture when it carries the required fields. */
export function acceptDirectoryNavigationFixture(fixture) {
  const problems = [];
  if (!fixture || typeof fixture !== "object") {
    return Object.freeze({ ok: false, problems: Object.freeze(["directory fixture missing"]) });
  }
  if (fixture.primary_intent !== "directory_navigation") {
    problems.push("directory fixture primary_intent must be directory_navigation");
  }
  if (fixture.classification !== "directory_navigation") {
    problems.push("directory fixture classification must be directory_navigation");
  }
  if (!fixture.semantic_reason || !String(fixture.semantic_reason).trim()) {
    problems.push("directory fixture lacks semantic reason");
  }
  if (!fixture.positive_fixture || !String(fixture.positive_fixture).trim()) {
    problems.push("directory fixture lacks positive fixture id");
  }
  if (fixture.detail_host !== "none_directory") {
    problems.push("directory fixture must use none_directory");
  }
  if (fixture.baseline_id) {
    problems.push("directory fixture must not enter the legacy baseline");
  }
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    surface_id: fixture.surface_id || null,
  });
}
