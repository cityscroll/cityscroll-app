/**
 * Wider-district meeting previews for a selected neighborhood.
 *
 * A neighborhood whose boundary spans several community districts can preview
 * those boards' meetings without claiming the meetings happen inside the
 * selected neighborhood. Relations come only from committed crosswalk rows
 * whose `material_for_navigation` flag is true; preview records come from the
 * district's own published Near You slice and never enter the selected
 * geography's exact membership, exact ids, or exact counts.
 */

import { isMaterialForNavigation } from "./geography_crosswalk_artifacts.mjs";
import { labelForGeographyId } from "./geography_navigation_overlap_ui.mjs";
import {
  NEAR_YOU_RECORD_TITLE_LINK_CLASS,
  nearYouEventTimeLabel,
  nearYouHeldInLabel,
  nearYouRecordInspectionFacts,
  renderNearYouRecordFullRecordLink,
  renderNearYouRecordInspectButton,
} from "./near_you_record_inspection.mjs";

export const NEAR_YOU_BROADER_DISTRICTS_SCHEMA = "cityscroll.near_you_broader_districts.v1";

export const BROADER_DISTRICT_SCOPE = "broader";
export const BROADER_DISTRICT_SCOPE_LABEL = "broader";
export const BROADER_DISTRICTS_KICKER = "Wider district activity";
export const BROADER_DISTRICTS_HEADING = "Meetings in districts that overlap this neighborhood";
export const BROADER_DISTRICTS_NOTE = "These community districts overlap this neighborhood, so their boards can act on it. The records below cover a whole district, not this exact neighborhood, and are not counted as exact neighborhood records.";
export const BROADER_DISTRICT_PREVIEW_LIMIT = 3;
export const BROADER_DISTRICT_GROUP_LABEL = "records in this district";
export const BROADER_DISTRICT_OPEN_ALL_LABEL = "Open district records";

const BROADER_DISTRICTS_PER_SELECTION = 3;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/**
 * Material community-district relations for one selected NTA, from committed
 * crosswalk rows. Rows whose `material_for_navigation` is false (for example a
 * zero-area `touches` relation) never produce a preview relation.
 */
export function broaderDistrictRelationsFromCrosswalkRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .filter((row) => String(row.from_key || "").startsWith("geography:nta2020:"))
    .filter((row) => String(row.to_type || parseCrosswalkType(row.to_key)) === "community_district")
    .filter((row) => row.material_for_navigation == null
      ? isMaterialForNavigation(Number(row.pct_from))
      : Boolean(row.material_for_navigation))
    .map((row) => {
      const id = String(row.to_key || "").replace(/^geography:community_district:/, "");
      return {
        key: `geography:community_district:${id}`,
        id,
        pct_from: Number.isFinite(Number(row.pct_from)) ? Number(row.pct_from) : null,
      };
    })
    .filter((relation) => relation.id)
    .sort((left, right) => (right.pct_from ?? 0) - (left.pct_from ?? 0) || left.id.localeCompare(right.id, "en"));
}

function parseCrosswalkType(toKey) {
  return String(toKey || "").startsWith("geography:community_district:") ? "community_district" : "";
}

/**
 * Build the wider-district section model from material relations and the
 * districts' own published activity slices. Records already selected as exact
 * results of the selection are excluded: an exactly placed record needs no
 * broader preview, and the broader section must never re-count it.
 */
export function buildNearYouBroaderDistrictSection({
  relations = [],
  recordsByDistrict = {},
  exactIds = [],
  previewLimit = BROADER_DISTRICT_PREVIEW_LIMIT,
} = {}) {
  const exact = new Set((Array.isArray(exactIds) ? exactIds : []).map(String));
  const seen = new Set(exact);
  const districts = [];
  for (const relation of (Array.isArray(relations) ? relations : []).slice(0, BROADER_DISTRICTS_PER_SELECTION)) {
    if (!relation?.id) continue;
    const records = (Array.isArray(relation.records) ? relation.records : [])
      .filter((record) => record && record.id && !seen.has(String(record.id)))
      .slice(0, Math.max(1, previewLimit));
    if (!records.length) continue;
    for (const record of records) seen.add(String(record.id));
    districts.push(freezeDeep({
      key: relation.key || `geography:community_district:${relation.id}`,
      id: String(relation.id),
      label: relation.label || labelForGeographyId("community_district", relation.id),
      scope: BROADER_DISTRICT_SCOPE,
      pct_from: relation.pct_from ?? null,
      href: relation.href || null,
      count: records.length,
      records,
    }));
  }
  if (!districts.length) {
    return freezeDeep({
      schema: NEAR_YOU_BROADER_DISTRICTS_SCHEMA,
      scope: BROADER_DISTRICT_SCOPE,
      districts: Object.freeze([]),
    });
  }
  return freezeDeep({
    schema: NEAR_YOU_BROADER_DISTRICTS_SCHEMA,
    scope: BROADER_DISTRICT_SCOPE,
    kicker: BROADER_DISTRICTS_KICKER,
    heading: BROADER_DISTRICTS_HEADING,
    note: BROADER_DISTRICTS_NOTE,
    districts,
  });
}

