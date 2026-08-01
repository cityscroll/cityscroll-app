// Population not-published-rate — core test for the data-integrity dimension.
//
// Method (credibility audit):
// 1. Enumerate every reader-facing "the city does not publish X" register.
// 2. Sample recent + historical product entries for that claim.
// 3. rate = not_published_count / sample_size.
// 4. ~100% not-published is a credibility red flag unless verified as a genuine
//    withhold against the real public source. Prefer broken-join / never-ingested
//    / mislabeled over a polite class-(b) mask.
//
// Pure: no network. Continuous flywheel runs feed sample inventories (fixture or
// live-measured side-cars).

export const NOT_PUBLISHED_RATE_SCHEMA = "cityscroll.not_published_claim_samples.v0";

/** Default thresholds for continuous credibility audit. */
export const NOT_PUBLISHED_THRESHOLDS = Object.freeze({
  /** ~100% — flag as red (broken join / never-ingested / mislabeled). */
  red_flag_rate: 0.95,
  /** High but not total — emit lower-rank investigation card. */
  suspicious_rate: 0.85,
  /** Below this sample size, rate is insufficient (do not green-light). */
  min_sample: 10,
  /** Require both recent and historical buckets when present. */
  require_spread: true,
});

export const CLAIM_CLASSIFICATIONS = Object.freeze([
  "broken_join",
  "never_ingested",
  "mislabeled",
  "genuinely_withheld",
  "investigate",
  "healthy",
  "insufficient_sample",
]);

/**
 * Combine recent + historical sample buckets into a population rate.
 * @param {object} sample
 * @returns {{ n, not_published, non_null, rate, recent_n, historical_n, spread_ok }}
 */
export function computeNotPublishedRate(sample = {}) {
  const recent = normalizeBucket(sample.recent);
  const historical = normalizeBucket(sample.historical);
  // Allow a single combined bucket for small fixtures
  const combined = normalizeBucket(sample.combined || sample.population);

  let n = recent.size + historical.size + combined.size;
  let notPublished = recent.not_published + historical.not_published + combined.not_published;
  let nonNull = numberOrZero(sample.non_null_examples);
  if (!nonNull) {
    nonNull = Math.max(0, n - notPublished);
  }

  // Explicit totals override buckets when provided
  if (Number.isFinite(Number(sample.n)) && Number(sample.n) > 0) {
    n = Number(sample.n);
    if (Number.isFinite(Number(sample.not_published))) {
      notPublished = Number(sample.not_published);
    }
    if (Number.isFinite(Number(sample.non_null_examples))) {
      nonNull = Number(sample.non_null_examples);
    }
  }

  const rate = n > 0 ? notPublished / n : null;
  const spreadOk = (recent.size > 0 && historical.size > 0)
    || (combined.size > 0 && sample.spread_ok === true)
    || sample.spread_ok === true;

  return {
    n,
    not_published: notPublished,
    non_null: nonNull,
    rate: rate == null ? null : Number(rate.toFixed(6)),
    recent_n: recent.size,
    historical_n: historical.size,
    combined_n: combined.size,
    spread_ok: spreadOk,
    rate_label: rate == null ? "n/a" : `${notPublished}/${n}`,
  };
}

