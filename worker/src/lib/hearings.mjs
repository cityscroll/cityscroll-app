// Pure hearing normalization for the daily read model and location-aware alert matching.
// Venue and affected area are deliberately separate: the place where officials meet is not
// evidence that the matter affects that place.

import {
  ADDRESS_RE,
  applicationSignals,
  boroughsIn,
  communityBoardSignals,
  normalizeAddress,
  plainText,
  streetRangesIn,
  taxLotsIn,
  unique,
} from "../../../location_extract.mjs";

export { plainText };

const AUDIENCES = [
  [/\b(?:outdoor dining|sidewalk cafe|roadway cafe|restaurant)\b/i,
    "audience_restaurants"],
  [/\b(?:taxi|for-hire vehicle|fhv|commercial vehicle|parking meter)\b/i,
    "audience_curb"],
  [/\b(?:zoning|land use|rezon|special district|development)\b/i,
    "audience_land_use"],
  [/\b(?:building code|energy conservation code|construction code|façade|facade)\b/i,
    "audience_buildings"],
  [/\b(?:property acquisition|acquisition of|disposition of|subject property|easement)\b/i,
    "audience_property"],
  [/\b(?:school|student|education)\b/i,
    "audience_schools"],
  [/\b(?:health|hospital|clinic|patient)\b/i,
    "audience_health"],
  [/\b(?:vendor|license|permit|business)\b/i,
    "audience_businesses"],
];

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const PROJECT_GAZETTEER = [
  { name: "Brownsville Plan", pattern: /\bBrownsville Plan\b/i, boroughs: ["Brooklyn"], neighborhoods: ["Brownsville"] },
  { name: "Jamaica Neighborhood Plan", pattern: /\bJamaica Neighborhood Plan\b/i, boroughs: ["Queens"], neighborhoods: ["Jamaica"] },
  { name: "Monitor Point", pattern: /\bMonitor Point\b/i, boroughs: ["Brooklyn"], neighborhoods: ["Greenpoint"] },
  { name: "Newtown Creek", pattern: /\bNewtown Creek\b/i, boroughs: ["Brooklyn", "Queens"], neighborhoods: [] },
  { name: "Willets Point", pattern: /\bWillets Point\b/i, boroughs: ["Queens"], neighborhoods: ["Willets Point"] },
  { name: "One45", pattern: /\bOne45\b/i, boroughs: ["Manhattan"], neighborhoods: ["Harlem"] },
  { name: "Ferry Point Park", pattern: /\bFerry Point Park\b/i, boroughs: ["Bronx"], neighborhoods: [] },
  { name: "Lincoln Center West", pattern: /\bLincoln Center West\b/i, boroughs: ["Manhattan"], neighborhoods: [] },
  { name: "South Shore of Staten Island", pattern: /\b(?:South Shore of Staten Island|Line of Protection)\b/i, boroughs: ["Staten Island"], neighborhoods: [] },
  { name: "Bay Ridge", pattern: /\bBay Ridge\b/i, boroughs: ["Brooklyn"], neighborhoods: ["Bay Ridge"] },
  { name: "Gowanus", pattern: /\bGowanus\b/i, boroughs: ["Brooklyn"], neighborhoods: ["Gowanus"] },
  { name: "Crescent Beach Park", pattern: /\bCrescent Beach Park\b/i, boroughs: ["Staten Island"], neighborhoods: [] },
  { name: "Goodhue Park", pattern: /\bGoodhue Park\b/i, boroughs: ["Staten Island"], neighborhoods: [] },
];

function subjectText(text) {
  const markers = [
    /\bin the matters? of\b/i,
    /\bpremises affected\b/i,
    /\bsubject propert(?:y|ies)\b/i,
    /\bpremises (?:known as|located at)\b/i,
    /\bproperty located at\b/i,
    /\bthe following agenda items? will be heard\b/i,
    /\bthe following public hearing items?\b/i,
    /\bon the following petitions?\b/i,
    /\bconsent items\b/i,
    /\bagenda\s+project name\b/i,
    /\bdisposition area\b/i,
    /\bpublic hearing (?:with respect to|regarding|concerning)\b/i,
    /\bone or more of the boroughs?\b/i,
    /\b(?:Manhattan|Bronx|Brooklyn|Queens|Staten Island) borough (?:board|president).{0,120}?\b(?:public )?hearing on\b/i,
  ];
  const starts = markers.map((pattern) => pattern.exec(text)?.index).filter(Number.isInteger);
  if (!starts.length) return "";
  const start = Math.min(...starts);
  return text.slice(start, start + 16000)
    .split(/\b(?:further information|public inspection|if you need (?:an )?accommodation)\b/i)[0];
}

