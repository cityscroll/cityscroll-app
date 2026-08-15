import {
  MAP_LENSES,
  BOROUGH_META,
  BOROUGH_HULLS,
  bboxToViewBox,
  defaultViewBox,
  mapFeatures,
} from "./map_exploration.mjs";
import {
  nearYouUrlFromScope,
  normalizeScope,
  routeHashFromScope,
  watchFromScope,
} from "./scope_v0.mjs";
import { ACTION_LOCATION_BASIS_LABELS } from "./contract_action_location.mjs";
import { scopeWithPlace } from "./near_you_scope_runtime.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { migrateLegacyUrl } from "./route_migration.mjs";
import { selectNearYouExplanationPath } from "./near_you_explanation_path.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
} from "./civic_document_chrome.mjs";
import { buildPlaceLocalConstellation } from "./community_board_geography.mjs";
import { renderLocalConstellationHTML } from "./local_constellation.mjs";
import { renderWalkEntry, walkEntryHref, walkEntryPlaceLabel } from "./walk_entry.mjs";
import { meetingOriginLabel } from "./meeting_origin.mjs";

const LENS_LABELS = Object.freeze({
  land: "Zoning",
  property: "Property",
  rules: "Rules",
  meetings: "Meetings",
  money: "Contracts",
  people: "Staffing",
});
const BAG_LABELS = Object.freeze({
  citywide: "Citywide",
  virtual: "Virtual / online only",
  unlocated: "No place signal",
});
const BOROUGHS = Object.keys(BOROUGH_META);

// Placement methods are machine provenance. Keep their stable enum values in
// the read model, but never expose those identifiers as reader-facing copy.
const PLACEMENT_METHOD_LABELS = Object.freeze({
  agency_borough: "matched by agency area",
  agency_community_board: "matched by community board area",
  agency_hq: "agency headquarters fallback",
  agency_service_area: "matched by agency service area",
  cd_centroid_council: "district centroid",
  civic_address_pip: "matched by civic address",
  classic_affected_area: "matched by affected area",
  community_board: "matched by community board area",
  coordinates_pip: "matched by coordinates",
  citywide: "citywide placement",
  citywide_phrase: "matched by citywide notice language",
  hearing_matter: "matched by hearing matter",
  matter_address: "matched by matter address",
  matter_body_borough: "matched by matter borough",
  matter_title_place: "matched by matter title",
  neighborhood_place: "matched by neighborhood",
  publisher_council: "matched by publisher district",
  publisher_district: "matched by publisher district",
  "rule-scope": "matched by rule scope",
  rule_default_citywide: "citywide rule",
  service_borough: "matched by service area",
  stamped: "matched by published location",
  structured_bag: "matched by published location",
  title_borough: "matched by title borough",
  vendor_address: "matched by vendor address",
  vendor_place: "matched by vendor place",
  venue_column: "matched by venue",
  venue_line: "matched by venue",
  virtual_only: "online-only event",
});

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function first(values) {
  return Array.isArray(values) && values.length ? values[0] : null;
}

function effectiveTimeWindow(scope, builtAt) {
  let start = scope.time_window.start ? Date.parse(scope.time_window.start) : NaN;
  let end = scope.time_window.end ? Date.parse(scope.time_window.end) : NaN;
  const anchor = Date.parse(builtAt || "");
  const preset = String(scope.time_window.preset || "").replace(/^closing:/, "");
  const days = preset === "today" ? 1 : preset === "week" ? 7 : preset === "month" ? 31 : null;
  if (days && Number.isFinite(anchor)) {
    start = anchor;
    end = anchor + days * 86400000;
  } else if (scope.time_window.rolling_months && Number.isFinite(anchor)) {
    start = anchor;
    end = anchor + Number(scope.time_window.rolling_months) * 31 * 86400000;
  }
  return { start, end };
}

