// Dimension: data-integrity
//
// CORE continuous test — population not-published-rate credibility audit:
// for every reader-facing "the city does not publish X" register, sample
// recent + historical entries, compute not-published rate, and flag ~100%
// claims as broken-join / never-ingested / mislabeled red flags when the
// real public source has data. A false not-published claim damages product
// credibility more than a visible gap.
//
// Secondary: always-null / broken-join feature inventory (non-null example test).

import { makeDimensionCard } from "./shared.mjs";
import {
  enumerateNotPublishedClaims,
  attachSamplesToClaims,
  evaluateNotPublishedClaims,
  computeNotPublishedRate,
  classifyNotPublishedClaim,
  NOT_PUBLISHED_THRESHOLDS,
} from "./not_published_rate.mjs";

export const DIMENSION_ID = "data-integrity";

export {
  computeNotPublishedRate,
  classifyNotPublishedClaim,
  enumerateNotPublishedClaims,
  evaluateNotPublishedClaims,
  NOT_PUBLISHED_THRESHOLDS,
} from "./not_published_rate.mjs";

/**
 * @param {object} input
 * @param {object} [input.gap_taxonomy] — site/data/gap_taxonomy.json
 * @param {object|Array} [input.not_published_samples] — sample inventory
 * @param {Array<object>} [input.not_published_claims] — pre-merged claims with samples
 * @param {Array<object>} [input.features] — secondary feature inventory
 * @param {object} [input.thresholds] — override red_flag_rate / min_sample
 */
export function evaluateDataIntegrity(input = {}) {
  const cards = [];
  const thresholds = { ...NOT_PUBLISHED_THRESHOLDS, ...(input.thresholds || {}) };

  // ── Core: population not-published-rate ──────────────────────────────
  const extras = Array.isArray(input.not_published_claims)
    ? input.not_published_claims
    : Array.isArray(input.not_published_samples?.claims)
      ? input.not_published_samples.claims
      : [];

  let claims = enumerateNotPublishedClaims(input.gap_taxonomy || {}, extras);
  if (input.not_published_samples) {
    claims = attachSamplesToClaims(claims, input.not_published_samples);
  }
  // Prefer fully-specified sample rows when gap taxonomy is absent
  if (!claims.length && extras.length) {
    claims = extras.map((c) => ({ ...c, id: c.id || c.claim_id }));
  }

  const credibility = evaluateNotPublishedClaims(claims, { thresholds });
  const rateCards = cardsFromFindings(credibility.findings);
  cards.push(...rateCards);

  // Undersampled class-(b) registers: continuous audit must not skip them
  for (const finding of credibility.findings) {
    if (finding.classification !== "insufficient_sample") continue;
    // Skip if we already emitted from rate path (should not for insufficient)
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `undersampled-${finding.claim_id}`,
      title: `Sample not-published rate for claim ${finding.claim_id}`,
      rank_score: 70,
      evidence: {
        kind: "insufficient_sample",
        claim_id: finding.claim_id,
        field: finding.field,
        rate: finding.rate,
        reason: finding.reason,
        method: "population_not_published_rate",
      },
      verify: finding.verify
        || `node --test test/multi_flywheel_dimensions.test.mjs # not-published-rate sample n>=${thresholds.min_sample} for ${finding.claim_id}`,
      demo_win: `Claim ${finding.claim_id} has a measured recent+historical not-published rate so credibility can be audited continuously.`,
      context: [
        finding.surface,
        finding.gap_id,
        "ontology/fixtures/dimensions/not_published_claim_samples.json",
        "site/data/gap_taxonomy.json",
      ].filter(Boolean),
      lesson_class: "not-published-undersampled",
      needs_human: null,
    }));
  }

  // ── Secondary: feature always-null / broken-join inventory ───────────
  const features = Array.isArray(input.features) ? input.features : [];
  const featureMetrics = {
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
      featureMetrics.ok += 1;
      continue;
    }

    if (alwaysNull) featureMetrics.always_null += 1;
    if (brokenJoin) featureMetrics.broken_join += 1;

    // Dedup against rate-based cards for same feature/claim id
    if (cards.some((c) => c.evidence?.claim_id === id || c.evidence?.feature_id === id)) {
      continue;
    }

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
        method: "feature_non_null_example",
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

  return {
    dimension: DIMENSION_ID,
    metrics: {
      // Core credibility metrics first
      not_published_claims_checked: credibility.metrics.claims_checked,
      not_published_red_flags: credibility.metrics.red_flags,
      not_published_suspicious: credibility.metrics.suspicious,
      not_published_genuinely_withheld: credibility.metrics.genuinely_withheld,
      not_published_healthy: credibility.metrics.healthy,
      not_published_insufficient_sample: credibility.metrics.insufficient_sample,
      mean_not_published_rate: credibility.metrics.mean_not_published_rate,
      thresholds,
      // Secondary feature inventory
      ...featureMetrics,
      // Back-compat aliases used by earlier tests / receipts
      always_null: featureMetrics.always_null,
      broken_join: featureMetrics.broken_join + credibility.metrics.red_flags,
      ok: featureMetrics.ok + credibility.metrics.healthy,
    },
    findings: credibility.findings,
    cards,
  };
}

