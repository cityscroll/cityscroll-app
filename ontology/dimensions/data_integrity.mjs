// Dimension: data-integrity
// For every imputed/joined feature, verify ≥1 non-null example exists
// against a declared public-source expectation. Always-null / broken-join
// features emit a bugfix card.

import { makeDimensionCard } from "./shared.mjs";

export const DIMENSION_ID = "data-integrity";

/**
 * @param {object} input
 * @param {Array<object>} input.features — feature inventory rows
 *   { id, surface, field, join_path, public_source, example_non_null, example_ref?, always_null?, broken_join? }
 * @param {object} [input.gap_taxonomy] — optional live gap taxonomy for cross-check
 */
export function evaluateDataIntegrity(input = {}) {
  const features = Array.isArray(input.features) ? input.features : [];
  const cards = [];
  const metrics = {
    features_checked: features.length,
    always_null: 0,
    broken_join: 0,
    ok: 0,
  };

  for (const feature of features) {
    const id = String(feature.id || feature.field || "").trim();
    if (!id) continue;

    const alwaysNull = feature.always_null === true
      || feature.example_non_null === null
      || feature.example_non_null === undefined
      || feature.example_non_null === "";
    const brokenJoin = feature.broken_join === true
      || feature.join_status === "broken"
      || feature.join_status === "error";

    if (!alwaysNull && !brokenJoin) {
      metrics.ok += 1;
      continue;
    }

    if (alwaysNull) metrics.always_null += 1;
    if (brokenJoin) metrics.broken_join += 1;

    const kind = brokenJoin ? "broken-join" : "always-null";
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `${kind}-${id}`,
      title: brokenJoin
        ? `Repair broken join for feature ${id}`
        : `Restore non-null example for feature ${id}`,
      rank_score: brokenJoin ? 88 : 82,
      evidence: {
        feature_id: id,
        surface: feature.surface || null,
        field: feature.field || id,
        join_path: feature.join_path || null,
        public_source: feature.public_source || null,
        example_non_null: feature.example_non_null ?? null,
        example_ref: feature.example_ref || null,
        kind,
      },
      verify: feature.verify
        || `node --test test/multi_flywheel_dimensions.test.mjs # data-integrity:${id} has example_non_null`,
      demo_win: feature.demo_win
        || `Readers see a real ${feature.field || id} value from ${feature.public_source || "the public source"} instead of an empty joined slot.`,
      context: [
        feature.surface,
        feature.join_path,
        "ontology/fixtures/dimensions/data_integrity_features.json",
      ].filter(Boolean),
      lesson_class: brokenJoin ? "broken-join-feature" : "always-null-imputed-feature",
    }));
  }

  // Cross-check: class-(a) gaps with empty realized coverage hint integrity holes
  const gaps = Array.isArray(input.gap_taxonomy?.gaps) ? input.gap_taxonomy.gaps : [];
  for (const gap of gaps) {
    if (gap.class !== "not_yet_ingested") continue;
    if (gap.realized_coverage != null && Number(gap.realized_coverage) > 0) continue;
    // Avoid double-emitting if the feature inventory already covers this gap id
    if (cards.some((c) => c.evidence?.feature_id === gap.id)) continue;
    // Only emit when the inventory explicitly lists no features for this gap surface
    // and the gap is marked for integrity probe.
    if (gap.integrity_probe !== true) continue;
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `gap-probe-${gap.id}`,
      title: `Integrity probe: no joined examples for gap ${gap.id}`,
      rank_score: 75,
      evidence: {
        feature_id: gap.id,
        surface: gap.surface || null,
        public_source: gap.public_source?.name || null,
        kind: "gap-integrity-probe",
      },
      verify: `node --test test/gap_taxonomy.test.mjs # integrity probe ${gap.id}`,
      demo_win: `A joined example appears for ${gap.id} once the class-(a) source is ingested.`,
      context: ["site/data/gap_taxonomy.json", gap.i18n_key].filter(Boolean),
      lesson_class: "always-null-imputed-feature",
    }));
  }

  return {
    dimension: DIMENSION_ID,
    metrics,
    cards,
  };
}