function recordMatches(record, scope, builtAt) {
  const agency = first(scope.facets.agencies);
  if (agency && String(record.agency || "").toLowerCase() !== agency.toLowerCase()) return false;
  const type = scope.facets.values?.type || scope.facets.values?.noticeType;
  if (type && String(record.type || "").toLowerCase() !== String(type).toLowerCase()) return false;
  const actionBasis = scope.facets.values?.actionBasis;
  if (actionBasis && actionBasis !== "contract_action_address") {
    const methods = Array.isArray(record.basis_methods)
      ? record.basis_methods
      : [record.basis_method].filter(Boolean);
    if (!methods.includes(actionBasis)) return false;
  }
  const query = String(scope.topic.query || first(scope.topic.keywords) || "").trim().toLowerCase();
  if (query) {
    const haystack = [record.id, record.title, record.agency, record.type, record.status] // Source: district_activity.json records.
      .filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  const { start, end } = effectiveTimeWindow(scope, builtAt);
  const date = record.date ? Date.parse(record.date) : NaN;
  if (Number.isFinite(start) && (!Number.isFinite(date) || date < start)) return false;
  if (Number.isFinite(end) && (!Number.isFinite(date) || date > end)) return false;
  return true;
}

function intersection(ids, allowed) {
  return [...new Set((ids || []).map(String).filter((id) => allowed.has(id)))].sort();
}

function itemIdsForPlace(activity, lens, scope) {
  const index = activity?.district_items;
  const locationScope = scope.place.location_scope;
  if (locationScope && index?.[locationScope]?.[lens]) return index[locationScope][lens];
  const council = first(scope.place.council_districts);
  if (council) return index?.by_level?.council_district?.[council]?.[lens] || [];
  const community = first(scope.place.community_districts);
  if (community) return index?.by_level?.community_district?.[community]?.[lens] || [];
  const borough = first(scope.place.boroughs);
  if (borough) return index?.by_level?.borough?.[borough]?.[lens] || [];
  const located = [];
  for (const name of BOROUGHS) located.push(...(index?.by_level?.borough?.[name]?.[lens] || []));
  return [...new Set(located)];
}

function filteredActivity(activity, lens, allowed) {
  const index = activity?.district_items || {};
  const byLevel = {};
  for (const level of ["borough", "community_district", "council_district"]) {
    byLevel[level] = {};
    const ids = new Set([
      ...Object.keys(activity?.by_level?.[level] || {}),
      ...Object.keys(index?.by_level?.[level] || {}),
    ]);
    for (const id of ids) {
      const counts = { ...(activity?.by_level?.[level]?.[id] || {}) };
      counts[lens] = intersection(index?.by_level?.[level]?.[id]?.[lens], allowed).length;
      byLevel[level][id] = counts;
    }
  }
  const out = {
    ...activity,
    by_level: byLevel,
    citywide: { ...(activity?.citywide || {}), [lens]: intersection(index?.citywide?.[lens], allowed).length },
    virtual: { ...(activity?.virtual || {}), [lens]: intersection(index?.virtual?.[lens], allowed).length },
    unlocated: { ...(activity?.unlocated || {}), [lens]: intersection(index?.unlocated?.[lens], allowed).length },
  };
  return out;
}

function scopeForFeature(scope, feature) {
  const basis = scope.place.viewport?.basis || scope.facets.values?.basis || "performance";
  if (feature.level === "borough") {
    const next = scopeWithPlace(scope, { borough: feature.id });
    next.place.viewport = {
      level: "community_district",
      id: null,
      parent: feature.id,
      basis,
      view_box: null,
    };
    return normalizeScope(next);
  }
  if (feature.level === "community_district") {
    const next = scopeWithPlace(scope, { communityDistrict: feature.id, borough: feature.parent });
    next.place.viewport = {
      level: "community_district",
      id: feature.id,
      parent: feature.parent,
      basis,
      view_box: null,
    };
    return normalizeScope(next);
  }
  const next = scopeWithPlace(scope, { councilDistrict: feature.id });
  next.place.viewport = {
    level: "council_district",
    id: feature.id,
    parent: null,
    basis,
    view_box: null,
  };
  return normalizeScope(next);
}

function scopeSummary(scope, lens) {
  const chips = [{ axis: "lens", label: LENS_LABELS[lens] || lens }];
  const values = [
    ["borough", first(scope.place.boroughs)],
    ["community district", first(scope.place.community_districts)],
    ["council district", first(scope.place.council_districts)],
    ["place basis", scope.place.location_scope && BAG_LABELS[scope.place.location_scope]],
    ["agency", first(scope.facets.agencies)],
    ["type", scope.facets.values?.type || scope.facets.values?.noticeType],
    ["keyword", scope.topic.query || first(scope.topic.keywords)],
    ["time", scope.time_window.preset],
    ["action", first(scope.facets.actions)],
  ];
  if (lens === "money" && (scope.place.viewport?.basis || scope.facets.values?.basis) === "contract_action_address") {
    values.push(["map basis", "Contract response address"]);
    const actionBasis = scope.facets.values?.actionBasis;
    if (actionBasis && actionBasis !== "contract_action_address") {
      values.push(["location basis", ACTION_LOCATION_BASIS_LABELS[actionBasis] || "Unknown location basis"]);
    }
  }
  for (const [axis, label] of values) if (label) chips.push({ axis, label: String(label) });
  return chips;
}

function watchHref(scope, lens, matchCount) {
  const watch = watchFromScope(scope, { lens });
  return followingUrlFromWatch(watch, { matchCount });
}

function recordSort(a, b) {
  const dateA = Date.parse(a.date || "") || 0;
  const dateB = Date.parse(b.date || "") || 0;
  return dateB - dateA || String(a.title).localeCompare(String(b.title));
}

export function buildNearYouViewModel(inputScope, activity, boundaries, options = {}) {
  const scope = normalizeScope(inputScope);
  const requestedLens = first(scope.facets.domains) || "meetings";
  const lens = requestedLens;
  const mapped = MAP_LENSES.includes(lens) && lens !== "all";
  const basis = lens === "money"
    && (scope.place.viewport?.basis || scope.facets.values?.basis) === "contract_action_address"
    ? "contract_action_address"
    : "performance";
  const basisLayer = basis === "contract_action_address"
    ? activity?.basis_layers?.contract_action_address
    : null;
  const activityRoot = basisLayer
    ? {
        ...basisLayer,
        boundary_vintage: activity?.boundary_vintage,
        built_at: activity?.built_at,
      }
    : activity;
  const records = activityRoot?.records?.[lens] || {};
  const allowed = new Set(Object.values(records)
    .filter((record) => recordMatches(record, scope, activity?.built_at))
    .map((record) => String(record.id)));
  const scopedActivity = mapped ? filteredActivity(activityRoot, lens, allowed) : filteredActivity(activityRoot, "meetings", new Set());
  const viewport = scope.place.viewport || {};
  const level = ["borough", "community_district", "council_district"].includes(viewport.level)
    ? viewport.level
    : "borough";
  const parent = level === "community_district"
    ? viewport.parent || first(scope.place.boroughs)
    : null;
  const mappedFeatures = mapFeatures(boundaries, scopedActivity, { level, parent, lens: mapped ? lens : "meetings" });
  const canonicalBase = options.canonicalBase || "https://cityscroll.org/near-you";
  const urlForScope = typeof options.urlForScope === "function"
    ? options.urlForScope
    : (nextScope) => nearYouUrlFromScope(nextScope, { base: canonicalBase });
  const siteBase = String(options.siteBase || "").replace(/\/$/, "");
  const siteHref = (path) => `${siteBase}${path}`;
  const migratedSiteHref = (path) => siteHref(migrateLegacyUrl(path).target);
  const features = mappedFeatures.features.map((feature) => ({
    ...feature,
    href: urlForScope(scopeForFeature(scope, feature)),
  }));
  const resultIds = mapped ? intersection(itemIdsForPlace(activityRoot, lens, scope), allowed) : [];
  const hasPlace = !!(scope.place.boroughs.length || scope.place.community_districts.length
    || scope.place.council_districts.length || scope.place.neighborhood
    || scope.place.location_scope);
  const linkedRecord = (record, { explain = true } = {}) => {
    const whyHere = explain
      ? selectNearYouExplanationPath(record.why_here_candidates, scope)
      : null;
    return {
      ...record,
      route: migratedSiteHref(record.route),
      why_here: whyHere
        ? { ...whyHere, notice_href: siteHref(whyHere.notice_href) }
        : null,
    };
  };
  const resultRecords = resultIds.map((id) => records[id]).filter(Boolean).sort(recordSort).map(linkedRecord);
  const bags = Object.fromEntries(["citywide", "virtual", "unlocated"].map((kind) => {
    const ids = mapped ? intersection(activityRoot?.district_items?.[kind]?.[lens], allowed) : [];
    return [kind, {
      kind,
      label: BAG_LABELS[kind],
      ids,
      count: ids.length,
      records: ids.map((id) => records[id]).filter(Boolean).sort(recordSort)
        .map((record) => linkedRecord(record, { explain: false })),
      href: urlForScope(scopeWithPlace(scope, { locationScope: kind })),
    }];
  }));
  return {
    schema: "cityscroll.near_you_view.v1",
    scope,
    lens,
    mapped,
    basis,
    basisLabel: basisLayer?.basis_label || "Affected area or place of performance",
    hasPlace,
    lensLabel: LENS_LABELS[lens] || lens,
    scopeSummary: scopeSummary(scope, lens),
    results: { ids: resultIds, count: resultIds.length, records: resultRecords },
    features,
    max: mappedFeatures.max,
    level,
    parent,
    viewBox: level === "community_district" && parent && BOROUGH_HULLS[parent]
      ? bboxToViewBox(BOROUGH_HULLS[parent].bbox, 0.08)
      : defaultViewBox(),
    bags,
    activity: activityRoot,
    browseHref: migratedSiteHref(`/${routeHashFromScope(scope, { surface: lens })}`),
    watchHref: watchHref(scope, lens, resultIds.length),
    shareHref: nearYouUrlFromScope(scope, { base: canonicalBase }),
    canonicalBase,
    siteBase,
    local_constellation: buildPlaceLocalConstellation(
      options.communityGeography || {},
      first(scope.place.community_districts)
        ? `community-district:${first(scope.place.community_districts)}`
        : first(scope.place.council_districts)
          ? `council-district:${first(scope.place.council_districts)}`
          : null,
      boundaries,
    ),
  };
}

function dateLabel(value) {
  if (!value) return "Date not published";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function placeRoleLabel(role) {
  if (role === "venue") return "Meeting venue";
  if (role === "matter") return "Matter place";
  return "Affected area";
}

function placementMethodLabel(method) {
  return PLACEMENT_METHOD_LABELS[method] || "location evidence";
}

function whyHerePath(path) {
  if (!path) return "";
  const mandateLabel = path.mandate?.citation || path.mandate?.relation_label || "Connected mandate";
  return `<div class="near-record-why" data-why-here-path="1"
    data-located-in-method="${esc(path.provenance?.located_in_method)}"
    data-cross-spine-method="${esc(path.provenance?.cross_spine_method)}"
    data-publication-tier="${esc(path.provenance?.publication_tier)}"
    aria-label="Why this record is here">
    <strong>Why this is here</strong>
    <span class="near-record-why-step">${esc(placeRoleLabel(path.location?.place_role))}: ${esc(path.location?.label)}</span>
    <span class="near-record-why-separator" aria-hidden="true">·</span>
    <span class="near-record-why-step">Process: <a href="${esc(path.agency?.href)}">${esc(path.agency?.name)}</a> → <a href="${esc(path.notice_href)}" title="${esc(path.mandate?.duty_text)}">Mandate: ${esc(mandateLabel)}</a></span>
    <span class="near-record-why-source">Public location and civic-process links</span>
  </div>`;
}

function recordCard(record) {
  const meetingSource = record.meeting_origin
    ? `<div class="near-record-source" data-meeting-origin="${esc(record.meeting_origin)}">${record.source_url
      ? `<a href="${esc(record.source_url)}" rel="noopener noreferrer">${esc(meetingOriginLabel(record.meeting_origin))}</a>`
      : esc(meetingOriginLabel(record.meeting_origin))}</div>`
    : "";
  const placementMethods = Array.isArray(record.placement_methods) && record.placement_methods.length
    ? record.placement_methods.map(placementMethodLabel).join(", ")
    : record.basis_method ? placementMethodLabel(record.basis_method) : null;
  const placement = placementMethods
    ? `${record.basis} · ${placementMethods} placement`
    : record.basis;
  return `<li class="near-record" data-record-id="${esc(record.id)}">
    <a class="near-record-title" href="${esc(record.route)}"
      data-pivot-schema="cityscroll.edge_summary.v1" data-pivot-status="accepted"
      data-pivot-relation-label="nearby record" data-pivot-target-kind="notice"
      data-pivot-target-id="${esc(record.id)}" data-pivot-source-kind="place"
      data-pivot-source-id="near-you">${esc(record.title)}</a>
    <div class="near-record-meta">
      ${record.agency ? `<span>${esc(record.agency)}</span>` : ""}
      ${record.type ? `<span>${esc(record.type)}</span>` : ""}
      <span>${esc(dateLabel(record.date))}</span>
    </div>
    ${meetingSource}
    <div class="near-record-basis"><strong>${esc(placement)}</strong>${record.confidence ? ` · ${esc(record.confidence)} basis` : ""}</div>${whyHerePath(record.why_here)}
  </li>`;
}

function recordList(records, emptyCopy = "No records match these filters.") {
  if (!records.length) return `<p class="near-empty">${esc(emptyCopy)}</p>`;
  return `<ol class="near-records">${records.map(recordCard).join("")}</ol>`;
}

function hiddenScopeFields(scope, omit = new Set()) {
  const url = new URL(nearYouUrlFromScope(scope, { base: "https://cityscroll.invalid/near-you" }));
  return [...url.searchParams.entries()]
    .filter(([name]) => !omit.has(name))
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join("");
}

function lensOptions(current) {
  return ["meetings", "land", "property", "rules", "money", "people"]
    .map((lens) => `<option value="${lens}"${lens === current ? " selected" : ""}>${esc(LENS_LABELS[lens])}</option>`)
    .join("");
}

function boroughOptions(current) {
  return `<option value="">All mapped areas</option>${BOROUGHS
    .map((borough) => `<option${borough === current ? " selected" : ""}>${esc(borough)}</option>`)
    .join("")}`;
}

function basisOptions(current) {
  return `<option value="performance"${current === "performance" ? " selected" : ""}>Where work may affect an area</option>
    <option value="contract_action_address"${current === "contract_action_address" ? " selected" : ""}>Contract response address</option>`;
}

export function renderNearYouBody(view) {
  const scopeChips = view.scopeSummary
    .map((chip) => `<li data-scope-axis="${esc(chip.axis)}">${esc(chip.label)}</li>`).join("");
  const paths = view.features.map((feature) => `<path class="map-district"
    data-map-id="${esc(feature.id)}" data-count="${feature.total}" data-map-level="${esc(feature.level)}"
    data-map-href="${esc(feature.href)}" d="${esc(feature.path)}" fill="${esc(feature.fill)}"
    aria-label="${esc(feature.label)}: ${feature.total} ${esc(view.lensLabel)} records"></path>`).join("");
  const labels = view.features.map((feature) => `<text class="map-label map-label-${esc(feature.level)} map-label--${esc(feature.labelTone)}"
      data-map-label="${esc(feature.id)}" data-area-name="${esc(feature.label)}"
      x="${esc(feature.labelPoint?.x)}" y="${esc(feature.labelPoint?.y)}"
      text-anchor="middle" dominant-baseline="central" aria-label="${esc(feature.label)}">${esc(feature.labelText)}</text>`).join("");
  const areas = [...view.features] // Source: district_boundaries.json build artifact.
    .sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)))
    .map((feature) => `<li><a data-map-area="${esc(feature.id)}" data-count="${feature.total}" href="${esc(feature.href)}"><span>${esc(feature.label)}</span><strong>${feature.total}</strong></a></li>`)
    .join("");
  const bags = Object.values(view.bags).map((bag) => `<details class="near-bag" data-bag="${bag.kind}">
    <summary><span>${esc(bag.label)}</span><strong>${bag.count}</strong></summary>
    <p>${bag.kind === "citywide"
      ? "These records apply citywide, so they do not belong to one district."
      : bag.kind === "virtual"
        ? "These records are online only and have no physical place."
        : "The source does not give enough place detail to map these records."}</p>
    ${recordList(bag.records, `No ${bag.label.toLowerCase()} records match these filters.`)}
  </details>`).join("");
  const currentBorough = first(view.scope.place.boroughs);
  const walkQuery = view.scope.topic?.query || first(view.scope.topic?.keywords);
  const walkFamilies = Object.entries(LENS_LABELS).map(([lens, label]) => {
    const nextScope = normalizeScope({
      ...view.scope,
      facets: { ...view.scope.facets, domains: [lens] },
    });
    const current = lens === view.lens;
    return {
      id: lens,
      label,
      kicker: current ? "Current records" : label,
      description: current
        ? "Open these records and follow their links."
        : "No count for this family here.",
      status: current ? (view.mapped ? "available" : "unknown") : "unknown",
      count: current ? view.results.count : null,
      href: walkEntryHref(nearYouUrlFromScope(nextScope, { base: view.canonicalBase }), {
        source: "near_you",
        query: walkQuery,
        place: view.scope,
      }),
    };
  });
  const walkHref = view.hasPlace
    ? walkEntryHref(view.shareHref, { source: "near_you", query: walkQuery, place: view.scope })
    : "#near-place-fields";
  const walkEntry = renderWalkEntry({
    source: "near_you",
    query: walkQuery,
    placeLabel: walkEntryPlaceLabel(view.scope),
    families: walkFamilies,
    actionHref: walkHref,
    actionLabel: view.hasPlace ? "Walk this place" : "Choose a place",
    title: view.hasPlace ? "Walk this place" : "Start with a place",
    description: view.hasPlace
      ? "Keep this place as you view related records."
      : "Choose a place first. A guessed location is not an edge.",
  });
  return `<main id="main" data-near-you-root data-lens="${esc(view.lens)}" data-level="${esc(view.level)}"
    data-message-updating="Updating the map…"
    data-message-updated="Map updated. Map and list counts match."
    data-message-location-unavailable="Location is not available in this browser. Choose an area from the list."
    data-message-location-finding="Finding your district…"
    data-message-location-matched="Location matched {district}."
    data-message-location-unmatched="Your district could not be matched. Choose an area from the list."
    data-message-location-denied="Location permission was not granted. Choose an area from the list.">
    <section class="near-hero">
      <p class="near-kicker">Place-first civic records</p>
      <h1>Near you</h1>
      <p>Keep the same filters in the list, map, search, share link, and watch. Choosing a place narrows the results without removing your other filters.</p>
      <ul class="near-scope" aria-label="Active filters">${scopeChips}</ul>
      <nav class="near-actions" aria-label="Map actions">
        <a href="${esc(view.browseHref)}">Open as a list</a>
        <a href="${esc(view.watchHref)}">Watch these filters</a>
        <a href="${esc(view.shareHref)}">Share this map</a>
      </nav>
      ${walkEntry}
      ${renderLocalConstellationHTML(view.local_constellation, { heading: "Nearby place records", id: "place-local-constellation-heading" })}
    </section>
    <section class="near-place-guide${view.hasPlace ? " is-set" : ""}" aria-labelledby="near-place-heading">
      <p class="near-kicker">${view.hasPlace ? "Place set" : "Start here"}</p>
      <h2 id="near-place-heading">${view.hasPlace ? "Change what “near you” means" : "Set what “near you” means"}</h2>
      <p>Choose a borough, neighborhood, community district, or council district. Or use your location once to match your district. Your coordinates stay in this browser; CityScroll does not save them.</p>
      <div class="near-place-actions">
        <button type="button" class="js-only near-location-action" data-use-location hidden>Use my location</button>
        <a href="#near-place-fields">Choose a place</a>
        <a href="#near-area-list">Browse the area list</a>
      </div>
      <p class="near-map-status" data-map-status aria-live="polite"></p>
    </section>
    <form class="near-form" id="near-place-fields" method="get" action="${esc(view.canonicalBase)}">
      ${hiddenScopeFields(view.scope, new Set(["lens", "agency", "type", "boro", "cd", "council", "neighborhood", "scope", "id", "parent", "basis"]))}
      <label>Lens<select name="lens">${lensOptions(view.lens)}</select></label>
      <label>Agency<input name="agency" value="${esc(first(view.scope.facets.agencies) || "")}" placeholder="Any agency"></label>
      <label>Type<input name="type" value="${esc(view.scope.facets.values?.type || "")}" placeholder="Any record type"></label>
      <label>Borough<select name="boro">${boroughOptions(currentBorough)}</select></label>
      <label>Neighborhood<input name="neighborhood" value="${esc(view.scope.place.neighborhood || "")}" placeholder="e.g. Elmhurst"></label>
      <label>Community district<input name="cd" value="${esc(first(view.scope.place.community_districts) || "")}" placeholder="e.g. Q04" pattern="[MXKQR][0-9]{2}"></label>
      <label>Council district<input name="council" value="${esc(first(view.scope.place.council_districts) || "")}" placeholder="1–51" inputmode="numeric" pattern="(?:[1-9]|[1-4][0-9]|5[01])"></label>
      ${view.lens === "money" ? `<label>Location basis<select name="basis">${basisOptions(view.basis)}</select></label>` : ""}
      <button type="submit">Apply filters</button>
    </form>
    ${view.mapped ? "" : `<aside class="near-coverage" role="note"><strong>${esc(view.lensLabel)} place data is not available.</strong> Your other filters stay in place, and the page does not switch to a different set of records.</aside>`}
    ${view.basis === "contract_action_address" ? `<aside class="near-coverage" role="note"><strong>${esc(view.basisLabel)}.</strong> This shows where to submit a bid, attend a pre-bid event, or pick up a file. It does not say where the contract work will happen.</aside>` : ""}
    <nav class="near-surface-switch" aria-label="Near you view" data-near-surface-switch>
      <a class="near-surface-link is-active" href="#near-results-heading" data-near-surface="list">Records (${view.results.count})</a>
      <a class="near-surface-link" href="#near-map-heading" data-near-surface="map">Map</a>
    </nav>
    <section class="near-results" aria-labelledby="near-results-heading" data-results-count="${view.results.count}" data-near-surface-panel="list">
      <div class="near-section-heading"><div><p class="near-kicker">Matching records</p><h2 id="near-results-heading" tabindex="-1">${view.results.count} ${esc(view.lensLabel)} records for these filters</h2></div></div>
      ${recordList(view.results.records)}
    </section>
    <section class="near-map-section" aria-labelledby="near-map-heading" data-near-surface-panel="map">
      <div class="near-section-heading"><div><p class="near-kicker">Map view</p><h2 id="near-map-heading">${esc(view.lensLabel)} by area</h2></div>
        <div class="map-controls js-only" hidden>
          <button type="button" data-map-zoom="in" aria-label="Zoom in">+</button>
          <button type="button" data-map-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" data-map-pan="west" aria-label="Pan west">←</button>
          <button type="button" data-map-pan="north" aria-label="Pan north">↑</button>
          <button type="button" data-map-pan="south" aria-label="Pan south">↓</button>
          <button type="button" data-map-pan="east" aria-label="Pan east">→</button>
          <button type="button" data-map-zoom="reset">Reset</button>
        </div>
      </div>
      <div class="near-map-grid">
        <div class="near-map-wrap">
          <svg id="nearMapSvg" role="img" aria-labelledby="nearMapTitle nearMapDesc" viewBox="${esc(view.viewBox)}" preserveAspectRatio="xMidYMid meet">
            <title id="nearMapTitle">New York City ${esc(view.level.replaceAll("_", " "))} map</title>
            <desc id="nearMapDesc">The area list beside this map contains the same links and ${esc(view.lensLabel)} counts.</desc>
            <g fill-rule="evenodd">${paths}</g>
            <g aria-hidden="true">${labels}</g>
          </svg>
          <p class="map-legend"><span></span> Fewer to more qualifying records</p>
          <p class="near-vintage">Map boundaries: ${esc(view.activity?.boundary_vintage || "not published")}</p>
        </div>
        <div class="near-area-panel" id="near-area-list">
          <h3>Equivalent area list</h3>
          <ol class="near-area-list">${areas || "<li>No areas match these filters.</li>"}</ol>
        </div>
      </div>
    </section>
    <section class="near-bags" aria-labelledby="near-bags-heading">
      <p class="near-kicker">Other places</p><h2 id="near-bags-heading">Records outside mapped districts</h2>
      <p>Citywide, online, and records without a place stay visible. We do not assign them to a district.</p>
      ${bags}
    </section>
  </main>`;
}

export function renderNearYouDocument(view, options = {}) {
  const assetPrefix = options.assetPrefix || "/";
  const prefix = assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Near you · CityScroll</title><meta name="description" content="Explore NYC civic records by place without losing your active filters.">
<link rel="canonical" href="${esc(view.shareHref)}">${renderCivicDocumentAssets(assetPrefix)}
<link rel="stylesheet" href="${esc(`${prefix}walk-entry.css`)}">
<link rel="stylesheet" href="${esc(`${prefix}local_constellation.css`)}"></head>
<body><a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "near-you", siteBase: view.siteBase, scope: view.scope, surfaceClass: "near-mast" })}
${renderNearYouBody(view)}
<footer class="near-footer">Counts and place labels reflect the listed public records. Check each record with the linked official source.</footer>
<script defer src="${esc(prefix)}analytics.js?v=1.3.0"></script>
<script type="module" src="${esc(prefix)}app/walk-entry.mjs"></script>
<script type="module" src="${esc(prefix)}app/traversal.mjs"></script><script type="module" src="${esc(prefix)}app/map.mjs"></script></body></html>`;
  return html.replace(/[ \t]+$/gm, "");
}