export function affectedAreaFromRow(row) {
  const title = plainText(row.short_title);
  const body = plainText([
    title,
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.other_info_1,
    row.other_info_2,
    row.other_info_3,
    row.printout_1,
    row.printout_2,
    row.printout_3,
  ].filter(Boolean).join(" "));
  const subject = subjectText(body);
  // Limit free-form place extraction to the title and an explicitly marked subject segment.
  // Formal application/community-board designations are safe supplemental evidence; arbitrary
  // body places are not, because they turn a Manhattan meeting room into a Manhattan matter.
  const localText = [title, subject].filter(Boolean).join(" ");
  const applications = applicationSignals(localText);
  const boards = communityBoardSignals(body);
  const gazetteer = PROJECT_GAZETTEER.filter((entry) => entry.pattern.test(localText));
  const boroughs = unique([
    ...boroughsIn(localText),
    ...applications.boroughs,
    ...boards.boroughs,
    ...gazetteer.flatMap((entry) => entry.boroughs),
  ]);
  const neighborhoods = unique([
    ...[...localText.matchAll(/\b(?:neighbou?rhood of|located in|within)\s+([A-Z][A-Za-z.'’ -]{2,45}?)(?=,|\s+(?:neighbou?rhood|community district|in (?:Manhattan|Brooklyn|Queens|the Bronx|Staten Island))\b|[.;])/gi)]
      .map((match) => plainText(match[1]).replace(/^the\s+/i, "")),
    ...gazetteer.flatMap((entry) => entry.neighborhoods),
  ]);
  const community_districts = unique([...localText.matchAll(/\bcommunity districts?\s+((?:\d{1,2})(?:\s*(?:,|and|&)\s*\d{1,2})*)/gi)]
    .flatMap((match) => match[1].match(/\d{1,2}/g) || []));
  const addresses = unique((subject.match(ADDRESS_RE) || []).map(normalizeAddress));
  const street_ranges = streetRangesIn(subject);
  const tax_lots = taxLotsIn(subject);
  const citywide = /\b(?:citywide(?! (?:administrative|personnel) services)|throughout (?:new york )?city|all five boroughs)\b/i.test(body);
  const project_names = gazetteer.map((entry) => entry.name);
  const local = boroughs.length || neighborhoods.length || community_districts.length
    || boards.boards.length || addresses.length || street_ranges.length || tax_lots.length
    || project_names.length || applications.numbers.length;
  return {
    scope: citywide ? "citywide" : local ? "local" : "unlocated",
    boroughs,
    neighborhoods,
    community_districts,
    community_boards: boards.boards,
    addresses: addresses.map((label) => ({ label })),
    street_ranges: street_ranges.map((label) => ({ label })),
    tax_lots: tax_lots.map((label) => ({ label })),
    project_names,
    application_numbers: applications.numbers,
  };
}

export function venueFromRow(row) {
  const body = plainText([
    row.additional_description_1,
    row.other_info_1,
    row.printout_1,
  ].filter(Boolean).join(" "));
  const address = normalizeAddress([
    row.street_address_1,
    row.street_address_2,
    row.city,
    row.state,
    row.zip_code,
  ].filter(Boolean).join(", "));
  const virtual = /\b(?:online|conference call|zoom|webex|teams meeting|join (?:the )?(?:meeting|hearing)|via (?:phone|telephone|video))\b/i.test(body)
    || /https?:\/\//i.test(body);
  const inPerson = !!address;
  return {
    mode: virtual && inPerson ? "hybrid" : virtual ? "virtual" : inPerson ? "in-person" : "not-stated",
    building: plainText(row.building_name),
    address: address || null,
    borough: null,
    neighborhood: null,
  };
}

function decisionSummary(row, body) {
  const title = plainText(row.short_title);
  if (title && !/^(?:public )?(?:hearing|meeting)s?(?: notice)?$/i.test(title)) return title;
  const matter = /\bin the matter of\s+(.{20,260}?)(?=\.\s|$)/i.exec(body);
  if (matter) return plainText(matter[1]);
  const proposing = /\bwhat (?:is|are) (?:the agency|we) proposing\??\s*(.{20,260}?)(?=\.\s|$)/i.exec(body);
  if (proposing) return plainText(proposing[1]);
  return title || "The notice does not give a short plain-language summary.";
}

function participationFromRow(row, body, sourceUrl) {
  const links = unique(body.match(URL_RE) || []).slice(0, 8).map((url) => ({
    label: /\b(?:zoom|webex|teams|meet\.google)\b/i.test(url) ? "Join online" : "Participation link",
    url: url.replace(/[.,;]+$/, ""),
  }));
  const emails = unique([...body.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)].map((match) => match[0])).slice(0, 4);
  const phones = unique([...body.matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g)].map((match) => match[0])).slice(0, 4);
  return {
    links,
    emails,
    phones,
    source_url: sourceUrl,
  };
}

export function normalizeHearing(row) {
  const body = plainText([
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.other_info_1,
    row.other_info_2,
    row.other_info_3,
    row.printout_1,
    row.printout_2,
    row.printout_3,
  ].filter(Boolean).join(" "));
  const sourceUrl = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(row.request_id || "")}`;
  const audience = AUDIENCES.find(([pattern]) => pattern.test(`${row.short_title || ""} ${body}`));
  return {
    request_id: String(row.request_id || ""),
    source_section: row.section_name || null,
    agency: row.agency_name || null,
    notice_type: row.type_of_notice_description || null,
    title: plainText(row.short_title) || "Untitled hearing",
    event_date: row.event_date || null,
    published_at: row.start_date || null,
    decides: decisionSummary(row, body),
    affects: audience ? [audience[1]] : [],
    affected_area: affectedAreaFromRow(row),
    venue: venueFromRow(row),
    participation: participationFromRow(row, body, sourceUrl),
    source_url: sourceUrl,
    description: body.slice(0, 1200),
  };
}

export function applyGeocode(record, geocodes) {
  const out = structuredClone(record);
  if (out.venue.address && geocodes[out.venue.address]) {
    const venueGeo = geocodes[out.venue.address];
    out.venue.borough = venueGeo.borough || null;
    out.venue.neighborhood = venueGeo.neighborhood || null;
    if (Number.isFinite(venueGeo.latitude)) out.venue.latitude = venueGeo.latitude;
    if (Number.isFinite(venueGeo.longitude)) out.venue.longitude = venueGeo.longitude;
  }
  out.affected_area.addresses = out.affected_area.addresses.map((address) => {
    const geo = geocodes[address.label] || {};
    return {
      label: address.label,
      borough: geo.borough || null,
      neighborhood: geo.neighborhood || null,
      // Place-mapping fields (Dining Out cafe pins and other subject addresses).
      latitude: Number.isFinite(geo.latitude) ? geo.latitude : null,
      longitude: Number.isFinite(geo.longitude) ? geo.longitude : null,
      bbl: /^\d{10}$/.test(geo.bbl || "") ? geo.bbl : null,
      community_district: geo.community_district || null,
      council_district: geo.council_district || null,
    };
  });
  out.affected_area.boroughs = unique([
    ...out.affected_area.boroughs,
    ...out.affected_area.addresses.map((address) => address.borough),
  ]);
  out.affected_area.neighborhoods = unique([
    ...out.affected_area.neighborhoods,
    ...out.affected_area.addresses.map((address) => address.neighborhood),
  ]);
  if (out.affected_area.scope === "unlocated" && out.affected_area.boroughs.length) {
    out.affected_area.scope = "local";
  }
  return out;
}

export function hearingMatchesLocation(rowOrRecord, filter = {}) {
  const record = rowOrRecord?.affected_area ? rowOrRecord : normalizeHearing(rowOrRecord || {});
  const area = record.affected_area;
  const borough = String(filter.borough || "").toLowerCase();
  const neighborhood = String(filter.neighborhood || "").trim().toLowerCase();
  if (filter.locationScope === "citywide-unlocated") {
    if (area.scope !== "citywide" && area.scope !== "unlocated") return false;
  } else if (borough) {
    if (area.scope !== "citywide"
        && !area.boroughs.some((value) => String(value).toLowerCase() === borough)) return false;
  }
  if (neighborhood && area.scope !== "citywide") {
    const haystack = [
      ...area.neighborhoods,
      ...area.addresses.map((address) => address.label),
      record.description,
    ].join(" ").toLowerCase();
    if (!haystack.includes(neighborhood)) return false;
  }
  return true;
}

export function dateWindowEnd(todayISO, dateWindow) {
  const date = new Date(`${todayISO.slice(0, 10)}T00:00:00Z`);
  if (dateWindow === "week") date.setUTCDate(date.getUTCDate() + 7);
  else if (dateWindow === "month") date.setUTCDate(date.getUTCDate() + 30);
  else return null;
  return date.toISOString().slice(0, 10);
}
