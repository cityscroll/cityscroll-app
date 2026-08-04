/**
 * Build a slim item index for the council-district weekly preset.
 *
 * Placement comes exclusively from the same committed corpora and placement
 * helpers as district_activity. There is no request-time or new geocoding path.
 */

import {
  buildCommunityToCouncilIndex,
} from "../../site/civic_address_geocode.mjs";
import {
  normalizeCouncilDistrictId,
  resolveCouncilDistrict,
} from "../../site/council_district_lookup.mjs";
import {
  DISTRICT_DIGEST_SECTIONS,
  DISTRICT_WEEKLY_DIGEST_SCHEMA,
} from "../../site/district_weekly_digest.mjs";
import {
  isSyntheticWarehouseFixtureRow,
  meetingPlacementsFromRow,
  moneyPlacementsFromRow,
  parseZapCommunityDistricts,
  propertyPlacementsFromRow,
} from "./district_activity.mjs";

const MAX_ITEMS_PER_SECTION = 25;
const MAX_ITEMS_PER_DISTRICT = MAX_ITEMS_PER_SECTION * DISTRICT_DIGEST_SECTIONS.length;
const TARGET_BYTES = 250_000;
const CEILING_BYTES = 500_000;

function iso(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function text(value, max = 240) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function councilsFromSlots(slots = [], cdCouncilIndex = {}) {
  const ids = new Set();
  for (const slot of slots) {
    const direct = normalizeCouncilDistrictId(slot?.council);
    if (direct) ids.add(direct);
    if (!direct && slot?.community) {
      const derived = normalizeCouncilDistrictId(cdCouncilIndex[slot.community]);
      if (derived) ids.add(derived);
    }
  }
  return [...ids];
}

function awardItem(row) {
  const id = text(row?.request_id, 40);
  if (!id || String(row?.type_of_notice_description || "").toLowerCase() !== "award") return null;
  return {
    district_item_id: `award:${id}`,
    district_section: "awards",
    district_kind: "award",
    request_id: id,
    start_date: iso(row.start_date),
    short_title: text(row.short_title),
    agency_name: text(row.agency_name, 160),
    vendor_name: text(row.vendor_name, 160),
    contract_amount: Number.isFinite(Number(row.contract_amount)) ? Number(row.contract_amount) : null,
    due_date: iso(row.due_date),
    section_name: "Procurement",
    type_of_notice_description: "Award",
  };
}

function hearingItem(row, today) {
  const id = text(row?.request_id, 40);
  const eventDate = iso(row?.event_date);
  if (!id || !eventDate || eventDate < today || !/hearing/i.test(String(row?.type_of_notice_description || row?.short_title || ""))) return null;
  return {
    district_item_id: `hearing:${id}`,
    district_section: "hearings",
    district_kind: "meetings",
    request_id: id,
    start_date: iso(row.start_date),
    event_date: eventDate,
    short_title: text(row.short_title),
    agency_name: text(row.agency_name, 160),
    section_name: row.section_name || "Public Hearings and Meetings",
    type_of_notice_description: text(row.type_of_notice_description, 100),
    street_address_1: text(row.street_address_1, 180),
  };
}

function landItem(row) {
  const id = text(row?.project_id, 40);
  if (!id) return null;
  const milestone = iso(row.current_milestone_date) || "current";
  return {
    district_item_id: `land:${id}:${milestone}`,
    district_section: "land",
    district_kind: "rezone",
    project_id: id,
    project_name: text(row.project_name),
    public_status: text(row.public_status, 100),
    borough: text(row.borough, 40),
    community_district: text(row.community_district, 80),
    current_milestone: text(row.current_milestone, 180),
    current_milestone_date: iso(row.current_milestone_date),
    mih_flag: row.mih_flag ?? null,
  };
}

function propertyItem(row) {
  const id = text(row?.request_id, 40);
  if (!id) return null;
  return {
    district_item_id: `property:${id}`,
    district_section: "property",
    district_kind: "property",
    request_id: id,
    start_date: iso(row.start_date),
    event_date: iso(row.event_date),
    short_title: text(row.short_title),
    agency_name: text(row.agency_name, 160),
    section_name: "Property Disposition",
    type_of_notice_description: text(row.type_of_notice_description, 100),
    street_address_1: text(row.street_address_1, 180),
    disposition_stage: text(row.disposition_stage, 80),
  };
}

function itemSort(a, b) {
  const aDate = a.event_date || a.current_milestone_date || a.start_date || "";
  const bDate = b.event_date || b.current_milestone_date || b.start_date || "";
  return bDate.localeCompare(aDate) || a.district_item_id.localeCompare(b.district_item_id);
}

export function buildDistrictWeeklyDigests({
  boundaries,
  zapRows = [],
  propertyRows = [],
  meetingsRows = [],
  moneyRows = [],
  builtAt = new Date().toISOString(),
} = {}) {
  if (!boundaries?.boundary_vintage) throw new Error("district weekly digest requires district boundaries");
  const today = String(builtAt).slice(0, 10);
  const cdCouncilIndex = buildCommunityToCouncilIndex(boundaries, resolveCouncilDistrict);
  const buckets = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [String(index + 1), new Map()]));

  const add = (councils, item) => {
    if (!item) return;
    for (const council of councils) {
      const id = normalizeCouncilDistrictId(council);
      if (id && buckets[id]) buckets[id].set(item.district_item_id, item);
    }
  };

  for (const row of zapRows) {
    const publisher = normalizeCouncilDistrictId(row?.cc_district || row?.council_district || row?.city_council_district);
    const councils = new Set(publisher ? [publisher] : []);
    for (const cd of parseZapCommunityDistricts(row?.community_district)) {
      const derived = normalizeCouncilDistrictId(cdCouncilIndex[cd]);
      if (derived) councils.add(derived);
    }
    add([...councils], landItem(row));
  }

  const placeOpts = { cdCouncilIndex };
  for (const row of propertyRows) {
    add(councilsFromSlots(propertyPlacementsFromRow(row, boundaries, placeOpts), cdCouncilIndex), propertyItem(row));
  }
  for (const row of meetingsRows) {
    add(councilsFromSlots(meetingPlacementsFromRow(row, boundaries, placeOpts), cdCouncilIndex), hearingItem(row, today));
  }
  for (const row of moneyRows) {
    if (isSyntheticWarehouseFixtureRow(row)) continue;
    add(councilsFromSlots(moneyPlacementsFromRow(row, boundaries, placeOpts), cdCouncilIndex), awardItem(row));
  }

  const byCouncil = {};
  for (let district = 1; district <= 51; district++) {
    const id = String(district);
    const all = [...buckets[id].values()];
    const items = DISTRICT_DIGEST_SECTIONS.flatMap((section) => all
      .filter((item) => item.district_section === section.id)
      .sort(itemSort)
      .slice(0, MAX_ITEMS_PER_SECTION));
    const counts = Object.fromEntries(DISTRICT_DIGEST_SECTIONS.map((section) => [
      section.id,
      items.filter((item) => item.district_section === section.id).length,
    ]));
    byCouncil[id] = { council_district: id, total: items.length, counts, items };
  }

  const measuredBytes = Buffer.byteLength(JSON.stringify(byCouncil));
  return {
    schema: DISTRICT_WEEKLY_DIGEST_SCHEMA,
    boundary_vintage: String(boundaries.boundary_vintage),
    built_at: builtAt,
    sections: DISTRICT_DIGEST_SECTIONS,
    by_council_district: byCouncil,
    performance: {
      measured_bytes: measuredBytes,
      target_bytes: TARGET_BYTES,
      ceiling_bytes: CEILING_BYTES,
      max_items_per_section: MAX_ITEMS_PER_SECTION,
      max_items_per_district: MAX_ITEMS_PER_DISTRICT,
    },
    note: "One materialized council-district item list powers both preview and weekly replay. Placement reuses district_activity geo joins; no request-time geocoding.",
  };
}
