// Browser fallback for the Worker-precomputed hearing view. The Worker and this file
// intentionally share contract fixtures (test/contract/hearing_location.test.mjs): the static
// site still works when the optional API is unavailable.

var HEARING_BOROUGHS = [
  ["Manhattan", /\b(?:manhattan|new york county)\b/i],
  ["Bronx", /\b(?:the bronx|bronx county|bronx)\b/i],
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
var HEARING_ADDRESS_RE = /\b\d{1,5}(?:-\d{1,5})?(?!\s*(?:feet|foot|ft\.?|square|sf)\b)\s+[A-Z0-9][A-Z0-9.'’ -]{1,60}?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway)\b/gi;
var HEARING_URL_RE = /https?:\/\/[^\s<>"')]+/gi;
var HEARING_APPLICATION_BOROUGHS = {
  M: "Manhattan", X: "Bronx", K: "Brooklyn", Q: "Queens", R: "Staten Island",
};
var HEARING_BOARD_BOROUGHS = {
  M: "Manhattan", BX: "Bronx", BK: "Brooklyn", Q: "Queens", SI: "Staten Island",
};
var HEARING_PROJECT_GAZETTEER = [
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

// Hand-synced with site/text_clean.mjs cleanNoticeText (browser script can't import ESM here).
// Decode entities BEFORE any card truncates/escapes, or named forms like &ldquo; re-escape to
// the literal string "&ldquo;" in preview cards (notice 20220525018 field case).
function hearingDecodeEntities(value) {
  var named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0",
    ldquo: "\u201C", rdquo: "\u201D", lsquo: "\u2018", rsquo: "\u2019",
    sbquo: "\u201A", bdquo: "\u201E", ndash: "\u2013", mdash: "\u2014",
    hellip: "\u2026", bull: "\u2022", middot: "\u00B7", sect: "\u00A7",
    para: "\u00B6", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
    deg: "\u00B0", times: "\u00D7", divide: "\u00F7", plusmn: "\u00B1",
    frac12: "\u00BD", frac14: "\u00BC", frac34: "\u00BE", euro: "\u20AC",
    pound: "\u00A3", yen: "\u00A5", cent: "\u00A2"
  };
  var out = String(value == null ? "" : value);
  for (var pass = 0; pass < 2; pass++) {
    var next = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, function (match, body) {
      if (body.charAt(0) === "#") {
        var code = (body.charAt(1) === "x" || body.charAt(1) === "X")
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try { return String.fromCodePoint(code); } catch (e) { return match; }
      }
      var key = String(body).toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}
function hearingPlainText(value) {
  if (value == null || value === "") return "";
  return hearingDecodeEntities(
    String(value)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
function hearingUnique(values) { return Array.from(new Set((values || []).filter(Boolean))); }
function hearingAddress(value) {
  return hearingPlainText(value).replace(/\s*,\s*/g, ", ").replace(/[.,;:\s]+$/, "").trim();
}
function hearingCanonicalBorough(value) {
  var found = HEARING_BOROUGHS.find(function (entry) { return entry[1].test(value); });
  return found ? found[0] : hearingPlainText(value);
}
function hearingSubjectText(text) {
  var markers = [
    /\bin the matters? of\b/i, /\bpremises affected\b/i, /\bsubject propert(?:y|ies)\b/i,
    /\bpremises (?:known as|located at)\b/i, /\bproperty located at\b/i,
    /\bthe following agenda items? will be heard\b/i, /\bthe following public hearing items?\b/i,
    /\bon the following petitions?\b/i, /\bconsent items\b/i, /\bagenda\s+project name\b/i,
    /\bdisposition area\b/i, /\bpublic hearing (?:with respect to|regarding|concerning)\b/i,
    /\bone or more of the boroughs?\b/i,
    /\b(?:Manhattan|Bronx|Brooklyn|Queens|Staten Island) borough (?:board|president).{0,120}?\b(?:public )?hearing on\b/i,
  ];
  var starts = markers.map(function (pattern) {
    var match = pattern.exec(text);
    return match ? match.index : null;
  }).filter(function (index) { return Number.isInteger(index); });
  if (!starts.length) return "";
  var start = Math.min.apply(Math, starts);
  return text.slice(start, start + 16000)
    .split(/\b(?:further information|public inspection|if you need (?:an )?accommodation)\b/i)[0];
}
function hearingApplicationSignals(text) {
  var numbers = [], boroughs = [];
  var patterns = [
    /\b(?:C|N)?\s*\d{6}\s*(?:ZM|ZR|ZS|ZA|ZC|MM|HA|LD|PC|PP)([MXKQR])\b/gi,
    /\b(?:ZM|ZR|ZS|ZA|ZC|MM|HA|LD|PC|PP)\s*\d{6}\s*(?:ZM|ZR|ZS|ZA|ZC|MM|HA|LD|PC|PP)?([MXKQR])\b/gi,
    /\b\d{2}[A-Z]{3}\d{3}([MXKQR])\b/gi,
  ];
  patterns.forEach(function (pattern) {
    Array.from(text.matchAll(pattern)).forEach(function (match) {
      numbers.push(hearingPlainText(match[0]).replace(/\s+/g, ""));
      boroughs.push(HEARING_APPLICATION_BOROUGHS[match[1].toUpperCase()]);
    });
  });
  return { numbers: hearingUnique(numbers), boroughs: hearingUnique(boroughs) };
}
function hearingCommunityBoardSignals(text) {
  var boards = [], boroughs = [];
  Array.from(text.matchAll(/\bcommunity board\s*#?\s*(\d{1,2})\s*(BX|BK|SI|M|Q)\b/gi)).forEach(function (match) {
    var borough = HEARING_BOARD_BOROUGHS[match[2].toUpperCase()];
    boards.push("Community Board " + Number(match[1]) + ", " + borough); boroughs.push(borough);
  });
  Array.from(text.matchAll(/\bcommunity board\s+(BX|BK|SI|M|Q)\s*0?(\d{1,2})\b/gi)).forEach(function (match) {
    var borough = HEARING_BOARD_BOROUGHS[match[1].toUpperCase()];
    boards.push("Community Board " + Number(match[2]) + ", " + borough); boroughs.push(borough);
  });
  Array.from(text.matchAll(/\bborough of (?:the )?(Manhattan|Brooklyn|Queens|Bronx|Staten Island).{0,55}?\bcommunity board(?:\s+no\.?|\s*#)?\s*0?(\d{1,2})\b/gi)).forEach(function (match) {
    var borough = hearingCanonicalBorough(match[1]);
    boards.push("Community Board " + Number(match[2]) + ", " + borough); boroughs.push(borough);
  });
  return { boards: hearingUnique(boards), boroughs: hearingUnique(boroughs) };
}
function hearingCommunityBoardQuery(value) {
  var query = hearingPlainText(value);
  var match = /\b(?:community\s+board|cb)\s*(?:no\.?\s*|#\s*)?(\d{1,2})\b/i.exec(query);
  if (!match) return null;
  var number = Number(match[1]);
  if (!isFinite(number) || number < 1 || number > 18) return null;
  var boroughs = ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"];
  var borough = boroughs.find(function (candidate) {
    return new RegExp("\\b" + candidate.replace(" ", "\\s+") + "\\b", "i").test(query);
  }) || null;
  return { number: number, borough: borough, ambiguous: !borough, query: query };
}
function hearingCommunityBoardIds(record) {
  var values = [];
  var area = record && record.affected_area;
  if (area && Array.isArray(area.community_boards)) values = values.concat(area.community_boards);
  if (record && Array.isArray(record.community_boards)) values = values.concat(record.community_boards);
  return hearingUnique(values.map(function (value) {
    var match = /\bcommunity\s+board\s+(\d{1,2})\s*,\s*([^,]+)$/i.exec(hearingPlainText(value));
    if (!match) return null;
    var borough = hearingCanonicalBorough(match[2]);
    var slug = borough.toLowerCase().replace(/\s+/g, "-");
    return slug + "-cb-" + String(Number(match[1])).padStart(2, "0");
  }).filter(Boolean));
}
function hearingMatchesCommunityBoard(record, query) {
  if (!query) return false;
  var ids = hearingCommunityBoardIds(record);
  var suffix = "-cb-" + String(query.number).padStart(2, "0");
  var target = query.borough
    ? query.borough.toLowerCase().replace(/\s+/g, "-") + suffix
    : null;
  if (ids.length) return target ? ids.indexOf(target) >= 0 : ids.some(function (id) { return id.endsWith(suffix); });
  var haystack = JSON.stringify(record || "");
  var numberPattern = new RegExp("\\bcommunity\\s+board\\s*(?:no\\.?\\s*|#\\s*)?0?" + query.number + "\\b", "i");
  if (!numberPattern.test(haystack)) return false;
  return !query.borough || new RegExp("\\b" + query.borough.replace(" ", "\\s+") + "\\b", "i").test(haystack);
}
function hearingStreetRanges(text) {
  var ranges = Array.from(text.matchAll(/\b([A-Z0-9][A-Za-z0-9.'’ -]{1,80}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway))\s+between\s+([A-Z0-9][A-Za-z0-9.'’ -]{1,80}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway))\s+and\s+([A-Z0-9][A-Za-z0-9.'’ -]{1,80}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway))/gi))
    .map(function (match) { return hearingAddress(match[0]); });
  Array.from(text.matchAll(/\bbounded by\s+(.{10,360}?)(?=;|\.\s|,\s*(?:Borough|Community District)|$)/gi)).forEach(function (match) {
    ranges.push(hearingAddress("bounded by " + match[1]));
  });
  return hearingUnique(ranges);
}
function hearingTaxLots(text) {
  return hearingUnique(Array.from(text.matchAll(/\b(?:tax\s+)?block\s*\d+[A-Z]?(?:\s*[,/&-]\s*(?:p\/o\s+|part of\s+)?lot(?:\(s\)|s)?\s*(?:\d+[A-Z]?(?:\s*(?:,|and|&|\/|-)\s*(?:p\/o\s+|part of\s+)?\d+[A-Z]?)*))?/gi))
    .map(function (match) { return hearingPlainText(match[0]); }));
}
function hearingAffectedArea(row) {
  var title = hearingPlainText(row.short_title);
  var body = hearingPlainText([
    title, row.additional_description_1, row.additional_description_2,
    row.additional_description_3, row.other_info_1, row.other_info_2, row.other_info_3,
    row.printout_1, row.printout_2, row.printout_3,
  ].filter(Boolean).join(" "));
  // Keep venue prose out of affected-area inference: free-form places come only from the title
  // or a marked subject segment; formal application/community-board designations are separate.
  var subject = hearingSubjectText(body);
  var localText = [title, subject].filter(Boolean).join(" ");
  var applications = hearingApplicationSignals(localText);
  var boards = hearingCommunityBoardSignals(body);
  var gazetteer = HEARING_PROJECT_GAZETTEER.filter(function (entry) { return entry.pattern.test(localText); });
  var boroughs = hearingUnique(HEARING_BOROUGHS.filter(function (entry) {
    return entry[1].test(localText);
  }).map(function (entry) { return entry[0]; })
    .concat(applications.boroughs, boards.boroughs)
    .concat(gazetteer.flatMap(function (entry) { return entry.boroughs; })));
  var neighborhoods = hearingUnique(Array.from(localText.matchAll(/\b(?:neighbou?rhood of|located in|within)\s+([A-Z][A-Za-z.'’ -]{2,45}?)(?=,|\s+(?:neighbou?rhood|community district|in (?:Manhattan|Brooklyn|Queens|the Bronx|Staten Island))\b|[.;])/gi))
    .map(function (match) { return hearingPlainText(match[1]).replace(/^the\s+/i, ""); })
    .concat(gazetteer.flatMap(function (entry) { return entry.neighborhoods; })));
  var communityDistricts = hearingUnique(Array.from(localText.matchAll(/\bcommunity districts?\s+((?:\d{1,2})(?:\s*(?:,|and|&)\s*\d{1,2})*)/gi))
    .flatMap(function (match) { return match[1].match(/\d{1,2}/g) || []; }));
  var addresses = hearingUnique((subject.match(HEARING_ADDRESS_RE) || []).map(hearingAddress));
  var streetRanges = hearingStreetRanges(subject);
  var taxLots = hearingTaxLots(subject);
  var projectNames = gazetteer.map(function (entry) { return entry.name; });
  var citywide = /\b(?:citywide(?! (?:administrative|personnel) services)|throughout (?:new york )?city|all five boroughs)\b/i.test(body);
  var local = boroughs.length || neighborhoods.length || communityDistricts.length
    || boards.boards.length || addresses.length || streetRanges.length || taxLots.length
    || projectNames.length || applications.numbers.length;
  return {
    scope: citywide ? "citywide" : local ? "local" : "unlocated",
    boroughs: boroughs, neighborhoods: neighborhoods, community_districts: communityDistricts,
    community_boards: boards.boards,
    addresses: addresses.map(function (label) { return { label: label }; }),
    street_ranges: streetRanges.map(function (label) { return { label: label }; }),
    tax_lots: taxLots.map(function (label) { return { label: label }; }),
    project_names: projectNames,
    application_numbers: applications.numbers,
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
  if (row && row.source_system === "community_board") {
    var boardSource = row.source_url || row.record_url || null;
    var boardPublisherId = String(row.publisher_identifier || row.source_record_id || row.record_id || "").trim();
    var boardMeetingId = String(row.meeting_id || (boardPublisherId
      ? "meeting:community_board:" + boardPublisherId : "")).trim() || null;
    return {
      object_type: "meeting", schema: "cityscroll.meeting_object.v1", meeting_id: boardMeetingId,
      source_keys: boardPublisherId ? [{ source_system: "community_board", key_type: "publisher_event_id", value: boardPublisherId }] : [],
      publisher_identifier: boardPublisherId || null, request_id: null,
      source_system: "community_board", source_record_id: row.source_record_id || row.record_id || boardPublisherId || null,
      source_section: row.section_name || "Community Board Meetings",
      agency: null, notice_type: row.type_of_notice_description || "Board meeting",
      title: hearingPlainText(row.short_title) || "Community board meeting", event_date: row.event_date || null,
      event_end: row.event_end || row.end_at || null,
      published_at: row.start_date || null, decides: hearingPlainText(row.short_title) || "Community board meeting",
      affects: [], affected_area: row.affected_area || { scope: "unlocated" }, venue: row.venue || null,
      participation: row.participation || { links: [], remote_join_url: null, emails: [], phones: [], source_url: boardSource },
      source_url: boardSource, description: hearingPlainText(row.description || row.search_text || ""), board_id: row.board_id || null,
      board_name: hearingPlainText(row.board_name || ""), entity_refs_all: row.entity_refs_all || [],
      institution_edges: row.institution_edges || [], meeting_origin: row.meeting_origin || "unknown",
      source_provenance: row.source_provenance || null, source_receipt: row.source_receipt || row.observed_receipt || null,
      join_status: row.join_status || row.meeting_join?.status || "unknown",
      committee: row.committee || null, meeting_documents: row.meeting_documents || [],
      minutes_freshness: row.minutes_freshness || null, search_text: row.search_text || null,
      institution_refs: { agency_ref: null, board_ref: row.board_id ? "community-board:" + row.board_id : null },
      compatibility: { legacy_notice_href: null, legacy_fragment_href: null, publisher_href: boardSource },
      meeting_join: row.meeting_join || null,
    };
  }
  var body = hearingPlainText([
    row.additional_description_1, row.additional_description_2, row.additional_description_3,
    row.other_info_1, row.other_info_2, row.other_info_3, row.printout_1, row.printout_2, row.printout_3,
  ].filter(Boolean).join(" "));
  var source = "https://a856-cityrecord.nyc.gov/RequestDetail/" + encodeURIComponent(row.request_id || "");
  var audience = HEARING_AUDIENCES.find(function (entry) { return entry[0].test((row.short_title || "") + " " + body); });
  var venue = row.venue || hearingVenue(row);
  var participation = hearingParticipationFromBody(body, source);
  var cityRecordId = String(row.request_id || "");
  return {
    object_type: "meeting", schema: "cityscroll.meeting_object.v1",
    source_system: "city_record",
    meeting_id: cityRecordId ? "meeting:city_record:" + cityRecordId : null,
    source_keys: cityRecordId ? [{ source_system: "city_record", key_type: "request_id", value: cityRecordId }] : [],
    publisher_identifier: cityRecordId || null,
    request_id: cityRecordId, source_section: row.section_name || null,
    agency: row.agency_name || null, notice_type: row.type_of_notice_description || null,
    title: hearingPlainText(row.short_title) || "Hearing " + String(row.request_id || "").trim(), event_date: row.event_date || null,
    published_at: row.start_date || null, decides: hearingDecision(row, body),
    affects: audience ? [audience[1]] : [], affected_area: row.affected_area || hearingAffectedArea(row),
    venue: venue,
    participation: participation,
    source_url: source, source_receipt: row.source_receipt || null,
    meeting_origin: row.meeting_origin || "city_record_notice",
    join_status: "not_applicable",
    institution_refs: { agency_ref: null, board_ref: null },
    compatibility: {
      legacy_notice_href: cityRecordId ? "/notices/" + encodeURIComponent(cityRecordId) : null,
      legacy_fragment_href: cityRecordId ? "#notice/" + encodeURIComponent(cityRecordId) : null,
      publisher_href: source,
    },
    description: body.slice(0, 1200), search_text: row.search_text || body.slice(0, 6000),
    committee: row.committee || null, meeting_documents: row.meeting_documents || [],
    minutes_freshness: row.minutes_freshness || null, entity_refs_all: row.entity_refs_all || [],
  };
}
// Hand-synced with worker/src/lib/hearings.mjs participationFromRow: strip trailing
// punctuation before dedupe so "…hearings," and "…hearings" collapse; one affordance.
function hearingNormalizeParticipationUrl(url) {
  return String(url || "").replace(/[.,;:)\]]+$/g, "").trim();
}
function hearingParticipationUrlKey(url) {
  try {
    var parsed = new URL(url);
    return (parsed.host + parsed.pathname).toLowerCase().replace(/\/$/, "");
  } catch (e) {
    return String(url || "").toLowerCase().replace(/\/$/, "");
  }
}
function hearingParticipationLabel(url) {
  if (/\b(?:zoom|webex|teams|meet\.google)\b/i.test(url)) return "Join online";
  if (/nycida-board-meetings-public-hearings/i.test(url) || /edc\.nyc\/nycida(?:[/?#]|$)/i.test(url)) {
    return "IDA meetings page";
  }
  return "Participation link";
}
function hearingParticipationFromBody(body, source) {
  var cleaned = (String(body || "").match(HEARING_URL_RE) || []).map(hearingNormalizeParticipationUrl).filter(Boolean);
  var byKey = Object.create(null);
  cleaned.forEach(function (url) {
    var key = hearingParticipationUrlKey(url);
    if (!key || byKey[key]) return;
    byKey[key] = { label: hearingParticipationLabel(url), url: url };
  });
  var ranked = Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
    var aJoin = a.label === "Join online" ? 0 : 1;
    var bJoin = b.label === "Join online" ? 0 : 1;
    if (aJoin !== bJoin) return aJoin - bJoin;
    return b.url.length - a.url.length;
  });
  return {
    links: ranked.slice(0, 1),
    remote_join_url: ranked.find(function (link) { return link.label === "Join online"; })?.url || null,
    emails: hearingUnique(Array.from(String(body || "").matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)).map(function (match) { return match[0]; })).slice(0, 4),
    phones: hearingUnique(Array.from(String(body || "").matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g)).map(function (match) { return match[0]; })).slice(0, 4),
    source_url: source,
  };
}
function hearingIsVirtualOnly(record, area) {
  var a = area || (record && record.affected_area) || {};
  if (a.virtual_only || a.unlocated_reason === "virtual_only") return true;
  if (record && record.virtual_only) return true;
  var venue = record && record.venue;
  if (venue && venue.mode === "virtual") return true;
  return false;
}
function hearingMatchesArea(record, filter) {
  var f = filter || {}, area = record.affected_area || {}, borough = String(f.borough || "").toLowerCase();
  var neighborhood = String(f.neighborhood || "").trim().toLowerCase();
  // Map drill scopes (and list chips): virtual / citywide / legacy citywide-unlocated.
  if (f.locationScope === "virtual") {
    return hearingIsVirtualOnly(record, area);
  }
  if (f.locationScope === "citywide") {
    if (area.scope !== "citywide") return false;
  } else if (f.locationScope === "unlocated") {
    // Unlocated bag excludes virtual-only (those live in the Virtual bag).
    if (hearingIsVirtualOnly(record, area)) return false;
    if (area.scope !== "unlocated") return false;
  } else if (f.locationScope === "citywide-unlocated") {
    if (area.scope !== "citywide" && area.scope !== "unlocated") return false;
  } else if (borough && area.scope !== "citywide"
      && !(area.boroughs || []).some(function (value) { return String(value).toLowerCase() === borough; })) return false;
  if (neighborhood && area.scope !== "citywide") {
    var haystack = [].concat(area.neighborhoods || [], (area.addresses || []).map(function (address) { return address.label; }), record.description || "").join(" ").toLowerCase();
    if (!haystack.includes(neighborhood)) return false;
  }
  return true;
}
function filterMeetingRowsByAffectedArea(records, filter) {
  return (records || []).filter(function (record) {
    return hearingMatchesArea(record, filter);
  });
}
function hearingDateWindowEnd(today, windowName) {
  var date = new Date(String(today).slice(0, 10) + "T00:00:00Z");
  if (windowName === "week") date.setUTCDate(date.getUTCDate() + 7);
  else if (windowName === "month") date.setUTCDate(date.getUTCDate() + 30);
  else return null;
  return date.toISOString().slice(0, 10);
}

// Progressive query relaxation for time-scoped hearing searches. Every rung preserves
// agency, subject, and affected-area filters; only the upcoming date window changes.
// Past rows are a separate result band and are never promoted into an upcoming band.
function hearingScopeLadder(requested) {
  if (requested === "all") return ["all"];
  if (requested === "week") return ["week", "month", "upcoming"];
  if (requested === "month") return ["month", "upcoming"];
  if (requested === "past") return ["past"];
  return ["upcoming"];
}
function hearingRowsInScope(records, filter, scope, today) {
  var start = String(today).slice(0, 10);
  var end = hearingDateWindowEnd(start, scope);
  var agency = String(filter.agency || "");
  var keyword = String(filter.keyword || "").trim().toLowerCase();
  return (records || []).filter(function (record) {
    var date = String(record.event_date || "").slice(0, 10);
    if (!date && scope !== "all") return false;
    if (scope === "all") {
      // No date window — map drill count-equals-list over the full corpus.
    } else if (scope === "past") {
      if (date >= start) return false;
    } else if (date < start || (end && date > end)) {
      return false;
    }
    if (agency && record.agency !== agency) return false;
    if (filter.communityBoard && !hearingMatchesCommunityBoardScope(record, filter.communityBoard)) return false;
    if (!hearingMatchesArea(record, filter)) return false;
    if (keyword) {
      var boardQuery = hearingCommunityBoardQuery(keyword);
      if (boardQuery) return hearingMatchesCommunityBoard(record, boardQuery);
      var haystack = [
        record.title, record.decides, record.description, record.board_name, record.board_id,
        (record.affects || []).join(" "),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  }).sort(function (a, b) {
    var av = String(a.event_date || ""), bv = String(b.event_date || "");
    if (scope === "all" && !av) return 1;
    if (scope === "all" && !bv) return -1;
    return (scope === "past" ? bv.localeCompare(av) : av.localeCompare(bv))
      || String(a.meeting_id || a.request_id || "").localeCompare(String(b.meeting_id || b.request_id || ""));
  });
}

function hearingMatchesCommunityBoardScope(record, value) {
  var target = String(value || "").trim().toLowerCase().replace(/^community-board:/, "");
  if (!target) return true;
  var area = record && record.affected_area || {};
  var refs = []
    .concat(Array.isArray(record && record.entity_refs_all) ? record.entity_refs_all : [])
    .concat(Array.isArray(area.community_boards) ? area.community_boards : [])
    .concat(record && record.institution_refs && record.institution_refs.board_ref)
    .concat(record && record.board_id);
  return refs.some(function (ref) {
    return String(ref || "").trim().toLowerCase().replace(/^community-board:/, "") === target;
  });
}
function chooseHearingScope(records, filter, today, allowWidening) {
  var requested = filter.when || "upcoming";
  var ladder = allowWidening === false ? [requested] : hearingScopeLadder(requested);
  var pastRows = requested !== "all" && requested !== "past" && allowWidening !== false
    ? hearingRowsInScope(records, filter, "past", today)
    : [];
  for (var i = 0; i < ladder.length; i++) {
    var scope = ladder[i];
    var rows = hearingRowsInScope(records, filter, scope, today);
    if (rows.length) {
      return { requested: requested, scope: scope, widened: scope !== requested, rows: rows, pastRows: pastRows };
    }
  }
  return { requested: requested, scope: requested, widened: false, rows: [], pastRows: pastRows };
}

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = {
    chooseHearingScope: chooseHearingScope,
    hearingAffectedArea: hearingAffectedArea,
    hearingDateWindowEnd: hearingDateWindowEnd,
    hearingIsVirtualOnly: hearingIsVirtualOnly,
    hearingMatchesArea: hearingMatchesArea,
    filterMeetingRowsByAffectedArea: filterMeetingRowsByAffectedArea,
    hearingPlainText: hearingPlainText,
    hearingRowsInScope: hearingRowsInScope,
    hearingScopeLadder: hearingScopeLadder,
    hearingCommunityBoardQuery: hearingCommunityBoardQuery,
    hearingCommunityBoardIds: hearingCommunityBoardIds,
    hearingMatchesCommunityBoard: hearingMatchesCommunityBoard,
    hearingMatchesCommunityBoardScope: hearingMatchesCommunityBoardScope,
    hearingVenue: hearingVenue,
    normalizeHearingRow: normalizeHearingRow,
  };
}
