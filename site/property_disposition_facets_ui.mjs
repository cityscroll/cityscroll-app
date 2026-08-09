/**
 * Property disposition facet rail HTML — shareable scope-link chips.
 * Pure markup helper; the Property app module owns DOM wiring and state.
 */

import {
  countPropertyPriceBands,
  countPropertySaleMethods,
  countPropertyTemporalStages,
  propertyFacetChipItems,
  propertyPriceBandControlModel,
  propertyProcessControlModel,
  propertySaleMethodControlModel,
  propertyTemporalControlModel,
} from "./property_disposition_facets.mjs";
import { filterChip } from "./affordance_grammar.mjs";

/**
 * Build HTML for the four disposition facet rails.
 *
 * @param {object} opts
 * @param {object[]} opts.entries — full explorer entries (pre-facet)
 * @param {(row: object) => object|null} opts.commercialOf
 * @param {(row: object) => string|null} opts.temporalOf
 * @param {string} opts.today
 * @param {(overrides: object) => number} opts.currentCountFor
 * @param {(entries: object[]) => Record<string, number>} opts.countProcessStages
 * @param {object} opts.baseState — current lens state for composed hrefs
 * @param {string} opts.saleMethod
 * @param {string} opts.priceBand
 * @param {string} opts.process
 * @param {string} opts.temporal
 * @param {(key: string, vars?: object) => string} opts.t
 * @param {(value: string) => string} opts.escape
 * @returns {{ sale: string, price: string, process: string, temporal: string }}
 */
export function propertyDispositionFacetRailsHTML(opts) {
  const escape = typeof opts.escape === "function" ? opts.escape : (v) => String(v ?? "");
  const t = typeof opts.t === "function" ? opts.t : (k) => k;
  const entries = opts.entries || [];
  const commercialOf = opts.commercialOf;
  const baseState = opts.baseState || {};
  const currentCountFor = typeof opts.currentCountFor === "function"
    ? opts.currentCountFor
    : () => 0;

  const saleCounts = countPropertySaleMethods(entries, commercialOf);
  for (const key of Object.keys(saleCounts)) {
    saleCounts[key] = currentCountFor({ saleMethod: key === "all" ? "all" : key });
  }
  const saleModel = propertySaleMethodControlModel(saleCounts, opts.saleMethod || "all", {
    ...baseState,
    saleMethod: null,
  });

  const priceCounts = countPropertyPriceBands(entries, commercialOf);
  for (const key of Object.keys(priceCounts)) {
    if (key === "unpriced") continue;
    priceCounts[key] = currentCountFor({ priceBand: key === "all" ? "all" : key });
  }
  const priceModel = propertyPriceBandControlModel(priceCounts, opts.priceBand || "all", {
    ...baseState,
    priceBand: null,
  });

  const processCounts = typeof opts.countProcessStages === "function"
    ? opts.countProcessStages(entries)
    : { all: entries.length };
  for (const key of Object.keys(processCounts)) {
    processCounts[key] = currentCountFor({ process: key });
  }
  const processModel = propertyProcessControlModel(processCounts, opts.process || "all", {
    ...baseState,
    process: null,
  });

  const temporalCounts = countPropertyTemporalStages(entries, {
    today: opts.today,
    temporalOf: opts.temporalOf,
  });
  for (const key of Object.keys(temporalCounts)) {
    if (key === "undated") continue;
    temporalCounts[key] = currentCountFor({ temporal: key });
  }
  const temporalModel = propertyTemporalControlModel(temporalCounts, opts.temporal || "all", {
    ...baseState,
    stage: null,
  });

  const chip = (item) => {
    const attr = escape(item.data_attr || "facet");
    return filterChip({
      label: t(item.label_key),
      count: item.count,
      pressed: item.pressed,
      className: item.pressed ? "on" : "",
      attributes: {
        [`data-${attr}`]: item.id,
        ...(item.scope_edge ? { "data-scope-edge": item.scope_edge } : {}),
        "data-filter-href": item.href || "#property",
      },
      escape,
    });
  };
  const rail = (kind, model) => propertyFacetChipItems(model, kind).map(chip).join("");

  return {
    sale: rail("saleMethod", saleModel),
    price: rail("priceBand", priceModel),
    process: rail("process", processModel),
    temporal: rail("temporal", temporalModel),
  };
}

/**
 * Bind click handlers on scope-link chips so the SPA applies the typed edge.
 * Modifier-clicks keep default browser navigation on the shareable href.
 *
 * @param {Element|null} el
 * @param {(value: string|null) => void} apply
 */
export function bindPropertyScopeFacetRail(el, apply) {
  if (!el || typeof apply !== "function") return;
  el.querySelectorAll(".ui-filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const attr = button.getAttributeNames().find((name) => name.startsWith("data-") && name !== "data-filter-href" && name !== "data-scope-edge");
      apply(attr ? button.getAttribute(attr) : null);
    });
  });
}
