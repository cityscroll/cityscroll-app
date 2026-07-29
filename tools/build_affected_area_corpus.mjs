#!/usr/bin/env node
/**
 * One-time sampler for the hand-labelled affected-area golden corpus.
 *
 * The committed fixture is intentionally pinned. Do not refresh it in CI: a changing
 * evaluation set would make before/after measurements incomparable. This sampler exists
 * only to make the source query and stratification reproducible for a future deliberate
 * relabelling pass.
 */

import { writeFile } from "node:fs/promises";

const SOURCE = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const OUTPUT = new URL("../test/contract/fixtures/affected_area_golden.json", import.meta.url);
const CAPTURED_AT = "2026-07-29";
const START_DATE = "2025-01-01T00:00:00";
const FIELDS = [
  "request_id", "start_date", "agency_name", "type_of_notice_description", "section_name",
  "short_title", "event_date", "building_name", "street_address_1", "street_address_2",
  "city", "state", "zip_code", "additional_description_1", "additional_description_2",
  "additional_description_3", "other_info_1", "other_info_2", "other_info_3", "printout_1",
  "printout_2", "printout_3",
];
const BOROUGHS = [
  ["Manhattan", /\b(?:borough of manhattan|manhattan|new york county)\b/i],
  ["Bronx", /\b(?:borough of (?:the )?bronx|the bronx|bronx county)\b/i],
  ["Brooklyn", /\b(?:borough of brooklyn|brooklyn|kings county)\b/i],
  ["Queens", /\b(?:borough of queens|queens|queens county)\b/i],
  ["Staten Island", /\b(?:borough of staten island|staten island|richmond county)\b/i],
];

const local = (boroughs, statedAreas, areaTypes, note) => ({
  scope: "local",
  boroughs,
  stated_areas: statedAreas,
  area_types: areaTypes,
  note,
});
const citywide = (statedAreas, note) => ({
  scope: "citywide",
  boroughs: [],
  stated_areas: statedAreas,
  area_types: ["citywide"],
  note,
});
const unlocated = (note) => ({
  scope: "unlocated",
  boroughs: [],
  stated_areas: [],
  area_types: [],
  note,
});

