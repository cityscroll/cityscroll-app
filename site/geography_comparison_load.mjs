/**
 * Ordering-aware geography comparison layer load.
 *
 * Comparison is a secondary URL dimension. When two compare changes overlap,
 * only the load that still matches the latest requested compare may publish
 * map/layer state. An earlier response that resolves after a later choice must
 * be ignored.
 */

/**
 * True when the still-current compare matches the compare this load requested.
 * Invert or delete this check and stale responses overwrite the latest choice.
 */
export function isCompareLoadCurrent(currentCompare, requestedCompare) {
  return (currentCompare || null) === (requestedCompare || null);
}

function projectLayerDoc(compareType, layer) {
  return {
    type: compareType,
    geometry_fidelity: layer?.geometry_fidelity || "simplified",
    vintage: layer?.vintage || null,
    features: (layer?.features || []).map((feature) => ({
      key: feature.properties?.key || feature.key,
      id: feature.properties?.id || feature.id,
      type: feature.properties?.type || compareType,
      label: feature.properties?.label || feature.label,
      subtype: feature.properties?.subtype ?? feature.subtype ?? null,
      geometry: feature.geometry,
    })),
  };
}

/**
 * Load a comparison layer and publish it only when the request is still current.
 *
 * @param {object} options
 * @param {string|null} options.compareType
 * @param {(type: string) => Promise<object>} options.loadLayer
 * @param {() => (string|null|undefined)} options.getCurrentCompare
 * @param {() => (string|null|undefined)} [options.getCurrentKey]
 * @param {() => boolean} [options.isGenerationCurrent]
 * @param {(type: string|null, layerDoc?: object|null) => void} options.setComparisonLayer
 * @param {(key: string) => void} [options.setSelectedKey]
 * @param {(compareType: string, layer: object) => object} [options.projectLayer]
 * @param {(current: string|null, requested: string|null) => boolean} [options.compareIsCurrent]
 * @returns {Promise<{applied: boolean, reason: string, compare: string|null, layerDoc: object|null}>}
 */
export async function applyGeographyComparisonLoad({
  compareType,
  loadLayer,
  getCurrentCompare,
  getCurrentKey = () => null,
  isGenerationCurrent = () => true,
  setComparisonLayer,
  setSelectedKey = () => {},
  projectLayer = projectLayerDoc,
  compareIsCurrent = isCompareLoadCurrent,
} = {}) {
  if (typeof loadLayer !== "function") {
    throw new TypeError("applyGeographyComparisonLoad requires loadLayer");
  }
  if (typeof getCurrentCompare !== "function") {
    throw new TypeError("applyGeographyComparisonLoad requires getCurrentCompare");
  }
  if (typeof setComparisonLayer !== "function") {
    throw new TypeError("applyGeographyComparisonLoad requires setComparisonLayer");
  }

  const requestedCompare = compareType || null;
  if (!requestedCompare) {
    setComparisonLayer(null);
    const key = getCurrentKey?.();
    if (key) setSelectedKey(key);
    return {
      applied: true,
      reason: "cleared",
      compare: null,
      layerDoc: null,
    };
  }

  const layer = await loadLayer(requestedCompare);
  if (!isGenerationCurrent()) {
    return {
      applied: false,
      reason: "stale_generation",
      compare: requestedCompare,
      layerDoc: null,
    };
  }
  const currentCompare = getCurrentCompare() || null;
  if (!compareIsCurrent(currentCompare, requestedCompare)) {
    return {
      applied: false,
      reason: "stale_compare",
      compare: requestedCompare,
      layerDoc: null,
    };
  }

  const layerDoc = projectLayer(requestedCompare, layer);
  setComparisonLayer(requestedCompare, layerDoc);
  const key = getCurrentKey?.();
  if (key) setSelectedKey(key);
  return {
    applied: true,
    reason: "applied",
    compare: requestedCompare,
    layerDoc,
  };
}

export const __test__ = Object.freeze({
  projectLayerDoc,
});
