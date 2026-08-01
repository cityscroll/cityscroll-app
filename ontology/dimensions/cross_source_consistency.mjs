// Dimension: cross-source-consistency
// Where sources disagree on a subject, emit a reconciliation card.
// Uses cross-spine fixture failures + explicit disagreement inventory.

import { makeDimensionCard } from "./shared.mjs";
import { validateCrossSpineBundle } from "../cross_spine.mjs";

export const DIMENSION_ID = "cross-source-consistency";

/**
 * @param {object} input
 * @param {Array<object>} [input.disagreements] — explicit subject disagreements
 * @param {Array<object>} [input.cross_spine_bundles] — bundles to validate
 * @param {object} [input.cross_spine_summary] — { checked, contradictions }
 */
export function evaluateCrossSourceConsistency(input = {}) {
  const disagreements = Array.isArray(input.disagreements) ? input.disagreements : [];
  const bundles = Array.isArray(input.cross_spine_bundles) ? input.cross_spine_bundles : [];
  const cards = [];
  const metrics = {
    disagreements_checked: disagreements.length,
    open_disagreements: 0,
    cross_spine_checked: 0,
    cross_spine_contradictions: 0,
  };

  for (const row of disagreements) {
    const subject = String(row.subject_ref || row.subject || row.id || "").trim();
    if (!subject) continue;
    if (row.resolved === true || row.status === "reconciled") continue;

    metrics.open_disagreements += 1;
    const field = row.field || row.fact || "value";
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `disagree-${slugify(subject)}-${slugify(field)}`,
      title: `Reconcile cross-source ${field} on ${subject}`,
      rank_score: row.severity === "high" ? 91 : row.severity === "low" ? 60 : 84,
      evidence: {
        subject_ref: subject,
        field,
        left: row.left || null,
        right: row.right || null,
        sources: row.sources || [row.left?.source, row.right?.source].filter(Boolean),
        claim_layer: row.claim_layer || null,
        kind: "source-disagreement",
      },
      verify: row.verify
        || `node --test test/multi_flywheel_dimensions.test.mjs # consistency:${subject}:${field} reconciled`,
      demo_win: row.demo_win
        || `Readers see labeled source assertions for ${field} on ${subject} without a silent winner.`,
      context: [
        "ontology/fixtures/dimensions/cross_source_disagreements.json",
        row.context || null,
      ].filter(Boolean),
      lesson_class: "cross-source-disagreement",
      needs_human: row.needs_human || "reconciliation_policy",
    }));
  }

  for (const bundle of bundles) {
    metrics.cross_spine_checked += 1;
    let result;
    try {
      result = validateCrossSpineBundle(bundle);
    } catch (error) {
      result = {
        ok: false,
        subject_ref: bundle?.subject_ref || "unknown",
        contradictions: 1,
        checks: [{ id: "bundle_error", pass: false, detail: String(error.message || error) }],
      };
    }
    if (result.ok) continue;
    metrics.cross_spine_contradictions += 1;
    const failed = (result.checks || []).filter((c) => !c.pass);
    const subject = result.subject_ref || bundle.subject_ref || "unknown";
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `spine-${slugify(subject)}`,
      title: `Resolve cross-spine contradiction: ${subject}`,
      rank_score: 90,
      evidence: {
        subject_ref: subject,
        failed_checks: failed.map((c) => c.id),
        contradictions: result.contradictions ?? failed.length,
        kind: "cross-spine-contradiction",
      },
      verify: "node tools/cross_spine_validate.mjs --fixtures ontology/fixtures/cross_spine --check",
      demo_win: `Subject ${subject} agrees across ER, process spine, and lifecycle identity keys.`,
      context: ["ontology/cross_spine.mjs", "ontology/fixtures/cross_spine"],
      lesson_class: "cross-spine-contradiction",
    }));
  }

  // Summary-only path (when only aggregate counts are available)
  const summary = input.cross_spine_summary;
  if (summary && Number(summary.contradictions) > 0 && metrics.cross_spine_checked === 0) {
    metrics.cross_spine_checked = Number(summary.checked) || 0;
    metrics.cross_spine_contradictions = Number(summary.contradictions) || 0;
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "spine-summary-contradictions",
      title: "Resolve open cross-spine agreement failures",
      rank_score: 89,
      evidence: {
        checked: summary.checked,
        contradictions: summary.contradictions,
        kind: "cross-spine-summary",
      },
      verify: "node tools/cross_spine_validate.mjs",
      demo_win: "All committed cross-spine pass fixtures agree; fail fixtures stay intentional characterization.",
      context: ["ontology/cross_spine.mjs"],
      lesson_class: "cross-spine-contradiction",
    }));
  }

  return {
    dimension: DIMENSION_ID,
    metrics,
    cards,
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "unknown";
}
