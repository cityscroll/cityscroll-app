// Pure helpers for replayable Money-lens filters and device-local presets.
// No DOM or network access: browser code uses the globals below and Node tests require them.

var NLQ_PRESET_LIMIT = 8;

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

function validPreset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var label = compactText(value.label, 100);
  var hash = compactText(value.hash, 2000);
  if (!label || !/^#money\?(?:[^#]*)$/.test(hash)) return null;
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
    buildMoneyDeepLink: buildMoneyDeepLink,
    parsePresetStore: parsePresetStore,
    savePreset: savePreset,
    removePreset: removePreset,
  };
}
