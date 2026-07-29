// Browser fallback for the Worker-precomputed hearing view. The Worker and this file
// intentionally share contract fixtures (test/contract/hearing_location.test.mjs): the static
// site still works when the optional API is unavailable.

var HEARING_BOROUGHS = [
  ["Manhattan", /\b(?:manhattan|new york county)\b/i],
  ["Bronx", /\b(?:the bronx|bronx county)\b/i],
  ["Brooklyn", /\b(?:brooklyn|kings county)\b/i],
  ["Queens", /\b(?:queens|queens county)\b/i],
  ["Staten Island", /\b(?:staten island|richmond county)\b/i],
];
var HEARING_AUDIENCES = [
  [/\b(?:outdoor dining|sidewalk cafe|roadway cafe|restaurant)\b/i, "audience_restaurants"],
  [/\b(?:taxi|for-hire vehicle|fhv|commercial vehicle|parking meter)\b/i, "audience_curb"],
  [/\b(?:zoning|land use|rezon|special district|development)\b/i, "audience_land_use"],
  [/\b(?:building code|energy conservation code|construction code|façade|facade)\b/i, "audience_buildings"],
  [/\b(?:property acquisition|acquisition of|disposition of|subject property|easement)\b/i, "audience_property"],
  [/\b(?:school|student|education)\b/i, "audience_schools"],
  [/\b(?:health|hospital|clinic|patient)\b/i, "audience_health"],
  [/\b(?:vendor|license|permit|business)\b/i, "audience_businesses"],
];
var HEARING_ADDRESS_RE = /\b\d{1,5}(?:-\d{1,5})?\s+[A-Z0-9][A-Z0-9.'’ -]{1,70}\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway)\b(?:[^.;<\n]{0,45})?/gi;
var HEARING_URL_RE = /https?:\/\/[^\s<>"')]+/gi;

function hearingPlainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ").replace(/<\/p\s*>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&#x?[0-9a-f]+;/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
function hearingUnique(values) { return Array.from(new Set((values || []).filter(Boolean))); }
function hearingAddress(value) {
  return hearingPlainText(value).replace(/\s*,\s*/g, ", ").replace(/[.,;:\s]+$/, "").trim();
}
function hearingSubjectSegment(text) {
  var marker = /\b(?:in the matter of|subject propert(?:y|ies)|premises (?:known as|located at)|property located at)\b/i.exec(text);
  if (!marker) return "";
  return text.slice(marker.index, marker.index + 1200)
    .split(/\b(?:further information|the proposed (?:acquisition|rule)|public inspection|if you need)\b/i)[0];
}
function hearingAffectedArea(row) {
  var title = hearingPlainText(row.short_title);
  var body = hearingPlainText([
    title, row.additional_description_1, row.additional_description_2,
    row.additional_description_3, row.other_info_1, row.other_info_2, row.other_info_3,
    row.printout_1,
  ].filter(Boolean).join(" "));
  // Keep venue prose out of affected-area inference: only the title and an explicitly
  // marked subject segment can establish a local scope.
  var localText = [title, hearingSubjectSegment(body)].filter(Boolean).join(" ");
  var boroughs = hearingUnique(HEARING_BOROUGHS.filter(function (entry) {
    return entry[1].test(localText);
  }).map(function (entry) { return entry[0]; }));
  var neighborhoods = hearingUnique(Array.from(localText.matchAll(/\b(?:neighbou?rhood of|located in|within)\s+([A-Z][A-Za-z.'’ -]{2,45}?)(?=,|\s+(?:neighbou?rhood|community district|in (?:Manhattan|Brooklyn|Queens|the Bronx|Staten Island))\b|[.;])/gi))
    .map(function (match) { return hearingPlainText(match[1]).replace(/^the\s+/i, ""); }));
  var communityDistricts = hearingUnique(Array.from(localText.matchAll(/\bcommunity districts?\s+((?:\d{1,2})(?:\s*(?:,|and|&)\s*\d{1,2})*)/gi))
    .flatMap(function (match) { return match[1].match(/\d{1,2}/g) || []; }));
  var subject = hearingSubjectSegment(body);
  var addresses = hearingUnique((subject.match(HEARING_ADDRESS_RE) || []).map(hearingAddress));
  var citywide = /\b(?:citywide|throughout (?:new york )?city|all five boroughs)\b/i.test(body);
  var local = boroughs.length || neighborhoods.length || communityDistricts.length || addresses.length;
  return {
    scope: citywide ? "citywide" : local ? "local" : "unlocated",
    boroughs: boroughs, neighborhoods: neighborhoods, community_districts: communityDistricts,
    addresses: addresses.map(function (label) { return { label: label }; }),
  };
}
function hearingVenue(row) {
  var body = hearingPlainText([row.additional_description_1, row.other_info_1, row.printout_1].filter(Boolean).join(" "));
  var address = hearingAddress([row.street_address_1, row.street_address_2, row.city, row.state, row.zip_code].filter(Boolean).join(", "));
  var virtual = /\b(?:online|conference call|zoom|webex|teams meeting|join (?:the )?(?:meeting|hearing)|via (?:phone|telephone|video))\b/i.test(body)
    || /https?:\/\//i.test(body);
  return {
    mode: virtual && address ? "hybrid" : virtual ? "virtual" : address ? "in-person" : "not-stated",
    building: hearingPlainText(row.building_name), address: address || null, borough: null, neighborhood: null,
  };
}
function hearingDecision(row, body) {
  var title = hearingPlainText(row.short_title);
  if (title && !/^(?:public )?(?:hearing|meeting)s?(?: notice)?$/i.test(title)) return title;
  var matter = /\bin the matter of\s+(.{20,260}?)(?=\.\s|$)/i.exec(body);
  return matter ? hearingPlainText(matter[1]) : title || "The notice does not give a short plain-language summary.";
}
function normalizeHearingRow(row) {
  var body = hearingPlainText([
    row.additional_description_1, row.additional_description_2, row.additional_description_3,
    row.other_info_1, row.other_info_2, row.other_info_3, row.printout_1, row.printout_2, row.printout_3,
  ].filter(Boolean).join(" "));
  var source = "https://a856-cityrecord.nyc.gov/RequestDetail/" + encodeURIComponent(row.request_id || "");
  var audience = HEARING_AUDIENCES.find(function (entry) { return entry[0].test((row.short_title || "") + " " + body); });
  return {
    request_id: String(row.request_id || ""), source_section: row.section_name || null,
    agency: row.agency_name || null, notice_type: row.type_of_notice_description || null,
    title: hearingPlainText(row.short_title) || "Untitled hearing", event_date: row.event_date || null,
    published_at: row.start_date || null, decides: hearingDecision(row, body),
    affects: audience ? [audience[1]] : [], affected_area: hearingAffectedArea(row),
    venue: hearingVenue(row),
    participation: {
      links: hearingUnique(body.match(HEARING_URL_RE) || []).slice(0, 8).map(function (url) {
        return { label: /\b(?:zoom|webex|teams|meet\.google)\b/i.test(url) ? "Join online" : "Participation link", url: url.replace(/[.,;]+$/, "") };
      }),
      emails: hearingUnique(Array.from(body.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)).map(function (match) { return match[0]; })).slice(0, 4),
      phones: hearingUnique(Array.from(body.matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g)).map(function (match) { return match[0]; })).slice(0, 4),
      source_url: source,
    },
    source_url: source, description: body.slice(0, 1200),
  };
}
function hearingMatchesArea(record, filter) {
  var f = filter || {}, area = record.affected_area || {}, borough = String(f.borough || "").toLowerCase();
  var neighborhood = String(f.neighborhood || "").trim().toLowerCase();
  if (f.locationScope === "citywide-unlocated") {
    if (area.scope !== "citywide" && area.scope !== "unlocated") return false;
  } else if (borough && area.scope !== "citywide"
      && !(area.boroughs || []).some(function (value) { return String(value).toLowerCase() === borough; })) return false;
  if (neighborhood && area.scope !== "citywide") {
    var haystack = [].concat(area.neighborhoods || [], (area.addresses || []).map(function (address) { return address.label; }), record.description || "").join(" ").toLowerCase();
    if (!haystack.includes(neighborhood)) return false;
  }
  return true;
}
function hearingDateWindowEnd(today, windowName) {
  var date = new Date(String(today).slice(0, 10) + "T00:00:00Z");
  if (windowName === "week") date.setUTCDate(date.getUTCDate() + 7);
  else if (windowName === "month") date.setUTCDate(date.getUTCDate() + 30);
  else return null;
  return date.toISOString().slice(0, 10);
}

// Progressive query relaxation for time-scoped hearing searches. Every rung preserves
// agency, subject, and affected-area filters; only the date window changes. The caller
// supplies past rows when it reaches the final rung, so normal upcoming views keep their
// one-request path.
function hearingScopeLadder(requested) {
  if (requested === "week") return ["week", "month", "upcoming", "past"];
  if (requested === "month") return ["month", "upcoming", "past"];
  if (requested === "past") return ["past"];
  return ["upcoming", "past"];
}
function hearingRowsInScope(records, filter, scope, today) {
  var start = String(today).slice(0, 10);
  var end = hearingDateWindowEnd(start, scope);
  var agency = String(filter.agency || "");
  var keyword = String(filter.keyword || "").trim().toLowerCase();
  return (records || []).filter(function (record) {
    var date = String(record.event_date || "").slice(0, 10);
    if (!date) return false;
    if (scope === "past") {
      if (date >= start) return false;
    } else if (date < start || (end && date > end)) {
      return false;
    }
    if (agency && record.agency !== agency) return false;
    if (!hearingMatchesArea(record, filter)) return false;
    if (keyword) {
      var haystack = [
        record.title, record.decides, record.description,
        (record.affects || []).join(" "),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  }).sort(function (a, b) {
    var av = String(a.event_date || ""), bv = String(b.event_date || "");
    return scope === "past" ? bv.localeCompare(av) : av.localeCompare(bv);
  });
}
function chooseHearingScope(records, filter, today, allowWidening) {
  var requested = filter.when || "upcoming";
  var ladder = allowWidening === false ? [requested] : hearingScopeLadder(requested);
  for (var i = 0; i < ladder.length; i++) {
    var scope = ladder[i];
    var rows = hearingRowsInScope(records, filter, scope, today);
    if (rows.length) {
      return { requested: requested, scope: scope, widened: scope !== requested, rows: rows };
    }
  }
  return { requested: requested, scope: requested, widened: false, rows: [] };
}

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = {
    chooseHearingScope: chooseHearingScope,
    hearingAffectedArea: hearingAffectedArea,
    hearingDateWindowEnd: hearingDateWindowEnd,
    hearingMatchesArea: hearingMatchesArea,
    hearingPlainText: hearingPlainText,
    hearingRowsInScope: hearingRowsInScope,
    hearingScopeLadder: hearingScopeLadder,
    hearingVenue: hearingVenue,
    normalizeHearingRow: normalizeHearingRow,
  };
}
