/**
 * SEQRA-06: vintage-versioned PLUTO/zoning/receptor and environmental-site/
 * disadvantage/flood joins over a project's BBL history (card acceptance
 * A1, A2, A3, A5; negative rule).
 *
 * Each layer type keeps its own independent vintage series -- PLUTO and the
 * zoning map do not update on the same cadence as the state's disadvantaged-
 * community designations or a flood-risk layer, so there is deliberately no
 * shared "as-of" clock across layer types. `joinProjectLayersAtCutoff` joins
 * every BBL in the project's cutoff-appropriate footprint (from
 * seqra_bbl_lot_history.mjs, never the project's present-day BBL list)
 * against every registered layer type, using seqra_layer_vintage.mjs's
 * resolution primitive for each. A layer with no vintage covering the
 * cutoff never falls back to another vintage: it is refused and recorded in
 * `gaps`, and the corresponding feature simply does not appear in
 * `features` -- the negative rule ("do not replace historical data with
 * current project or spatial conditions to make a join succeed") is
 * structural here, not a convention callers must remember.
 */
import { resolveLayerVintage, SeqraLayerVintageError } from "./seqra_layer_vintage.mjs";
import { bblFootprintAsOf } from "./seqra_bbl_lot_history.mjs";
import { buildSpatialFeatureKey } from "./seqra_spatial_stable_keys.mjs";

export const SEQRA_SPATIAL_FEATURE_SCHEMA = "cityscroll.seqra_spatial_feature.v1";

/**
 * The six layer families the card names, grouped only for documentation --
 * every entry resolves through the same vintage primitive with no special
 * casing between the "PLUTO/zoning/receptor" and "environmental-site/
 * disadvantage/flood" bullets in the card.
 */
export const SEQRA_SPATIAL_LAYER_TYPES = Object.freeze([
  "pluto",
  "zoning",
  "receptor",
  "environmental_site",
  "disadvantaged_community",
  "flood",
]);

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

/**
 * Look up one BBL's attribute value within one resolved layer vintage.
 * `layerValuesByVintage` maps `vintage -> { [bbl]: value }`. A BBL absent
 * from the resolved vintage's row set is a present-vintage/absent-value
 * case (the layer covers this period but has no row for this BBL), kept
 * distinct from a vintage-coverage gap.
 */
function valueForBbl(layerValuesByVintage, vintage, bbl) {
  const table = layerValuesByVintage?.[vintage];
  if (!table || !(bbl in table)) return { presence: "absent", value: null };
  return { presence: "present", value: table[bbl] };
}

/**
 * Join one layer type for one BBL at one cutoff. Returns a frozen spatial
 * feature record on success. Throws SeqraLayerVintageError (never a
 * fallback value) when the layer's vintage series does not cover `cutoff`;
 * callers that want the coverage-gap record instead of a throw should use
 * `joinProjectLayersAtCutoff`, which converts this into `gaps`.
 */
export function joinSpatialLayerAtCutoff({ layerType, bbl, cutoff, vintages, layerValuesByVintage }) {
  requireNonEmptyString(layerType, "layerType");
  requireNonEmptyString(bbl, "bbl");
  requireNonEmptyString(cutoff, "cutoff");
  const resolved = resolveLayerVintage({ layerType, bbl, cutoff, vintages });
  const { presence, value } = valueForBbl(layerValuesByVintage, resolved.vintage, bbl);
  return Object.freeze({
    schema: SEQRA_SPATIAL_FEATURE_SCHEMA,
    feature_key: buildSpatialFeatureKey({ layerType, bbl, layerVintage: resolved.vintage }),
    layer_type: layerType,
    bbl,
    cutoff,
    layer_vintage: resolved.vintage,
    layer_vintage_effective_start: resolved.effective_start,
    layer_vintage_effective_end: resolved.effective_end,
    presence,
    value,
  });
}

/**
 * Join every registered layer type for every BBL in a project's
 * cutoff-appropriate footprint. `layerRegistry` is `{ [layerType]: {
 * vintages, layerValuesByVintage } }`; a layer type absent from the
 * registry is skipped rather than defaulting to anything.
 *
 * Returns `{ cutoff, footprint, features, gaps }`. `features` never
 * contains an entry for a refused join -- every refusal appears in `gaps`
 * instead (A5), and `features.length + gaps.length` always equals
 * `footprint.bbls.length * layerTypesJoined.length`, so a caller can detect
 * silent completion by that count alone.
 */
export function joinProjectLayersAtCutoff({ history, cutoff, layerRegistry, layerTypes = SEQRA_SPATIAL_LAYER_TYPES }) {
  const footprint = bblFootprintAsOf(history, cutoff);
  const layerTypesJoined = layerTypes.filter((layerType) => layerType in (layerRegistry || {}));
  const features = [];
  const gaps = [];

  for (const bbl of footprint.bbls) {
    for (const layerType of layerTypesJoined) {
      const { vintages, layerValuesByVintage } = layerRegistry[layerType];
      try {
        features.push(joinSpatialLayerAtCutoff({ layerType, bbl, cutoff, vintages, layerValuesByVintage }));
      } catch (error) {
        if (error instanceof SeqraLayerVintageError) {
          gaps.push(error.coverageGap);
        } else {
          throw error;
        }
      }
    }
  }

  return {
    cutoff,
    footprint,
    layer_types_joined: layerTypesJoined,
    features,
    gaps,
  };
}
