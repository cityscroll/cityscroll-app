// Pure hearing normalization for the daily read model and location-aware alert matching.
// Venue and affected area are deliberately separate: the place where officials meet is not
// evidence that the matter affects that place.

const BOROUGHS = [
  ["Manhattan", /\b(?:manhattan|new york county)\b/i],
  ["Bronx", /\b(?:the bronx|bronx county)\b/i],
  ["Brooklyn", /\b(?:brooklyn|kings county)\b/i],
  ["Queens", /\b(?:queens|queens county)\b/i],
  ["Staten Island", /\b(?:staten island|richmond county)\b/i],
];

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

const ADDRESS_RE = /\b\d{1,5}(?:-\d{1,5})?\s+[A-Z0-9][A-Z0-9.'’ -]{1,70}\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway)\b(?:[^.;<\n]{0,45})?/gi;
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export function plainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x?[0-9a-f]+;/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeAddress(value) {
  return plainText(value).replace(/\s*,\s*/g, ", ").replace(/[.,;:\s]+$/, "").trim();
}

function boroughsIn(text) {
  return BOROUGHS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function subjectSegment(text) {
  const marker = /\b(?:in the matter of|subject propert(?:y|ies)|premises (?:known as|located at)|property located at)\b/i.exec(text);
  if (!marker) return "";
  return text.slice(marker.index, marker.index + 1200)
    .split(/\b(?:further information|the proposed (?:acquisition|rule)|public inspection|if you need)\b/i)[0];
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
  ].filter(Boolean).join(" "));
  const subject = subjectSegment(body);
  // Only the title and an explicitly marked subject segment are affected-area evidence.
  // The free-form body often repeats the hearing venue; treating any body-place as the subject
  // silently turns a Manhattan meeting room into a Manhattan-only matter.
  const localText = [title, subject].filter(Boolean).join(" ");
  const boroughs = unique(boroughsIn(localText));
  const neighborhoods = unique([...localText.matchAll(/\b(?:neighbou?rhood of|located in|within)\s+([A-Z][A-Za-z.'’ -]{2,45}?)(?=,|\s+(?:neighbou?rhood|community district|in (?:Manhattan|Brooklyn|Queens|the Bronx|Staten Island))\b|[.;])/gi)]
    .map((match) => plainText(match[1]).replace(/^the\s+/i, "")));
  const community_districts = unique([...localText.matchAll(/\bcommunity districts?\s+((?:\d{1,2})(?:\s*(?:,|and|&)\s*\d{1,2})*)/gi)]
    .flatMap((match) => match[1].match(/\d{1,2}/g) || []));
  const addresses = unique((subject.match(ADDRESS_RE) || []).map(normalizeAddress));
  const citywide = /\b(?:citywide|throughout (?:new york )?city|all five boroughs)\b/i.test(body);
  const local = boroughs.length || neighborhoods.length || community_districts.length || addresses.length;
  return {
    scope: citywide ? "citywide" : local ? "local" : "unlocated",
    boroughs,
    neighborhoods,
    community_districts,
    addresses: addresses.map((label) => ({ label })),
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
    out.venue.borough = geocodes[out.venue.address].borough || null;
    out.venue.neighborhood = geocodes[out.venue.address].neighborhood || null;
  }
  out.affected_area.addresses = out.affected_area.addresses.map((address) => {
    const geo = geocodes[address.label] || {};
    return {
      label: address.label,
      borough: geo.borough || null,
      neighborhood: geo.neighborhood || null,
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
