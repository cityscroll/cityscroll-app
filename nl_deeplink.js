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

  if (!keywords.length && !agency && !minAmount && !maxAmount && !category && !months && !noticeType && !excludeSpecial) {
    return null;
  }

  var params = new URLSearchParams();
  var wantsAward = noticeType === "award" || (!noticeType && (minAmount || maxAmount));
  params.set("mode", wantsAward ? "award" : "open");
  if (agency) params.set("agency", agency);
  if (keywords.length) params.set("q", keywords.join(" "));
  if (minAmount) params.set("min", String(minAmount));
  if (maxAmount) params.set("max", String(maxAmount));
  if (category) params.set("category", category);
  if (months) params.set("months", String(months));
  if (excludeSpecial) params.set("standard", "1");
  return "#money?" + params.toString();
}

function compactKeywords(value) {
  var values = Array.isArray(value) ? value : compactText(value, 320) ? [value] : [];
  return values
    .map(function (word) { return compactText(word, 80).toLowerCase(); })
    .filter(Boolean)
    .slice(0, 4);
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
    if (keywords.length) params.set("q", keywords.join(" "));
    if (f.status === "all") params.set("status", "all");
  } else {
    if (agency) params.set("agency", agency);
    if (keywords.length) params.set("q", keywords.join(" "));
    if (lens === "meetings" && f.when === "all") params.set("when", "all");
    if (lens === "property") {
      var asset = compactText(f.asset, 40);
      var stage = compactText(f.stage, 40);
      if (asset && asset !== "all") params.set("asset", asset);
      if (stage && stage !== "all") params.set("stage", stage);
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
  var pathname = compactText(loc.pathname, 2048) || "/";
  if (pathname.charAt(0) !== "/") pathname = "/" + pathname;
  var safeHash = /^#(?:money|people|land|property|rules|meetings)(?:\?[^#]*)?$/.test(hash || "")
    ? hash
    : "#money";
  return origin + pathname + safeHash;
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
    canonicalSearchURL: canonicalSearchURL,
    moneyActiveFilterItems: moneyActiveFilterItems,
    presetLens: presetLens,
    parsePresetStore: parsePresetStore,
    savePreset: savePreset,
    removePreset: removePreset,
  };
}