function normalizeBucket(bucket) {
  if (!bucket || typeof bucket !== "object") {
    return { size: 0, not_published: 0 };
  }
  const size = Number(bucket.size ?? bucket.n ?? (Array.isArray(bucket.entry_ids) ? bucket.entry_ids.length : 0));
  const notPublished = Number(
    bucket.not_published
      ?? bucket.not_published_count
      ?? bucket.withheld
      ?? 0,
  );
  return {
    size: Number.isFinite(size) && size > 0 ? size : 0,
    not_published: Number.isFinite(notPublished) && notPublished > 0 ? notPublished : 0,
  };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Classify a computed rate against thresholds and source verification.
 * @param {object} rateResult — from computeNotPublishedRate
 * @param {object} claim — claim + sample metadata
 * @param {object} [thresholds]
 */
export function classifyNotPublishedClaim(rateResult, claim = {}, thresholds = NOT_PUBLISHED_THRESHOLDS) {
  const t = { ...NOT_PUBLISHED_THRESHOLDS, ...thresholds };
  const sample = claim.sample || {};
  const rate = rateResult?.rate;
  const n = rateResult?.n || 0;

  if (n < t.min_sample) {
    return {
      classification: "insufficient_sample",
      red_flag: false,
      suspicious: false,
      reason: `sample n=${n} < min_sample ${t.min_sample}`,
    };
  }

  if (rate == null) {
    return {
      classification: "investigate",
      red_flag: false,
      suspicious: false,
      reason: "rate unavailable",
    };
  }

  const publicHasData = sample.public_source_has_data === true
    || claim.public_source_has_data === true;
  const publicNoData = sample.public_source_has_data === false
    || claim.public_source_has_data === false;
  const hint = String(sample.classification_hint || claim.classification_hint || "").toLowerCase();

  // Healthy: non-null examples exist and rate is not extreme
  if (rateResult.non_null > 0 && rate < t.suspicious_rate) {
    return {
      classification: "healthy",
      red_flag: false,
      suspicious: false,
      reason: `non_null=${rateResult.non_null} rate=${rateResult.rate_label}`,
    };
  }

  if (rate >= t.red_flag_rate) {
    // Verified genuine withhold: city really does not publish (measured 0% joinable)
    if (publicNoData && (hint === "genuinely_withheld" || hint === "genuine_withhold")) {
      return {
        classification: "genuinely_withheld",
        red_flag: false,
        suspicious: false,
        reason: `rate=${rateResult.rate_label} verified withhold against public source`,
      };
    }
    // Public source has the data → credibility red flag
    if (publicHasData || hint === "broken_join" || hint === "never_ingested" || hint === "mislabeled") {
      const classification = pickRedFlagClass(hint, publicHasData);
      return {
        classification,
        red_flag: true,
        suspicious: true,
        reason: `rate=${rateResult.rate_label} (~100% not-published) with public source evidence`,
      };
    }
    // Unknown source verification — still red-flag for continuous audit
    return {
      classification: "investigate",
      red_flag: true,
      suspicious: true,
      reason: `rate=${rateResult.rate_label} (~100% not-published); verify against public source`,
    };
  }

  if (rate >= t.suspicious_rate) {
    return {
      classification: publicHasData ? pickRedFlagClass(hint, true) : "investigate",
      red_flag: publicHasData,
      suspicious: true,
      reason: `rate=${rateResult.rate_label} above suspicious threshold ${t.suspicious_rate}`,
    };
  }

  return {
    classification: "healthy",
    red_flag: false,
    suspicious: false,
    reason: `rate=${rateResult.rate_label} below thresholds`,
  };
}

function pickRedFlagClass(hint, publicHasData) {
  if (hint === "broken_join") return "broken_join";
  if (hint === "never_ingested") return "never_ingested";
  if (hint === "mislabeled") return "mislabeled";
  // Default when source has data but join never surfaces it
  return publicHasData ? "never_ingested" : "investigate";
}

/**
 * Enumerate class-(b) not_published registers from gap taxonomy (+ optional extras).
 */
export function enumerateNotPublishedClaims(gapTaxonomy = {}, extras = []) {
  const gaps = Array.isArray(gapTaxonomy.gaps) ? gapTaxonomy.gaps : [];
  const fromGaps = gaps
    .filter((g) => g.class === "not_published")
    .map((g) => ({
      id: g.id,
      field: g.id,
      surface: g.surface || null,
      i18n_keys: g.i18n_keys || (g.i18n_key ? [g.i18n_key] : []),
      gap_id: g.id,
      would_appear_in: g.would_appear_in || null,
      evidence_note: g.evidence || null,
      source: "gap_taxonomy",
    }));

  const byId = new Map(fromGaps.map((c) => [c.id, c]));
  for (const extra of extras) {
    const id = extra.id || extra.claim_id;
    if (!id) continue;
    const prior = byId.get(id) || {};
    byId.set(id, {
      ...prior,
      ...extra,
      id,
      i18n_keys: extra.i18n_keys || prior.i18n_keys || [],
      source: extra.source || prior.source || "claim_registry",
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Evaluate claim list + sample results into credibility findings.
 * @param {Array<object>} claims — each may embed `.sample`
 * @param {object} [opts]
 */
export function evaluateNotPublishedClaims(claims = [], opts = {}) {
  const thresholds = { ...NOT_PUBLISHED_THRESHOLDS, ...(opts.thresholds || {}) };
  const findings = [];

  for (const claim of claims) {
    const id = String(claim.id || claim.claim_id || "").trim();
    if (!id) continue;
    const sample = claim.sample || {};
    const rateResult = computeNotPublishedRate(sample);
    const classified = classifyNotPublishedClaim(rateResult, claim, thresholds);

    findings.push({
      claim_id: id,
      field: claim.field || id,
      surface: claim.surface || null,
      i18n_keys: claim.i18n_keys || [],
      render: claim.render || claim.surface || null,
      gap_id: claim.gap_id || null,
      would_appear_in: claim.would_appear_in || null,
      public_source: claim.public_source || sample.public_source || null,
      public_source_has_data: sample.public_source_has_data ?? claim.public_source_has_data ?? null,
      public_source_evidence: sample.public_source_evidence || claim.public_source_evidence || null,
      rate: rateResult,
      classification: classified.classification,
      red_flag: classified.red_flag,
      suspicious: classified.suspicious,
      reason: classified.reason,
      visibility: claim.visibility || "medium",
      fix: claim.fix || sample.fix || null,
      verify: claim.verify || sample.verify || null,
      demo_win: claim.demo_win || sample.demo_win || null,
    });
  }

  // Rank: red flags first, then by rate desc, then visibility
  const visibilityWeight = { high: 3, medium: 2, low: 1 };
  findings.sort((a, b) => {
    if (a.red_flag !== b.red_flag) return a.red_flag ? -1 : 1;
    if (a.suspicious !== b.suspicious) return a.suspicious ? -1 : 1;
    const ar = a.rate?.rate ?? -1;
    const br = b.rate?.rate ?? -1;
    if (ar !== br) return br - ar;
    return (visibilityWeight[b.visibility] || 0) - (visibilityWeight[a.visibility] || 0)
      || a.claim_id.localeCompare(b.claim_id);
  });

  const metrics = {
    claims_checked: findings.length,
    red_flags: findings.filter((f) => f.red_flag).length,
    suspicious: findings.filter((f) => f.suspicious && !f.red_flag).length,
    genuinely_withheld: findings.filter((f) => f.classification === "genuinely_withheld").length,
    healthy: findings.filter((f) => f.classification === "healthy").length,
    insufficient_sample: findings.filter((f) => f.classification === "insufficient_sample").length,
    mean_not_published_rate: meanRate(findings),
  };

  return { findings, metrics, thresholds };
}

function meanRate(findings) {
  const rates = findings.map((f) => f.rate?.rate).filter((r) => typeof r === "number");
  if (!rates.length) return null;
  return Number((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(6));
}

/**
 * Merge sample inventory rows onto enumerated claims by id.
 */
export function attachSamplesToClaims(claims, sampleInventory = {}) {
  const rows = Array.isArray(sampleInventory.claims)
    ? sampleInventory.claims
    : Array.isArray(sampleInventory)
      ? sampleInventory
      : [];
  const byId = new Map(rows.map((r) => [r.id || r.claim_id, r]));
  return claims.map((claim) => {
    const row = byId.get(claim.id);
    if (!row) return claim;
    return {
      ...claim,
      ...row,
      id: claim.id,
      sample: row.sample || claim.sample,
      i18n_keys: row.i18n_keys || claim.i18n_keys,
    };
  });
}