// Hand labels made from the complete pinned row, with the venue fields reviewed separately.
// For multi-item agendas, boroughs includes every subject borough and stated_areas names a
// representative subject; the source row remains the authoritative exhaustive list.
const LABELS = {
  "20260428004": local(["Brooklyn"], ["289 Kent Avenue", "South 1st Street to South 2nd Street"], ["project", "street-range", "application"], "The subject is a Brooklyn rezoning; Manhattan Avenue appears only in the Brooklyn venue description."),
  "20250523028": local(["Manhattan"], ["Lincoln Center West", "Damrosch Park", "Manhattan Community District 7"], ["project", "place", "community-district"], "The project description states the Manhattan site."),
  "20241223003": local(["Manhattan"], ["124 West 145th Street", "Harlem", "Community District 10"], ["address", "neighborhood", "community-district", "application"], "The One45 subject site is stated after the venue paragraph."),
  "20260723030": local(["Manhattan", "Brooklyn", "Queens"], ["90-01 Beach Channel Drive", "2114 Coyle Street", "511 West 25th Street"], ["address", "block-lot", "community-board"], "Every BSA PREMISES AFFECTED entry was reviewed; 22 Reade Street is only the venue."),
  "20251007003": local(["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"], ["the Bronx, Brooklyn, Queens, Staten Island or Manhattan above 96th Street"], ["borough", "street-range"], "The franchise service area explicitly lists eligible parts of all five boroughs."),
  "20250113017": citywide(["installation citywide"], "The multi-item Design Commission agenda includes one explicitly citywide installation; City Hall is only the venue."),
  "20260320021": local(["Brooklyn"], ["200 Kent Avenue", "River Street, North 3rd Street, Kent Avenue, and Metropolitan Avenue"], ["project", "street-range", "application", "community-board"], "The subject is the Brooklyn rezoning bounded by the listed streets."),
  "20250430004": local(["Brooklyn"], ["74 Bogart Street", "Ingraham Street, Morgan Avenue, Harrison Place, and Bogart Street"], ["project", "street-range", "application", "community-board"], "The subject is the Brooklyn rezoning, not the Manhattan Avenue venue reference."),
  "20250221012": citywide(["Citywide Statement of Needs for City Facilities"], "The hearing subject explicitly says Citywide; the Manhattan community-board office is the venue."),
  "20260618040": local(["Bronx"], ["Blocks 3264, 3238, and 3245", "Kingsbridge Heights", "Community Districts 7 and 8"], ["block-lot", "neighborhood", "community-district"], "The easements and neighborhood are stated in the acquisition subject."),
  "20250718038": local(["Bronx"], ["125 East 149th Street", "Block 2352, Lot 28"], ["address", "block-lot", "application"], "The lease subject states a Bronx building."),
  "20250213027": local(["Bronx"], ["Ferry Point Park", "Bronx Community District 10"], ["project", "place", "community-district", "application"], "The development subject states Ferry Point Park in the Bronx."),
  "20260608005": local(["Bronx"], ["Sojourner Truth-Mapes Rezoning", "East 182nd Street to Mapes Avenue"], ["project", "street-range", "application"], "The rezoning bounds and Bronx application suffix state the subject area."),
  "20251110002": local(["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"], ["multiple Design Commission project sites"], ["address", "street-range", "community-board"], "Every listed project site was reviewed; the agenda contains place-specific work in all five boroughs."),
  "20250303023": local(["Bronx"], ["1093-1095 Jerome Avenue", "Block 2505, Lots 26 and 28"], ["address", "block-lot"], "The HPD disposition table states the Bronx property."),
  "20260618032": local(["Bronx"], ["63 Exterior Street", "110 East 138th Street", "Block 2323"], ["address", "block-lot", "community-board", "application"], "The development sites and Bronx Community Board 1 are stated."),
  "20251014024": local(["Bronx"], ["Bronx Community Board 10"], ["community-board"], "This is the board district's capital and expense budget hearing; the board designation is subject geography."),
  "20250220033": local(["Bronx"], ["Bronx Community Board 5"], ["community-board"], "The fiscal-priorities subject is scoped to the stated community board, not merely its Davidson Avenue venue."),
  "20260618050": local(["Brooklyn"], ["289 Kent Avenue", "209 York Street", "1455 Coney Island Avenue"], ["address", "project", "community-district", "application"], "Every ULURP agenda item is stated as a Brooklyn site."),
  "20250926031": local(["Brooklyn"], ["Constellation", "395 Flatbush Avenue Extension", "1417 Avenue U"], ["project", "address", "neighborhood", "community-district"], "Every agenda subject is stated in Brooklyn; Borough Hall is the venue."),
  "20241218024": local(["Brooklyn"], ["2510 Coney Island Avenue", "73-99 Empire Boulevard", "Atlantic Avenue Mixed Use Plan"], ["project", "address", "street-range", "community-district"], "All three stated ULURP subjects are in Brooklyn."),
  "20260713032": citywide(["LockerNYC pilot for installation citywide"], "The multi-item Design Commission agenda includes an explicitly citywide project; City Hall is only the venue."),
  "20250801014": local(["Brooklyn", "Queens"], ["listed BSA PREMISES AFFECTED"], ["address", "block-lot", "community-board"], "Every BSA premises entry was reviewed; the Manhattan hearing room is excluded."),
  "20241230028": local(["Brooklyn", "Queens"], ["88-20 Astoria Boulevard", "880 Coney Island Avenue"], ["address", "block-lot", "community-board"], "The listed BSA premises are in Queens and Brooklyn; 22 Reade Street is only the venue."),
  "20260610003": local(["Brooklyn"], ["Avenue J and East 81st Street", "Brooklyn Community Board 18"], ["street-range", "community-board", "project"], "The reconstruction presentation is stated for the board's Brooklyn district."),
  "20251003004": local(["Brooklyn", "Queens"], ["Newtown Creek CSO Tunnel", "Brooklyn Community District 1", "Queens Community Districts 2 and 5"], ["project", "community-district", "application"], "The subject explicitly lists affected districts in two boroughs."),
  "20250131026": local(["Brooklyn"], ["North 7th Street between Berry Street and Bedford Avenue", "Community Board 1"], ["street-range", "community-board", "application"], "The rezoning bounds and Brooklyn board designation state the area."),
  "20260429022": local(["Queens"], ["189-10 Northern Boulevard"], ["address", "application", "community-board"], "The ULURP subject and application suffix state Queens."),
  "20251110015": local(["Queens"], ["32nd Street between 21st Avenue and Ditmars Boulevard"], ["street-range", "application", "community-district"], "The agenda's ULURP matter states a Queens street segment; Borough Hall is the venue."),
  "20250310022": local(["Queens"], ["30th Avenue, 43rd Street, and 42nd Street"], ["street-range", "application", "community-district"], "The zoning-map bounds state the Queens subject; Borough Hall is the venue."),
  "20260629003": local(["Queens", "Staten Island"], ["172-11 Northern Boulevard", "45 and 49 North Avenue"], ["address", "block-lot", "community-board"], "Every BSA premises entry was reviewed; the Manhattan hearing room is excluded."),
  "20251017018": local(["Manhattan", "Queens"], ["1440 Madison Avenue", "160-03 Rockaway Boulevard"], ["address", "block-lot", "community-board"], "Every BSA premises entry was reviewed; the Manhattan venue is not itself a subject."),
  "20250106046": local(["Queens"], ["Queens Borough Board Budget Priorities"], ["borough"], "The budget hearing explicitly develops priorities for Queens; Borough Hall is also the venue but is not the evidence used."),
  "20260527036": local(["Queens"], ["Aspen Place and Mayfield Road", "72nd Avenue and Parsons Boulevard"], ["street-range", "community-board"], "The street co-naming subjects and Queens board heading state the area."),
  "20250923014": local(["Queens"], ["217-14 24th Avenue"], ["address", "application", "community-board"], "The rezoning address and application suffix state Queens."),
  "20250123044": local(["Queens"], ["District 5, Queens"], ["community-board"], "The budget subject explicitly says it affects the communities of District 5, Queens."),
  "20260709020": local(["Staten Island"], ["Tax Block 5308, Lot 50", "Crescent Beach Park", "Community District 3"], ["block-lot", "project", "community-district"], "The acquisition subject explicitly states Staten Island."),
  "20260116030": local(["Staten Island"], ["Tax Block 4130, Lots 1 and 70", "South Shore of Staten Island", "Community Districts 2 and 3"], ["block-lot", "project", "community-district"], "The coastal protection subject explicitly states Staten Island."),
  "20251205033": local(["Staten Island"], ["300 Prospect Avenue", "Goodhue Park", "New Brighton and Randall Manor"], ["address", "project", "neighborhood"], "The acquisition subject states the Staten Island park and neighborhoods."),
  "20260515018": local(["Manhattan", "Bronx", "Queens", "Staten Island"], ["listed BSA PREMISES AFFECTED"], ["address", "block-lot", "community-board"], "Every BSA premises entry was reviewed; 22 Reade Street is only the venue."),
  "20251007004": local(["Bronx", "Brooklyn", "Staten Island"], ["5012 Hylan Boulevard", "3657 Kingsbridge Avenue", "7100 Shore Road"], ["address", "block-lot", "community-board"], "The BSA premises state three subject boroughs; the Manhattan venue is excluded."),
  "20250113005": local(["Brooklyn", "Queens", "Staten Island"], ["248-70 Horace Harding Expressway", "92 Walworth Street"], ["address", "block-lot", "community-board"], "Every BSA premises entry was reviewed; the Manhattan hearing room is excluded."),
  "20260504039": unlocated("This recurring board-calendar notice lists meeting places, not the places affected by a particular matter."),
  "20260213014": unlocated("This recurring board-calendar notice lists meeting places, not the places affected by a particular matter."),
  "20260514002": unlocated("The available notice row names a proposed rule but states no geographic area."),
  "20260410006": unlocated("The available notice row names a proposed rule but states no geographic area."),
  "20260313023": unlocated("The available notice row names a proposed rule but states no geographic area."),
  "20260210022": unlocated("The available notice row names a proposed rule but states no geographic area."),
  "20260107004": unlocated("The rule title names commercial waste zones but does not state their geographic boundaries."),
  "20251126001": local(["Brooklyn"], ["850 3rd Avenue", "Block 671, Lot 1", "Block 675, Lot 10"], ["address", "block-lot", "application"], "The lease subject explicitly states Brooklyn."),
  "20251103022": unlocated("The available notice row names a proposed rule but states no geographic area."),
  "20251006023": unlocated("The available notice row names a proposed rule but states no geographic area."),
  "20250813026": local(["Queens"], ["56-17 56th Drive"], ["address", "block-lot", "application"], "The lease subject explicitly states Queens."),
  "20250730021": unlocated("The available notice row names a proposed rule but states no geographic area."),
  "20250718035": local(["Staten Island"], ["2 Teleport Drive"], ["address", "block-lot", "application"], "The lease subject explicitly states Staten Island."),
  "20250613022": unlocated("The rule title names building types but states no geographic area."),
  "20250516025": unlocated("The available notice row names a busways rule but states no geographic area."),
  "20250418029": local(["Queens"], ["property located in the Borough of Queens"], ["borough"], "The sale subject explicitly identifies Queens; the call-in hearing has no physical venue."),
  "20250324004": unlocated("The available notice row names a drinking-water rule but states no geographic area."),
  "20250227017": unlocated("The available notice row names a cannabis-judgment rule but states no geographic area."),
  "20250131024": unlocated("The available notice row names a tax-law registration rule but states no geographic area."),
  "20241230030": unlocated("The available notice row names a property-tax rule; the Webex address fields are venue metadata, not subject geography."),
  "20260710032": unlocated("Only the 255 Greenwich Street meeting venue is stated."),
  "20260603039": unlocated("Only the 1 Centre Street meeting venue is stated."),
  "20260428021": unlocated("Only the 250 Broadway committee-room venue is stated; no agenda subjects are present in the row."),
  "20260415037": unlocated("Only the 253 Broadway meeting venue is stated."),
  "20260225001": unlocated("Only the 55 Water Street meeting venue is stated."),
  "20260129025": unlocated("Only the 1 Centre Street meeting venue is stated."),
  "20260108021": unlocated("Only the 253 Broadway meeting venue is stated."),
  "20251119030": unlocated("Only the 250 Broadway committee-room venue is stated; no agenda subjects are present in the row."),
  "20251016011": unlocated("Only the 22 Reade Street meeting venue is stated."),
  "20250919017": unlocated("Only the 22 Reade Street meeting venue is stated."),
  "20250820029": unlocated("Only the 55 Water Street meeting venue is stated."),
  "20250804032": unlocated("The rule-hearing title states no geographic area; 22 Reade Street is the venue."),
  "20250616041": unlocated("Only the 253 Broadway meeting venue is stated."),
  "20250522038": unlocated("Only the City Hall committee venue is stated; no agenda subjects are present in the row."),
  "20250428051": unlocated("Only the 55 Water Street meeting venue is stated."),
  "20250319054": unlocated("Only the 22 Reade Street meeting venue is stated."),
  "20250227023": unlocated("Only the 55 Water Street meeting venue is stated."),
  "20250205042": unlocated("Only the 1 Centre Street meeting venue is stated."),
  "20250121045": unlocated("Only the 250 Broadway committee-room venue is stated; no agenda subjects are present in the row."),
  "20241227002": unlocated("Only the 250 Vesey Street meeting venue is stated; a possible rules discussion has no stated affected area."),
  "20260528031": local(["Brooklyn"], ["9818 Fort Hamilton Parkway", "Bay Ridge", "Community Board 10"], ["address", "neighborhood", "community-board", "application"], "The subject address and ULURP/CEQR suffixes state Brooklyn; 9941 Fort Hamilton Parkway is the venue."),
  "20260601042": local(["Brooklyn"], ["132 Melrose Street", "Bay Ridge", "Community Districts 4 and 10"], ["address", "neighborhood", "community-district", "application"], "Both ULURP agenda subjects are stated in Brooklyn; Borough Hall is the venue."),
  "20260303009": local(["Brooklyn"], ["Brownsville Plan", "Community Board 16"], ["project", "community-board"], "The named plan and board designation state Brownsville, Brooklyn; St. Marks Avenue is the venue."),
  "20260413027": citywide(["Bluebelt Program for installation citywide"], "The multi-item Design Commission agenda includes an explicitly citywide project; City Hall is only the venue."),
  "20260224010": local(["Brooklyn"], ["Monitor Point"], ["project", "application"], "The CEQR title names Monitor Point; the K suffix identifies Brooklyn while 120 Broadway is the venue."),
  "20260218030": local(["Brooklyn"], ["2950 West 24th Street", "Monitor Point", "Greenpoint"], ["address", "project", "neighborhood", "community-district"], "Every stated agenda subject is in Brooklyn; Borough Hall is the venue."),
  "20260204012": local(["Brooklyn"], ["Brownsville Plan", "63 Sutter Avenue", "Community Board 16"], ["project", "address", "community-board"], "The named plan, license address, and board designation state Brooklyn; St. Marks Avenue is the venue."),
  "20260130002": local(["Queens"], ["Willets Point"], ["project", "neighborhood"], "The hearing title itself states Willets Point, Queens."),
  "20251222005": local(["Brooklyn"], ["Monitor Point", "56 Quay", "Community District 1"], ["project", "street-range", "community-district", "application"], "The project names, application suffixes, and subject text state Brooklyn."),
  "20251216019": local(["Brooklyn", "Queens"], ["Newtown Creek CSO Storage Tunnel"], ["project", "application"], "The named project spans Brooklyn and Queens; the Y CEQR suffix alone is not treated as a borough."),
  "20251112014": local(["Brooklyn", "Queens"], ["Seaside Park", "Newtown Creek", "Hunters Point, Maspeth, Greenpoint, and Williamsburg"], ["project", "neighborhood", "community-district"], "The two agenda subjects state Brooklyn and Queens; Borough Hall is the venue."),
  "20250624037": local(["Brooklyn"], ["74 Bogart Street", "58 Nixon Court", "Domino Site B"], ["address", "project", "neighborhood", "community-district"], "Every stated ULURP agenda subject is in Brooklyn; Borough Hall is the venue."),
  "20250501021": local(["Queens"], ["Jamaica Neighborhood Plan", "Queens Community Districts 8 and 12"], ["project", "community-district", "application"], "The named plan and ULURP suffix state Queens; Fresh Meadows is the venue."),
  "20250314013": local(["Brooklyn"], ["Monitor Point"], ["project", "application"], "The CEQR title names Monitor Point and its K suffix identifies Brooklyn."),
  "20250109035": local(["Manhattan", "Brooklyn", "Queens"], ["listed roadway-cafe addresses"], ["address", "borough"], "Every petition address was reviewed; the notice lists subjects in Manhattan, Brooklyn, and Queens."),
  "20260716025": unlocated("The row describes how to attend an Environmental Control Board meeting but states no agenda subject or affected area."),
  "20260522019": unlocated("The row concerns preliminary charter-review recommendations but states only an upcoming Bronx hearing venue, not an affected area."),
  "20260331010": unlocated("The NYCHA board notice states a meeting venue and says the agenda will be posted later."),
  "20260226004": unlocated("The NYCHA board notice states a meeting venue and says the agenda will be posted later."),
  "20260112016": local(["Queens"], ["Horace Harding Expressway, Francis Lewis Boulevard, and Pedestrian Way"], ["street-range", "application"], "The zoning-map bounds state Queens; Borough Hall is the venue."),
  "20251029019": unlocated("Only the 22 Cortlandt Street meeting venue is stated."),
  "20251003005": local(["Brooklyn"], ["20 Berry Street", "Block 2283", "Community District 1"], ["address", "block-lot", "community-district", "application"], "The project address, tax lots, application suffix, and subject text state Brooklyn."),
  "20250813029": local(["Brooklyn"], ["1274 Bedford Avenue", "Block 2022, Lot 18"], ["address", "block-lot", "application"], "The lease subject explicitly states Brooklyn."),
  "20250609027": unlocated("The cancellation notice mentions the 55 Water Street venue but no affected matter."),
  "20250530003": local(["Manhattan"], ["100 East 111th Street", "Block 1638, part of Lot 1"], ["address", "block-lot"], "The HPD disposition table explicitly states Manhattan; 250 Broadway is the venue."),
  "20250513005": local(["Manhattan", "Bronx", "Brooklyn", "Queens"], ["listed BSA PREMISES AFFECTED"], ["address", "block-lot", "community-board"], "Every BSA premises entry was reviewed; 22 Reade Street is only the venue."),
  "20250422035": local(["Brooklyn"], ["581 Grant Avenue", "Block 4223, Lot 1"], ["address", "block-lot"], "The HPD disposition table explicitly states Brooklyn."),
  "20250317029": local(["Brooklyn"], ["North 7th Street between Berry Street and Bedford Avenue", "236 Gold Street", "47 Hall Street"], ["street-range", "address", "neighborhood", "block-lot"], "Every ULURP agenda subject is stated in Brooklyn; Borough Hall is the venue."),
  "20250204017": unlocated("Only the 55 Water Street meeting venue is stated."),
  "20241204003": unlocated("Only the 55 Water Street meeting venue is stated."),
};

function plainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x?[0-9a-f]+;/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function body(row) {
  return plainText([
    row.short_title,
    ...FIELDS.slice(13).map((field) => row[field]),
  ].filter(Boolean).join(" "));
}

function spread(rows, count) {
  if (rows.length <= count) return rows;
  return Array.from({ length: count }, (_, index) => (
    rows[Math.floor(index * (rows.length - 1) / Math.max(1, count - 1))]
  ));
}

const responseUrl = new URL(SOURCE);
responseUrl.searchParams.set("$select", FIELDS.join(","));
responseUrl.searchParams.set(
  "$where",
  `(section_name="Public Hearings and Meetings" OR `
    + `(section_name="Agency Rules" AND type_of_notice_description="Public Hearings" `
    + `AND event_date IS NOT NULL)) AND start_date >= "${START_DATE}"`,
);
responseUrl.searchParams.set("$order", "start_date DESC");
responseUrl.searchParams.set("$limit", "2000");

const response = await fetch(responseUrl);
if (!response.ok) throw new Error(`City Record snapshot failed: HTTP ${response.status}`);
const rows = await response.json();
if (!Array.isArray(rows)) throw new Error("City Record snapshot was not an array");

const chosen = [];
const used = new Set();

function take(name, candidates, count, expectedBorough = null) {
  const unique = candidates.filter((row) => {
    if (used.has(row.request_id)) return false;
    const text = body(row);
    const duplicate = chosen.some((item) => body(item.row).slice(0, 500) === text.slice(0, 500));
    return text && !duplicate;
  });
  for (const row of spread(unique, count)) {
    used.add(row.request_id);
    chosen.push({
      cohort: name,
      row: Object.fromEntries(FIELDS.filter((field) => row[field] != null).map((field) => [field, row[field]])),
      expected: {
        scope: null,
        boroughs: expectedBorough ? [expectedBorough] : [],
        stated_areas: [],
        area_types: [],
      },
      labeling_note: "",
    });
  }
}