function previewDateLabel(value) {
  if (!value) return "Date not published";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
  const time = nearYouEventTimeLabel(value);
  return time ? `${day} · ${time}` : day;
}

function previewAppearanceReason(record) {
  const evidence = record?.geography_evidence;
  if (evidence?.location_role === "venue" && evidence?.label) {
    return nearYouHeldInLabel(evidence.label) || evidence.label;
  }
  if (record?.place?.location_role === "venue") {
    const geos = Array.isArray(record.place.geographies) ? record.place.geographies : [];
    // Prefer the neighborhood venue membership when several layers carry venue role.
    const venueGeo = geos.find((row) =>
      row?.visibility === "public"
      && row.location_role === "venue"
      && row.type === "nta2020"
      && row.label)
      || geos.find((row) =>
        row?.visibility === "public" && row.location_role === "venue" && row.label);
    if (venueGeo?.label) return nearYouHeldInLabel(venueGeo.label) || venueGeo.label;
  }
  return record?.basis || "Local activity";
}

function previewVenueAddress(record) {
  return record?.venue_address
    || record?.venue?.address
    || record?.place?.venue_address
    || null;
}

function previewRecordCard(record) {
  const facts = nearYouRecordInspectionFacts(record);
  const inspectButton = facts ? renderNearYouRecordInspectButton(facts, { escape: esc }) : "";
  const fullRecord = facts ? renderNearYouRecordFullRecordLink(facts, { escape: esc }) : "";
  const timing = facts?.timing
    ? `<p class="near-record-timing" data-record-timing="${esc(facts.timing.state)}" data-action-open="${facts.timing.action_open ? "true" : "false"}">${esc(facts.timing.label)}</p>`
    : "";
  const venueAddress = previewVenueAddress(record);
  return `<li class="near-record" data-record-id="${esc(record.id)}" data-broader-scope="${esc(BROADER_DISTRICT_SCOPE)}">
    <a class="${NEAR_YOU_RECORD_TITLE_LINK_CLASS} near-record-title" href="${esc(record.route)}"
      data-pivot-schema="cityscroll.edge_summary.v1" data-pivot-status="accepted"
      data-pivot-relation-label="wider district record" data-pivot-target-kind="notice"
      data-pivot-target-id="${esc(record.id)}" data-pivot-source-kind="place"
      data-pivot-source-id="near-you">${esc(record.title)}</a>${inspectButton}
    <div class="near-record-meta">
      ${record.agency ? `<span>${esc(record.agency)}</span>` : ""}
      ${record.type ? `<span>${esc(record.type)}</span>` : ""}
      <span>${esc(previewDateLabel(record.date))}</span>
    </div>
    ${record.source_url
      ? `<div class="near-record-source"><a href="${esc(record.source_url)}" rel="noopener noreferrer" data-near-you-record-source>Official source</a></div>`
      : ""}
    <div class="near-record-basis" data-appearance-reason="1"><strong>${esc(previewAppearanceReason(record))}</strong></div>
    ${venueAddress ? `<div class="near-record-venue" data-venue-address="1">${esc(venueAddress)}</div>` : ""}
    ${timing}
    ${fullRecord ? `<p class="near-record-actions">${fullRecord}</p>` : ""}
  </li>`;
}

/**
 * Render the labeled wider-district section. The section is nested inside the
 * results panel before the exact-results block, so its scope label is read
 * before any exact result. An empty section model renders nothing.
 */
export function renderNearYouBroaderDistrictsHtml(section) {
  if (!section?.districts?.length) return "";
  const groups = section.districts.map((district) => {
    const openAll = district.href
      ? `<a class="near-broader-district-open" href="${esc(district.href)}">${esc(BROADER_DISTRICT_OPEN_ALL_LABEL)}</a>`
      : "";
    return `<div class="near-broader-district" data-broader-district="${esc(district.id)}" data-broader-district-key="${esc(district.key)}">
      <h3 class="near-broader-district-heading">${esc(district.label)} <span class="near-geo-broader-label">${esc(BROADER_DISTRICT_SCOPE_LABEL)}</span></h3>
      <p class="near-broader-district-count">${esc(`${district.count} ${BROADER_DISTRICT_GROUP_LABEL}`)}</p>
      <ol class="near-records">${district.records.map(previewRecordCard).join("")}</ol>
      ${openAll}
    </div>`;
  }).join("");
  return `<section class="near-broader-districts" data-near-broader-districts aria-labelledby="near-broader-districts-heading">
    <p class="near-kicker">${esc(section.kicker || BROADER_DISTRICTS_KICKER)}</p>
    <h2 id="near-broader-districts-heading">${esc(section.heading || BROADER_DISTRICTS_HEADING)}</h2>
    <p class="near-broader-districts-note">${esc(section.note || BROADER_DISTRICTS_NOTE)}</p>
    ${groups}
  </section>`;
}
