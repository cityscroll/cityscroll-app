/**
 * Small, pure meetings-card display helpers (affected area and venue text),
 * split out of site/app/feed-actions.mjs to keep that module under its
 * measured working-bar byte ceiling (test/site_module_architecture.mjs).
 * No behavior change from their prior in-file versions.
 */

import { communityBoardPageHref } from "./community_board_links.mjs";

export function hearingAreaText(record){
  const area=record.affected_area||{};
  if(area.scope==="citywide") return t("citywide");
  if(area.scope==="unlocated") return "";
  const values=[
    ...(area.neighborhoods||[]),
    ...(area.boroughs||[]),
    ...(area.community_districts||[]).map(cd=>t("community_district_short",{n:cd})),
    ...(area.community_boards||[]),
    ...(area.addresses||[]).map(address=>address.label),
    ...(area.street_ranges||[]).map(range=>range.label),
    ...(area.tax_lots||[]).map(lot=>lot.label),
    ...(area.project_names||[]),
  ].filter(Boolean);
  return [...new Set(values)].join(" · ");
}

export function hearingAreaHTML(record){
  const area=record.affected_area||{};
  if(area.scope==="citywide") return escUiHtml(t("citywide"));
  if(area.scope==="unlocated") return "";
  const values=[
    ...(area.neighborhoods||[]),
    ...(area.boroughs||[]),
    ...(area.community_districts||[]).map(cd=>t("community_district_short",{n:cd})),
    ...(area.community_boards||[]),
    ...(area.addresses||[]).map(address=>address.label),
    ...(area.street_ranges||[]).map(range=>range.label),
    ...(area.tax_lots||[]).map(lot=>lot.label),
    ...(area.project_names||[]),
  ].filter(Boolean);
  return [...new Set(values)].map(value=>{
    const href=communityBoardPageHref(value);
    return href
      ? `<a class="community-board-reference" href="${escUiHtml(href)}">${escUiHtml(value)}</a>`
      : escUiHtml(value);
  }).join(" · ");
}

export function hearingVenueText(record){
  const venue=record.venue||{}, labels={
    "virtual":"venue_virtual","in-person":"venue_in_person","hybrid":"venue_hybrid"
  };
  return [labels[venue.mode]?t(labels[venue.mode]):"", venue.building, venue.address].filter(Boolean).join(" · ");
}

globalThis.hearingAreaText = hearingAreaText;
globalThis.hearingVenueText = hearingVenueText;