const byBorough = (borough, predicate) => rows.filter((row) => {
  const text = body(row);
  return BOROUGHS.find(([name]) => name === borough)[1].test(text) && predicate(row, text);
});

for (const [borough] of BOROUGHS) {
  take(
    "application-reference",
    byBorough(borough, (_row, text) => (
      /\b(?:ULURP|CEQR|C\s*\d{6}\s*Z[A-Z]{1,2}|N\s*\d{6}\s*Z[A-Z]{1,2})\b/i.test(text)
      && text.length <= 9000
      && (text.match(/\bin the matter of\b/gi) || []).length <= 2
    )),
    3,
    borough,
  );
  take(
    "spatial-description",
    byBorough(borough, (_row, text) => (
      /\b(?:bounded by|between .{2,80} and |tax (?:block|lot)|block\s+\d|lots?\s+\d|BBL|premises affected|property located at)\b/i.test(text)
      && text.length <= 9000
      && (text.match(/\bin the matter of\b/gi) || []).length <= 2
    )),
    3,
    borough,
  );
  take(
    "community-board",
    byBorough(borough, (row, text) => (
      row.agency_name === "Community Boards"
      && /\bcommunity board (?:no\.?\s*)?\d{1,2}\b/i.test(text)
      && text.length <= 6000
    )),
    3,
    borough,
  );
}

