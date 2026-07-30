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
    participation: hearingParticipationFromBody(body, source),
    source_url: source, description: body.slice(0, 1200),
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
    emails: hearingUnique(Array.from(String(body || "").matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)).map(function (match) { return match[0]; })).slice(0, 4),
    phones: hearingUnique(Array.from(String(body || "").matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g)).map(function (match) { return match[0]; })).slice(0, 4),
    source_url: source,
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
