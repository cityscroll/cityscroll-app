// Pure helpers for replayable search-lens filters and one device-local preset store.
// No DOM or network access: browser code uses the globals below and Node tests require them.

var NLQ_PRESET_LIMIT = 8;
var SEARCH_LENSES = ["money", "people", "land", "property", "rules", "meetings"];

function compactText(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function positiveAmount(value) {
  var n = Number(value);
  return Number.isFinite(n) && n >= 1000 ? Math.round(n) : null;
}

function buildMoneyDeepLink(filter) {
  var f = filter && typeof filter === "object" ? filter : {};
  // Agency/vendor forecast and profile routes leave the money list for entity pages.
  if (f.route === "agency" && compactText(f.name, 160)) {
    var agencyName = compactText(f.name, 160);
    if (typeof globalThis !== "undefined" && globalThis.CrolEntityPivots) {
      return globalThis.CrolEntityPivots.entityHref({
        ref: globalThis.CrolEntityPivots.entityRouteRef("agency", agencyName),
        label: agencyName,
      }, { tab: f.tab === "forecast" ? "forecast" : "" });
    }
    return "/agencies/" + encodeURIComponent(agencyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")) + "/" + (f.tab === "forecast" ? "?tab=forecast" : "");
  }
  if (f.route === "vendor" && compactText(f.name, 160)) {
    var vendorName = compactText(f.name, 160);
    if (typeof globalThis !== "undefined" && globalThis.CrolEntityPivots) {
      return globalThis.CrolEntityPivots.entityHref({
        ref: globalThis.CrolEntityPivots.entityRouteRef("vendor", vendorName),
        label: vendorName,
      });
    }
    return "/vendors/" + encodeURIComponent(vendorName.toUpperCase()) + "/";
  }
  var keywords = Array.isArray(f.keywords)
    ? f.keywords.map(function (word) { return compactText(word, 80).toLowerCase(); }).filter(Boolean).slice(0, 4)
    : [];
  var agency = compactText(f.agency, 160);
  var minAmount = positiveAmount(f.minAmount);
  var maxAmount = positiveAmount(f.maxAmount);
  var category = compactText(f.category, 120);
  var months = Number.isFinite(Number(f.months)) && Number(f.months) > 0 && Number(f.months) <= 60
    ? Math.round(Number(f.months))
    : null;
  var noticeType = f.noticeType === "award" || f.noticeType === "solicitation" ? f.noticeType : null;
  var excludeSpecial = f.excludeSpecial === true;
  var closingWeek = f.closingWeek === true;

  if (!keywords.length && !agency && !minAmount && !maxAmount && !category && !months && !noticeType && !excludeSpecial && !closingWeek) {
    return null;
  }

  var params = new URLSearchParams();
  var wantsAward = !closingWeek && (noticeType === "award" || (!noticeType && (minAmount || maxAmount)));
  params.set("mode", wantsAward ? "award" : "open");
  if (agency) params.set("agency", agency);
  if (keywords.length) params.set("q", keywords.join(" "));
  if (minAmount) params.set("min", String(minAmount));
  if (maxAmount) params.set("max", String(maxAmount));
  if (category) params.set("category", category);
  if (months) params.set("months", String(months));
  if (excludeSpecial) params.set("standard", "1");
  if (closingWeek && !wantsAward) params.set("closing", "week");
  return "#money?" + params.toString();
}

function compactKeywords(value) {
  var values = Array.isArray(value) ? value : compactText(value, 320) ? [value] : [];
  return values
    .map(function (word) { return compactText(word, 80).toLowerCase(); })
    .filter(Boolean)
    .slice(0, 4);
}

var LENS_QUERY_BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
var LENS_QUERY_DISTRICT_BOROUGHS = { M: "Manhattan", X: "Bronx", K: "Brooklyn", Q: "Queens", R: "Staten Island" };

function canonicalBorough(value) {
  var text = compactText(value, 40).toLowerCase();
  return LENS_QUERY_BOROUGHS.find(function (name) { return name.toLowerCase() === text; }) || null;
}

function boroughInText(value) {
  var text = " " + compactText(value, 320).toLowerCase() + " ";
  return LENS_QUERY_BOROUGHS.find(function (name) {
    return text.indexOf(" " + name.toLowerCase() + " ") >= 0;
  }) || null;
}

function stripBoroughFromText(value, borough) {
  if (!borough) return compactText(value, 320);
  return compactText(value, 320)
    .replace(new RegExp("\\b" + borough.replace(/ /g, "\\s+") + "\\b", "ig"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

// One serializable query object sits between standard controls, Ask proposals, and URLs.
// Text is the topic clause; facets and place are structured clauses. This keeps proposal
// merging independent of DOM event order and makes a conflict an explicit state.
function canonicalLensQueryState(lens, filter) {
  var f = filter && typeof filter === "object" ? filter : {};
  var keywords = Array.isArray(f.keywords) ? f.keywords : compactText(f.text, 320) ? [f.text] : [];
  var text = compactText(keywords.join(" "), 320);
  var communityDistrict = compactText(f.communityDistrict, 8).toUpperCase();
  var councilDistrict = compactText(f.councilDistrict, 4);
  var locationScope = ["citywide-unlocated", "citywide", "virtual", "unlocated"].indexOf(f.locationScope) >= 0
    ? f.locationScope
    : null;
  return {
    lens: lens,
    text: text,
    facets: {
      agency: compactText(f.agency, 160) || null,
      when: ["week", "month", "upcoming", "past", "all"].indexOf(f.when) >= 0 ? f.when : null,
      process: compactText(f.process, 40) && f.process !== "all" ? compactText(f.process, 40) : null,
    },
    place: {
      borough: canonicalBorough(f.borough),
      communityDistrict: /^(?:M|X|K|Q|R)\d{2}$/.test(communityDistrict) ? communityDistrict : null,
      councilDistrict: /^(?:[1-9]|[1-4]\d|5[01])$/.test(councilDistrict) ? councilDistrict : null,
      neighborhood: compactText(f.neighborhood, 80) || null,
      locationScope: locationScope,
    },
  };
}

function lensQueryStateFilter(state) {
  var query = state && typeof state === "object" ? state : canonicalLensQueryState("meetings", {});
  return {
    keywords: query.text ? [query.text] : [],
    agency: query.facets && query.facets.agency || null,
    when: query.facets && query.facets.when || null,
    process: query.facets && query.facets.process || null,
    borough: query.place && query.place.borough || null,
    communityDistrict: query.place && query.place.communityDistrict || null,
    councilDistrict: query.place && query.place.councilDistrict || null,
    neighborhood: query.place && query.place.neighborhood || null,
    locationScope: query.place && query.place.locationScope || null,
  };
}

function statePlaceBorough(state) {
  if (state.place.borough) return state.place.borough;
  if (state.place.communityDistrict) return LENS_QUERY_DISTRICT_BOROUGHS[state.place.communityDistrict.charAt(0)] || null;
  return boroughInText(state.text);
}

function mergeQueryState(current, proposed, preferProposed, placeConflict, directConflicts) {
  var result = canonicalLensQueryState(current.lens, lensQueryStateFilter(current));
  result.text = current.text || proposed.text;
  ["agency", "when", "process"].forEach(function (field) {
    if (!proposed.facets[field]) return;
    if (!directConflicts[field] || preferProposed) result.facets[field] = proposed.facets[field];
  });
  if (!placeConflict || preferProposed) {
    if (preferProposed && placeConflict) {
      result.place = canonicalLensQueryState(current.lens, {}).place;
      result.text = stripBoroughFromText(result.text, statePlaceBorough(current));
    }
    Object.keys(result.place).forEach(function (field) {
      if (proposed.place[field]) result.place[field] = proposed.place[field];
    });
  }
  return result;
}

function composeLensQueryState(lens, currentFilter, proposedFilter) {
  var current = canonicalLensQueryState(lens, currentFilter);
  var proposed = canonicalLensQueryState(lens, proposedFilter);
  var conflicts = [];
  var directConflicts = {};
  ["agency", "when", "process"].forEach(function (field) {
    var before = current.facets[field];
    var after = proposed.facets[field];
    if (before && after && before !== after) {
      directConflicts[field] = true;
      conflicts.push({ field: field, current: before, proposed: after });
    }
  });
  var currentPlace = statePlaceBorough(current);
  var proposedPlace = statePlaceBorough(proposed);
  var placeConflict = Boolean(currentPlace && proposedPlace && currentPlace !== proposedPlace);
  if (placeConflict) conflicts.push({ field: "place", current: currentPlace, proposed: proposedPlace });

  var keepCurrent = mergeQueryState(current, proposed, false, placeConflict, directConflicts);
  var useProposed = mergeQueryState(current, proposed, true, placeConflict, directConflicts);
  return {
    state: conflicts.length ? keepCurrent : useProposed,
    conflicts: conflicts,
    choices: {
      keep_current: keepCurrent,
      use_proposed: useProposed,
    },
  };
}

// Canonical order mirrors index.html's serializeState(), so an Ask resolution and the
// equivalent hand-set controls always produce the same URL.
function buildSearchDeepLink(lens, filter) {
  if (lens === "money") return buildMoneyDeepLink(filter);
  if (SEARCH_LENSES.indexOf(lens) < 0) return null;

  var f = filter && typeof filter === "object" ? filter : {};
  var keywords = compactKeywords(f.keywords);
  var agency = compactText(f.agency, 160);
  var params = new URLSearchParams();

  if (lens === "people") {
    if (f.view === "guide") params.set("view", "guide");
    if (f.lookupType === "person") params.set("mode", "person");
    if (keywords.length) params.set("q", keywords.join(" "));
  } else if (lens === "land") {
    var boros = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
    var boro = boros.find(function (name) {
      return name.toLowerCase() === compactText(f.boro, 40).toLowerCase();
    });
    if (boro) params.set("boro", boro);
    var communityDistrict = compactText(f.communityDistrict, 8).toUpperCase();
    if (/^(?:M|X|K|Q|R)\d{2}$/.test(communityDistrict)) {
      params.set("cd", communityDistrict);
    }
    var councilDistrict = compactText(f.councilDistrict, 4);
    if (/^(?:[1-9]|[1-4]\d|5[01])$/.test(councilDistrict)) {
      params.set("council", councilDistrict);
    }
    if (keywords.length) params.set("q", keywords.join(" "));
    if (f.status === "all") params.set("status", "all");
  } else {
    if (agency) params.set("agency", agency);
    if (keywords.length) params.set("q", keywords.join(" "));
    if (lens === "meetings") {
      if (["week", "month", "upcoming", "past", "all"].indexOf(f.when) >= 0) params.set("when", f.when);
      var hearingBoros = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
      var hearingBoro = hearingBoros.find(function (name) {
        return name.toLowerCase() === compactText(f.borough, 40).toLowerCase();
      });
      if (hearingBoro) params.set("boro", hearingBoro);
      var hearingCommunityDistrict = compactText(f.communityDistrict, 8).toUpperCase();
      if (/^(?:M|X|K|Q|R)\d{2}$/.test(hearingCommunityDistrict)) params.set("cd", hearingCommunityDistrict);
      var hearingCouncilDistrict = compactText(f.councilDistrict, 4);
      if (/^(?:[1-9]|[1-4]\d|5[01])$/.test(hearingCouncilDistrict)) params.set("council", hearingCouncilDistrict);
      var neighborhood = compactText(f.neighborhood, 80);
      if (neighborhood) params.set("neighborhood", neighborhood);
      if (
        f.locationScope === "citywide-unlocated"
        || f.locationScope === "citywide"
        || f.locationScope === "virtual"
        || f.locationScope === "unlocated"
      ) {
        params.set("scope", f.locationScope);
      }
      var meetProcess = compactText(f.process, 40);
      if (["scheduled", "agenda", "held", "outcomes", "unstaged"].indexOf(meetProcess) >= 0) {
        params.set("process", meetProcess);
      }
    }
    if (lens === "property") {
      var asset = compactText(f.asset, 40);
      var stage = compactText(f.stage, 40);
      var propProcess = compactText(f.process, 40);
      var propBoros = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
      var propBoro = propBoros.find(function (name) {
        return name.toLowerCase() === compactText(f.borough, 40).toLowerCase();
      });
      if (propBoro) params.set("boro", propBoro);
      var propNeighborhood = compactText(f.neighborhood, 80);
      if (propNeighborhood) params.set("neighborhood", propNeighborhood);
      var propCommunityDistrict = compactText(f.communityDistrict, 8).toUpperCase();
      if (/^(?:M|X|K|Q|R)\d{2}$/.test(propCommunityDistrict)) params.set("cd", propCommunityDistrict);
      if (asset && asset !== "all") params.set("asset", asset);
      if (stage && stage !== "all") params.set("stage", stage);
      if (["hearing", "auction_or_rfp", "award_or_conveyance", "unstaged"].indexOf(propProcess) >= 0) {
        params.set("process", propProcess);
      }
    }
    if (lens === "rules") {
      var rulesProcess = compactText(f.process, 40);
      if (["proposal", "public_process", "adoption", "effective", "unstaged"].indexOf(rulesProcess) >= 0) {
        params.set("process", rulesProcess);
      }
    }
  }

  var query = params.toString();
  return query ? "#" + lens + "?" + query : null;
}

// The interpreted row is an explanation for filters that the standard Money controls cannot
// show. Once one of those hidden filters is active, include every active filter so the row is a
// complete, legible description of the result set rather than a partial footnote.
function moneyActiveFilterItems(filter) {
  var f = filter && typeof filter === "object" ? filter : {};
  var category = compactText(f.category, 120);
  var maxAmount = positiveAmount(f.maxAmount);
  var months = Number.isFinite(Number(f.months)) && Number(f.months) > 0 && Number(f.months) <= 60
    ? Math.round(Number(f.months))
    : null;
  var excludeSpecial = f.excludeSpecial === true;
  if (!category && !maxAmount && !months && !excludeSpecial) return [];

  var noticeType = f.noticeType === "award" || f.noticeType === "allrfp"
    ? f.noticeType
    : "solicitation";
  var agency = compactText(f.agency, 160);
  var keywords = Array.isArray(f.keywords)
    ? f.keywords.map(function (word) { return compactText(word, 80); }).filter(Boolean).slice(0, 4)
    : compactText(f.keywords, 320)
      ? [compactText(f.keywords, 320)]
      : [];
  var minAmount = positiveAmount(f.minAmount);
  var items = [{ kind: "noticeType", value: noticeType }];
  if (agency) items.push({ kind: "agency", value: agency });
  if (keywords.length) items.push({ kind: "keywords", value: keywords });
  if (category) items.push({ kind: "category", value: category });
  if (minAmount) items.push({ kind: "minAmount", value: minAmount });
  if (maxAmount) items.push({ kind: "maxAmount", value: maxAmount });
  if (months) items.push({ kind: "months", value: months });
  if (excludeSpecial) items.push({ kind: "excludeSpecial", value: true });
  return items;
}

function canonicalSearchURL(locationValue, hash) {
  var loc = locationValue && typeof locationValue === "object" ? locationValue : {};
  var origin = compactText(loc.origin, 2048).replace(/\/+$/, "");
  var safeHash = /^#(?:money|people|land|property|rules|meetings)(?:\?[^#]*)?$/.test(hash || "")
    ? hash
    : "#money";
  var match = /^#(money|people|land|property|rules|meetings)(?:\?([^#]*))?$/.exec(safeHash);
  var facets = {
    money: "contracts",
    people: "staffing",
    land: "zoning",
    property: "property",
    rules: "rules",
    meetings: "meetings",
  };
  var query = match && match[2] ? "?" + match[2] : "";
  return origin + "/browse/" + facets[match ? match[1] : "money"] + "/" + query;
}

function presetLens(value) {
  var hash = typeof value === "string" ? value : value && value.hash;
  var match = /^#(money|people|land|property|rules|meetings)\?/.exec(hash || "");
  return match ? match[1] : null;
}

function validPreset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var label = compactText(value.label, 100);
  var hash = compactText(value.hash, 2000);
  if (!label || !presetLens(hash)) return null;
  return { label: label, hash: hash };
}

function parsePresetStore(raw) {
  var values;
  try { values = JSON.parse(raw || "[]"); } catch (e) { return []; }
  if (!Array.isArray(values)) return [];
  var out = [];
  values.forEach(function (value) {
    var preset = validPreset(value);
    if (!preset) return;
    out = out.filter(function (existing) { return existing.hash !== preset.hash; });
    out.push(preset);
  });
  return out.slice(-NLQ_PRESET_LIMIT);
}

function savePreset(values, label, hash) {
  var preset = validPreset({ label: label, hash: hash });
  var list = Array.isArray(values) ? values.map(validPreset).filter(Boolean) : [];
  if (!preset) return list.slice(-NLQ_PRESET_LIMIT);
  list = list.filter(function (existing) { return existing.hash !== preset.hash; });
  list.push(preset);
  return list.slice(-NLQ_PRESET_LIMIT);
}

function removePreset(values, index) {
  var list = Array.isArray(values) ? values.map(validPreset).filter(Boolean) : [];
  if (Number.isInteger(index) && index >= 0 && index < list.length) list.splice(index, 1);
  return list;
}

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = {
    buildSearchDeepLink: buildSearchDeepLink,
    buildMoneyDeepLink: buildMoneyDeepLink,
    canonicalLensQueryState: canonicalLensQueryState,
    composeLensQueryState: composeLensQueryState,
    lensQueryStateFilter: lensQueryStateFilter,
    canonicalSearchURL: canonicalSearchURL,
    moneyActiveFilterItems: moneyActiveFilterItems,
    presetLens: presetLens,
    parsePresetStore: parsePresetStore,
    savePreset: savePreset,
    removePreset: removePreset,
  };
}