take(
  "citywide-or-rule",
  rows.filter((row) => {
    const text = body(row);
    return text.length <= 7000 && (
      /\b(?:citywide|throughout (?:new york )?city|all five boroughs)\b/i.test(text)
      || row.section_name === "Agency Rules"
    );
  }),
  20,
);

const venueOnlyAgencies = new Set([
  "Board Meetings",
  "Board of Education Retirement System",
  "Charter Revision Commission",
  "City Council",
  "Comptroller",
  "Conflicts of Interest Board",
  "Equal Employment Practices Commission",
  "Franchise and Concession Review Committee",
  "Office of Labor Relations",
  "Teachers' Retirement System",
]);
take(
  "venue-confusion",
  rows.filter((row) => {
    const text = body(row);
    const venue = plainText([
      row.building_name, row.street_address_1, row.street_address_2,
      row.city, row.state, row.zip_code,
    ].filter(Boolean).join(", "));
    return venueOnlyAgencies.has(row.agency_name)
      && venue
      && text.length <= 1800
      && !/\b(?:in the matter of|premises affected|property located|project area|bounded by|ULURP|CEQR|citywide|all five boroughs)\b/i.test(text);
  }),
  20,
);

take(
  "named-project-or-place",
  rows.filter((row) => {
    const text = body(row);
    return text.length <= 8000
      && /\b(?:Brownsville Plan|Jamaica Neighborhood Plan|Monitor Point|One45|Newtown Creek|Gowanus|Willets Point|South Shore of Staten Island|Bay Ridge)\b/i.test(text);
  }),
  15,
);

