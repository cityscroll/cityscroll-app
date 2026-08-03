// Browser-location helpers shared by the Land UI and its Node fixtures.
// Exact coordinates exist only long enough to make the existing GeoSearch request
// and the committed council-district point-in-polygon lookup. The returned
// application state contains the resolved NYC area and block, never the coordinates.

var GEOSEARCH_REVERSE = "https://geosearch.planninglabs.nyc/v2/reverse";
var MAPPLUTO_QUERY = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
var COUNCIL_BOUNDARIES_URL = "data/council_district_boundaries.json";
var LAND_AUTO_PROMPT_KEY = "crol_land_location_auto_asked_v1";
var councilBoundariesCache = null;
var councilLookupModulePromise = null;

function reverseGeoSearchURL(coords, endpoint) {
  var latitude = Number(coords && coords.latitude);
  var longitude = Number(coords && coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  var url = new URL(endpoint || GEOSEARCH_REVERSE);
  url.searchParams.set("size", "1");
  url.searchParams.set("point.lat", String(latitude));
  url.searchParams.set("point.lon", String(longitude));
  return url.toString();
}

function geoSearchArea(payload) {
  var feature = payload && Array.isArray(payload.features) ? payload.features[0] : null;
  var properties = feature && feature.properties || {};
  var pad = properties.addendum && properties.addendum.pad || {};
  var bbl = typeof pad.bbl === "string" && /^\d{10}$/.test(pad.bbl) ? pad.bbl : null;
  var borough = typeof properties.borough === "string" ? properties.borough.trim() : "";
  if (!borough) return null;
  return {
    borough: borough,
    neighbourhood: typeof properties.neighbourhood === "string"
      ? properties.neighbourhood.trim()
      : "",
    label: typeof properties.label === "string" ? properties.label.trim() : "",
    bbl: bbl,
    block: bbl ? bbl.slice(0, 6) : null,
  };
}

function mapPlutoCommunityDistrictURL(bbl, endpoint) {
  if (typeof bbl !== "string" || !/^\d{10}$/.test(bbl)) return null;
  var url = new URL(endpoint || MAPPLUTO_QUERY);
  url.searchParams.set("where", "BBL=" + bbl);
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("outFields", "CD");
  url.searchParams.set("f", "json");
  return url.toString();
}

function mapPlutoCommunityDistrict(payload, borough) {
  var feature = payload && Array.isArray(payload.features) ? payload.features[0] : null;
  var value = Number(feature && feature.attributes && feature.attributes.CD);
  var prefixes = {
    Manhattan: "M",
    Bronx: "X",
    Brooklyn: "K",
    Queens: "Q",
    "Staten Island": "R",
  };
  var prefix = prefixes[borough];
  var boroughCodes = { Manhattan: 1, Bronx: 2, Brooklyn: 3, Queens: 4, "Staten Island": 5 };
  var district = value % 100;
  if (!prefix || !Number.isInteger(value) || Math.floor(value / 100) !== boroughCodes[borough]
      || district < 1 || district > 18) {
    return null;
  }
  return prefix + String(district).padStart(2, "0");
}

function loadCouncilLookupModule() {
  if (councilLookupModulePromise) return councilLookupModulePromise;
  // Dynamic import works from classic browser scripts and from Node tests that
  // require this file. Fail soft when the module cannot load.
  councilLookupModulePromise = import("./council_district_lookup.mjs").catch(function () {
    return null;
  });
  return councilLookupModulePromise;
}

async function loadCouncilBoundaries(settings) {
  var options = settings || {};
  if (options.councilBoundaries) return options.councilBoundaries;
  if (councilBoundariesCache) return councilBoundariesCache;
  var fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== "function") return null;
  var url = options.councilBoundariesUrl || COUNCIL_BOUNDARIES_URL;
  try {
    var response = await fetchImpl(url);
    if (!response || response.ok === false) return null;
    var doc = await response.json();
    var lookup = await loadCouncilLookupModule();
    var layer = lookup && typeof lookup.loadCouncilDistrictLayer === "function"
      ? lookup.loadCouncilDistrictLayer(doc)
      : doc;
    if (layer && Array.isArray(layer.districts)) {
      councilBoundariesCache = layer;
      return layer;
    }
  } catch (_error) {}
  return null;
}

