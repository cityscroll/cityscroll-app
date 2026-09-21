/** Browser-only CARTO key: substituted in release output, never in source. */
export const CARTO_BASEMAP_API_KEY = "__CITYSCROLL_CARTO_BASEMAP_API_KEY__";

export function hasConfiguredCartoBasemapKey(value = CARTO_BASEMAP_API_KEY) {
  return typeof value === "string" && /^cb1_[A-Za-z0-9_-]{16,496}$/.test(value);
}

export function cartoBasemapTileUrl({ subdomain = "a", retina = false, apiKey = CARTO_BASEMAP_API_KEY } = {}) {
  const base = `https://${subdomain}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}${retina ? "{r}" : ""}.png`;
  return hasConfiguredCartoBasemapKey(apiKey) ? `${base}?key=${encodeURIComponent(apiKey)}` : base;
}