take(
  "general-mixed",
  rows.filter((row) => {
    const text = body(row);
    return text.length >= 180 && text.length <= 3500;
  }),
  15,
);

if (chosen.length < 105) {
  throw new Error(`Sampler produced only ${chosen.length} unique notices; expected at least 105`);
}
const chosenIds = new Set(chosen.map((item) => item.row.request_id));
const missingLabels = chosen.filter((item) => !LABELS[item.row.request_id]).map((item) => item.row.request_id);
const staleLabels = Object.keys(LABELS).filter((requestId) => !chosenIds.has(requestId));
if (missingLabels.length || staleLabels.length) {
  throw new Error(`Label mismatch; missing=${missingLabels.join(",")} stale=${staleLabels.join(",")}`);
}
for (const item of chosen) {
  const { note, ...expected } = LABELS[item.row.request_id];
  item.expected = expected;
  item.labeling_note = note;
}

const fixture = {
  schema_version: 1,
  source: {
    name: "The City Record Online",
    dataset: "dg92-zbpx",
    url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
    captured_at: CAPTURED_AT,
    query: {
      start_date_gte: START_DATE,
      sections: ["Public Hearings and Meetings", "Agency Rules / Public Hearings"],
    },
  },
  labeling: {
    status: "hand-labelled",
    labelled_at: CAPTURED_AT,
    unit_of_scoring: "notice-level affected-area detection plus exact borough-set agreement",
    instructions: [
      "Read the notice text and venue fields separately.",
      "Record only affected areas stated for the subject; never copy a meeting venue.",
      "Use scope=unlocated only when no affected borough, neighborhood, board/district, address, street range, tax lot, application-linked borough, or named local project is stated.",
      "Use scope=citywide only when the notice explicitly says citywide, throughout New York City, or all five boroughs.",
    ],
  },
  notices: chosen,
};

await writeFile(OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${chosen.length} pinned notices to ${OUTPUT.pathname}`);
