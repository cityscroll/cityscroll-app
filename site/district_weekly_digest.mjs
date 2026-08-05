/** Shared district-preset contract for the site preview, build step, and Worker email. */

import { followingUrlFromWatch } from "./following_view.mjs";

export const DISTRICT_WEEKLY_DIGEST_SCHEMA = "district_weekly_digests.v1";

export const DISTRICT_DIGEST_SECTIONS = Object.freeze([
  Object.freeze({ id: "awards", label: "Review new contract awards", kind: "award" }),
  Object.freeze({ id: "hearings", label: "Attend upcoming hearings", kind: "meetings" }),
  Object.freeze({ id: "land", label: "Track land use actions", kind: "rezone" }),
  Object.freeze({ id: "property", label: "Review property dispositions", kind: "property" }),
]);

export const DISTRICT_DIGEST_SECTION_IDS = new Set(DISTRICT_DIGEST_SECTIONS.map((section) => section.id));

export function normalizeCouncilDistrict(value) {
  const id = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^(?:[1-9]|[1-4]\d|5[01])$/.test(id) ? id : null;
}

export function districtDigestRows(payload, councilDistrict) {
  const id = normalizeCouncilDistrict(councilDistrict);
  if (!id || payload?.schema !== DISTRICT_WEEKLY_DIGEST_SCHEMA) return [];
  const record = payload?.by_council_district?.[id];
  return Array.isArray(record?.items) ? record.items.filter((row) => row?.district_item_id) : [];
}

/** Ordered action groups. Empty groups are deliberately absent. */
export function groupDistrictDigestRows(rows = []) {
  const bySection = new Map(DISTRICT_DIGEST_SECTIONS.map((section) => [section.id, []]));
  for (const row of rows) {
    if (!row?.district_item_id || !bySection.has(row.district_section)) continue;
    bySection.get(row.district_section).push(row);
  }
  return DISTRICT_DIGEST_SECTIONS
    .map((section) => ({ ...section, items: bySection.get(section.id) }))
    .filter((section) => section.items.length > 0);
}

export function districtDigestAlertsHref(councilDistrict) {
  const id = normalizeCouncilDistrict(councilDistrict);
  if (!id) return "/following/";
  return followingUrlFromWatch({
    lens: "district",
    filter: { councilDistrict: id },
    freq: "weekly",
  }, { frequency: "weekly" });
}