async function resolveCouncilDistrictForCoords(coords, settings) {
  var latitude = Number(coords && coords.latitude);
  var longitude = Number(coords && coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (settings && typeof settings.councilDistrict === "string") {
    return settings.councilDistrict;
  }
  try {
    var lookup = await loadCouncilLookupModule();
    if (!lookup || typeof lookup.resolveCouncilDistrict !== "function") return null;
    var layer = await loadCouncilBoundaries(settings);
    if (!layer) return null;
    return lookup.resolveCouncilDistrict(latitude, longitude, layer);
  } catch (_error) {
    return null;
  }
}

function requestCurrentArea(options) {
  var settings = options || {};
  var geolocation = settings.geolocation;
  var fetchImpl = settings.fetchImpl;
  if (!geolocation || typeof geolocation.getCurrentPosition !== "function"
      || typeof fetchImpl !== "function") {
    return Promise.resolve(null);
  }

  return new Promise(function (resolve) {
    try {
      geolocation.getCurrentPosition(async function (position) {
        try {
          var coords = position && position.coords;
          var url = reverseGeoSearchURL(coords, settings.endpoint);
          if (!url) return resolve(null);
          var response = await fetchImpl(url);
          if (!response || response.ok === false) return resolve(null);
          var area = geoSearchArea(await response.json());
          if (!area) return resolve(null);
          var districtUrl = mapPlutoCommunityDistrictURL(area.bbl, settings.mapPlutoEndpoint);
          if (districtUrl) {
            try {
              var districtResponse = await fetchImpl(districtUrl);
              if (districtResponse && districtResponse.ok !== false) {
                area.communityDistrict = mapPlutoCommunityDistrict(
                  await districtResponse.json(),
                  area.borough,
                );
              }
            } catch (_districtError) {}
          }
          // Coordinates exist only here — resolve council district from the
          // committed boundary layer, then drop lat/lon from the returned area.
          try {
            var councilId = await resolveCouncilDistrictForCoords(coords, settings);
            if (councilId) area.councilDistrict = councilId;
          } catch (_councilError) {}
          resolve(area);
        } catch (_error) {
          resolve(null);
        }
      }, function () {
        resolve(null);
      }, {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000,
      });
    } catch (_error) {
      resolve(null);
    }
  });
}

function claimLandAutoPrompt(storage) {
  if (!storage || typeof storage.getItem !== "function"
      || typeof storage.setItem !== "function") return false;
  try {
    if (storage.getItem(LAND_AUTO_PROMPT_KEY)) return false;
    storage.setItem(LAND_AUTO_PROMPT_KEY, "1");
    return true;
  } catch (_error) {
    return false;
  }
}

async function resolveLandEntryLocation(options) {
  var settings = options || {};
  var permissions = settings.permissions;
  if (!permissions || typeof permissions.query !== "function") return null;
  try {
    var permission = await permissions.query({ name: "geolocation" });
    if (!permission) return null;
    if (permission.state === "prompt" && !claimLandAutoPrompt(settings.storage)) return null;
    if (permission.state !== "granted" && permission.state !== "prompt") return null;
    var area = await requestCurrentArea(settings);
    if (area && typeof settings.onResolved === "function") settings.onResolved(area);
    return area;
  } catch (_error) {
    return null;
  }
}

function bindLocationControl(button, options) {
  if (!button || typeof button.addEventListener !== "function") return;
  var settings = options || {};
  button.addEventListener("click", async function () {
    button.disabled = true;
    try {
      var area = await requestCurrentArea(settings);
      if (area && typeof settings.onResolved === "function") settings.onResolved(area);
    } finally {
      button.disabled = false;
    }
  });
}

function coarseLandFilter(area, status) {
  return {
    boro: area && area.borough || null,
    communityDistrict: area && area.communityDistrict || null,
    councilDistrict: area && area.councilDistrict || null,
    keywords: [],
    status: status === "all" ? "all" : "active",
  };
}

// Test helper: clear the module-level boundary cache between cases.
function resetCouncilBoundariesCache() {
  councilBoundariesCache = null;
}

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = {
    bindLocationControl: bindLocationControl,
    coarseLandFilter: coarseLandFilter,
    geoSearchArea: geoSearchArea,
    loadCouncilBoundaries: loadCouncilBoundaries,
    mapPlutoCommunityDistrict: mapPlutoCommunityDistrict,
    mapPlutoCommunityDistrictURL: mapPlutoCommunityDistrictURL,
    requestCurrentArea: requestCurrentArea,
    resetCouncilBoundariesCache: resetCouncilBoundariesCache,
    resolveCouncilDistrictForCoords: resolveCouncilDistrictForCoords,
    resolveLandEntryLocation: resolveLandEntryLocation,
    reverseGeoSearchURL: reverseGeoSearchURL,
  };
}
