/**
 * Classic synchronous scrub for capability-compare profile query params.
 *
 * Included in <head> before analytics.js and clarity.js so legacy
 * capability_keywords / jet_vac_truck / landscaping never remain in
 * location.href when those collectors first read the URL. The module boot in
 * app/capability-compare.mjs still scrubs as a backup.
 */
(function () {
  "use strict";

  var PROFILE_KEYS = ["capability_keywords", "jet_vac_truck", "landscaping"];
  var STORAGE_KEY = "crol:capability-compare:profile.v1";
  var HISTORY_KEY = "capabilityCompareProfile";

  function hasProfileParams(params) {
    for (var i = 0; i < PROFILE_KEYS.length; i++) {
      if (params.has(PROFILE_KEYS[i])) return true;
    }
    return false;
  }

  function ternary(raw) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  }

  function profileFromParams(params) {
    var keywordsRaw = String(params.get("capability_keywords") || "").split(/[,;]/);
    var keywords = [];
    for (var i = 0; i < keywordsRaw.length; i++) {
      var kw = String(keywordsRaw[i] || "").trim();
      if (kw) keywords.push(kw);
    }
    return {
      capability_keywords: keywords,
      jet_vac_truck: ternary(params.get("jet_vac_truck")),
      landscaping: ternary(params.get("landscaping")),
    };
  }

  function scrub() {
    var url = new URL(location.href);
    if (!hasProfileParams(url.searchParams)) return false;
    var profile = profileFromParams(url.searchParams);
    try {
      if (typeof sessionStorage !== "undefined" && sessionStorage) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
      }
    } catch (_storageErr) {
      /* sessionStorage may be blocked; URL strip still proceeds */
    }
    for (var i = 0; i < PROFILE_KEYS.length; i++) {
      url.searchParams.delete(PROFILE_KEYS[i]);
    }
    var nextState =
      history.state && typeof history.state === "object" && !Array.isArray(history.state)
        ? Object.assign({}, history.state)
        : {};
    nextState[HISTORY_KEY] = profile;
    history.replaceState(nextState, "", url.pathname + url.search + url.hash);
    return true;
  }

  try {
    scrub();
  } catch (_err) {
    /* fail-soft: module boot still scrubs */
  }
})();
