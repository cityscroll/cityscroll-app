// Browser-location helpers shared by the Land UI and its Node fixtures.
// Exact coordinates exist only long enough to make the existing GeoSearch request
// and the committed district-boundary point-in-polygon lookup (community + council).
// The returned application state contains the resolved NYC area and block, never the coordinates.

var GEOSEARCH_REVERSE = "https://geosearch.planninglabs.nyc/v2/reverse";
// Kept for lot-geometry / BBL tools that still need MapPLUTO; district resolution
// uses the committed boundary layer (no per-BBL CD round-trip).
var MAPPLUTO_QUERY = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
var DISTRICT_BOUNDARIES_URL = "data/district_boundaries.json";
// Legacy council-only path (compat when unified artifact is missing).
var COUNCIL_BOUNDARIES_URL = "data/council_district_boundaries.json";
var districtBoundariesCache = null;
var districtLookupModulePromise = null;

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

function loadDistrictLookupModule() {
  if (districtLookupModulePromise) return districtLookupModulePromise;
  districtLookupModulePromise = import("./council_district_lookup.mjs").catch(function () {
    return null;
  });
  return districtLookupModulePromise;
}

async function loadDistrictBoundaries(settings) {
  var options = settings || {};
  if (options.districtBoundaries) return options.districtBoundaries;
  if (options.councilBoundaries) return options.councilBoundaries;
  if (districtBoundariesCache) return districtBoundariesCache;
  var fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== "function") return null;
  var primaryUrl = options.districtBoundariesUrl || DISTRICT_BOUNDARIES_URL;
  var fallbackUrl = options.councilBoundariesUrl || COUNCIL_BOUNDARIES_URL;
  try {
    var response = await fetchImpl(primaryUrl);
    if (!response || response.ok === false) {
      response = await fetchImpl(fallbackUrl);
    }
    if (!response || response.ok === false) return null;
    var doc = await response.json();
    var lookup = await loadDistrictLookupModule();
    var layer = null;
    if (lookup && typeof lookup.loadDistrictBoundariesLayer === "function") {
      layer = lookup.loadDistrictBoundariesLayer(doc);
    }
    if (!layer && lookup && typeof lookup.loadCouncilDistrictLayer === "function") {
      layer = lookup.loadCouncilDistrictLayer(doc);
    }
    if (!layer) layer = doc;
    if (layer && (Array.isArray(layer.council_districts) || Array.isArray(layer.districts)
        || Array.isArray(layer.community_districts))) {
      districtBoundariesCache = layer;
      return layer;
    }
  } catch (_error) {}
  return null;
}

// Compat alias used by existing tests.
async function loadCouncilBoundaries(settings) {
  return loadDistrictBoundaries(settings);
}

async function resolveDistrictsForCoords(coords, settings) {
  var latitude = Number(coords && coords.latitude);
  var longitude = Number(coords && coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { community_district: null, council_district: null, boundary_vintage: null };
  }
  var forcedCommunity = settings && typeof settings.communityDistrict === "string"
    ? settings.communityDistrict
    : null;
  var forcedCouncil = settings && typeof settings.councilDistrict === "string"
    ? settings.councilDistrict
    : null;
  try {
    var lookup = await loadDistrictLookupModule();
    var layer = await loadDistrictBoundaries(settings);
    if (!lookup || !layer) {
      return {
        community_district: forcedCommunity,
        council_district: forcedCouncil,
        boundary_vintage: null,
      };
    }
    var resolved = typeof lookup.resolveDistricts === "function"
      ? lookup.resolveDistricts(latitude, longitude, layer)
      : {
        community_district: null,
        council_district: typeof lookup.resolveCouncilDistrict === "function"
          ? lookup.resolveCouncilDistrict(latitude, longitude, layer)
          : null,
        boundary_vintage: layer.boundary_vintage || null,
      };
    return {
      community_district: forcedCommunity || resolved.community_district,
      council_district: forcedCouncil || resolved.council_district,
      boundary_vintage: resolved.boundary_vintage || layer.boundary_vintage || null,
    };
  } catch (_error) {
    return {
      community_district: forcedCommunity,
      council_district: forcedCouncil,
      boundary_vintage: null,
    };
  }
}

async function resolveCouncilDistrictForCoords(coords, settings) {
  var result = await resolveDistrictsForCoords(coords, settings);
  return result.council_district || null;
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
          // Coordinates exist only here — resolve community + council from the
          // committed boundary layer, then drop lat/lon from the returned area.
          try {
            var districts = await resolveDistrictsForCoords(coords, settings);
            if (districts.community_district) {
              area.communityDistrict = districts.community_district;
            }
            if (districts.council_district) {
              area.councilDistrict = districts.council_district;
            }
            if (districts.boundary_vintage) {
              area.boundaryVintage = districts.boundary_vintage;
            }
          } catch (_districtError) {}
          // Optional MapPLUTO fallback only when the committed layer has no
          // community polygon for this point (offline-safe primary path is the layer).
          if (!area.communityDistrict && area.bbl) {
            var districtUrl = mapPlutoCommunityDistrictURL(area.bbl, settings.mapPlutoEndpoint);
            if (districtUrl) {
              try {
                var districtResponse = await fetchImpl(districtUrl);
                if (districtResponse && districtResponse.ok !== false) {
                  var cd = mapPlutoCommunityDistrict(
                    await districtResponse.json(),
                    area.borough,
                  );
                  if (cd) area.communityDistrict = cd;
                }
              } catch (_mapPlutoError) {}
            }
          }
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

// Compatibility boundary for older callers: entering a route never resolves location.
// Only bindLocationControl may call the area resolver, from its click listener.
function resolveLandEntryLocation() {
  return Promise.resolve(null);
}

function coarseLandFilter(area, status) {
  return {
    boro: area && area.borough || null,
    communityDistrict: area && area.communityDistrict || null,
    councilDistrict: area && area.councilDistrict || null,
    keywords: [],
    status: ["active", "hearings"].includes(status) ? status : "all",
  };
}

// Test helper: clear the module-level boundary cache between cases.
function resetCouncilBoundariesCache() {
  districtBoundariesCache = null;
}

function resetDistrictBoundariesCache() {
  districtBoundariesCache = null;
}

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = {
    bindLocationControl: bindLocationControl,
    coarseLandFilter: coarseLandFilter,
    geoSearchArea: geoSearchArea,
    loadCouncilBoundaries: loadCouncilBoundaries,
    loadDistrictBoundaries: loadDistrictBoundaries,
    mapPlutoCommunityDistrict: mapPlutoCommunityDistrict,
    mapPlutoCommunityDistrictURL: mapPlutoCommunityDistrictURL,
    requestCurrentArea: requestCurrentArea,
    resetCouncilBoundariesCache: resetCouncilBoundariesCache,
    resetDistrictBoundariesCache: resetDistrictBoundariesCache,
    resolveCouncilDistrictForCoords: resolveCouncilDistrictForCoords,
    resolveDistrictsForCoords: resolveDistrictsForCoords,
    resolveLandEntryLocation: resolveLandEntryLocation,
    reverseGeoSearchURL: reverseGeoSearchURL,
  };
}