function cardsFromFindings(findings) {
  const cards = [];
  for (const finding of findings) {
    if (!finding.red_flag && !finding.suspicious) continue;
    if (finding.classification === "genuinely_withheld") continue;
    if (finding.classification === "healthy") continue;
    if (finding.classification === "insufficient_sample") continue;

    const isRed = finding.red_flag;
    const classLabel = finding.classification;
    const rateLabel = finding.rate?.rate_label || "n/a";
    const slugClass = isRed ? "red-flag" : "suspicious";

    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `${slugClass}-${finding.claim_id}`,
      title: isRed
        ? `Credibility red flag: ~100% not-published for ${finding.claim_id}`
        : `Suspicious not-published rate for ${finding.claim_id}`,
      rank_score: rankForFinding(finding),
      evidence: {
        kind: "not_published_rate_red_flag",
        method: "population_not_published_rate",
        claim_id: finding.claim_id,
        field: finding.field,
        surface: finding.surface,
        render: finding.render,
        i18n_keys: finding.i18n_keys,
        gap_id: finding.gap_id,
        not_published_rate: finding.rate?.rate ?? null,
        not_published_rate_label: rateLabel,
        sample_n: finding.rate?.n ?? null,
        recent_n: finding.rate?.recent_n ?? null,
        historical_n: finding.rate?.historical_n ?? null,
        non_null: finding.rate?.non_null ?? null,
        classification: classLabel,
        reason: finding.reason,
        public_source: finding.public_source,
        public_source_has_data: finding.public_source_has_data,
        public_source_evidence: finding.public_source_evidence,
        visibility: finding.visibility,
        fix: finding.fix,
      },
      verify: finding.verify
        || `node --test test/multi_flywheel_dimensions.test.mjs # not-published-rate:${finding.claim_id} classification!=red_flag`,
      demo_win: finding.demo_win
        || demoWinForClassification(classLabel, finding),
      context: [
        finding.surface,
        finding.render,
        finding.gap_id,
        "ontology/fixtures/dimensions/not_published_claim_samples.json",
        "site/data/gap_taxonomy.json",
      ].filter(Boolean),
      lesson_class: lessonClassFor(classLabel),
      needs_human: classLabel === "investigate" ? "source_verification" : null,
    }));
  }
  return cards;
}

function rankForFinding(finding) {
  const base = finding.red_flag ? 94 : 76;
  const visibilityBoost = finding.visibility === "high" ? 4 : finding.visibility === "low" ? -2 : 0;
  const rateBoost = typeof finding.rate?.rate === "number"
    ? Math.round(finding.rate.rate * 4)
    : 0;
  return Math.min(99, base + visibilityBoost + rateBoost);
}

function demoWinForClassification(classification, finding) {
  switch (classification) {
    case "mislabeled":
      return `Claim ${finding.claim_id} no longer says "the city does not publish" when the failure is ours (fetch/join/parse); readers see real data or honest not-yet-ingested copy.`;
    case "never_ingested":
      return `Claim ${finding.claim_id} is backed by an ingested public source with non-null examples, or is relabeled as not-yet-ingested.`;
    case "broken_join":
      return `Claim ${finding.claim_id} joins to real public rows; not-published rate drops below the red-flag threshold.`;
    case "investigate":
      return `Claim ${finding.claim_id} has a verified classification against the real public source (withhold vs join bug).`;
    default:
      return `Not-published rate for ${finding.claim_id} is honest and not a 100% credibility mask.`;
  }
}

function lessonClassFor(classification) {
  switch (classification) {
    case "mislabeled":
      return "false-not-published-mislabeled";
    case "never_ingested":
      return "false-not-published-never-ingested";
    case "broken_join":
      return "false-not-published-broken-join";
    case "investigate":
      return "not-published-rate-investigate";
    default:
      return "not-published-rate-red-flag";
  }
}
