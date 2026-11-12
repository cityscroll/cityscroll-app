// PASSPort Public RFx `main_commodity` -> NYC commodity category (L3).
//
// The RFx dump's Main Commodity column carries the City's own L3 category label from the
// NYC Commodity Classification Directory (measured 2026-11-12: 12,533 of 12,585 parsed rows
// match exactly). Resolution is an exact normalized-label lookup against the published
// categories artifact; a label that matches nothing stays unmatched with its raw text, and
// nothing is guessed. The index is the L3 projection of the public categories artifact
// (site/data/procurement_codes/nyc-commodity-categories.json), derived by
// tools/build_procurement_code_manifest.mjs and checked against it, so the edge resolves
// without a fetch and without the 9,038 code rows on its startup graph.

import categories from "../data/nyc_commodity_l3_categories.json" with { type: "json" };
import {
  buildCommodityCategoryIndex,
  resolveCommodityCategory,
  summarizeCommodityCategoryCoverage,
} from "../../../site/procurement_code_catalog.mjs";

let defaultIndex = null;

/** The L3 label index over the bundled categories artifact (built once, refuses duplicates). */
export function passportCommodityCategoryIndex() {
  defaultIndex ||= buildCommodityCategoryIndex(categories);
  return defaultIndex;
}

/**
 * Category for one parsed RFx row: matched {code,label,level,parents}, unmatched {raw_label},
 * or no_label. If the bundled index itself is unusable the read stays up and says so.
 */
export function passportRfxCommodityCategory(row, index = null) {
  let resolved = index;
  if (!resolved) {
    try {
      resolved = passportCommodityCategoryIndex();
    } catch {
      return { status: "unavailable", reason: "category_index_invalid" };
    }
  }
  return resolveCommodityCategory(row?.main_commodity, resolved);
}

/** Coverage over a parsed RFx population: total, matched, unmatched, no_label, by RFx status. */
export function passportRfxCommodityCoverage(rows, index = passportCommodityCategoryIndex()) {
  return summarizeCommodityCategoryCoverage(rows, index);
}
