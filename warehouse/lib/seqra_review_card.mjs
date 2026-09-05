/**
 * SEQRA-09: the internal review card renderer.
 *
 * One project review, rendered for a reviewer inside the project -- never for
 * a resident. The card exists because a predicted state that cannot be read
 * against the recorded state is not reviewable, and because a page that mixes
 * "this happened" with "we think this will happen" in the same typeface is
 * worse than no page at all.
 *
 * Three fact classes, three visibly different treatments, always:
 *
 *   observed-fact  a record says so. Solid rule, plain weight, no hedge.
 *   estimate       a model says so. Dashed rule, tinted panel, an explicit
 *                  "Estimate" tag, and the measured out-of-time calibration
 *                  printed immediately beside the number -- not in a footnote,
 *                  not on another page.
 *   missing-data   nobody says so. Hatched rule, muted, and phrased as an
 *                  absence in the record rather than as a fact about the world.
 *
 * The three are never given the same style and an estimate is never rendered
 * in the observed class; `renderReviewCard` returns the fact list it rendered
 * so that this is testable rather than merely intended (A2).
 *
 * This module writes no route, imports nothing from `site/`, and refuses --
 * via SEQRA-09's `assertNoForbiddenEstimate` -- to render any field that
 * reads as a resident-facing prediction of legal exposure (A5).
 */
import { assertNoForbiddenEstimate, TECHNICAL_ISSUE_ORDINAL_LEVELS } from "./seqra_baselines.mjs";

export const SEQRA_REVIEW_CARD_SCHEMA = "cityscroll.seqra_review_card.v1";

/** The three fact classes. Distinct CSS class, distinct visible label, distinct treatment. */
export const REVIEW_CARD_FACT_CLASSES = Object.freeze({
  OBSERVED: "observed-fact",
  ESTIMATE: "estimate",
  MISSING: "missing-data",
});

export const REVIEW_CARD_FACT_LABELS = Object.freeze({
  [REVIEW_CARD_FACT_CLASSES.OBSERVED]: "Observed",
  [REVIEW_CARD_FACT_CLASSES.ESTIMATE]: "Estimate",
  [REVIEW_CARD_FACT_CLASSES.MISSING]: "Not in the record",
});

export class SeqraReviewCardError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraReviewCardError";
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanize(value) {
  return String(value).replace(/_/g, " ");
}

function formatPercent(value) {
  if (value === null || value === undefined) return null;
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits = 3) {
  if (value === null || value === undefined) return null;
  return Number(value).toFixed(digits);
}

/**
 * The calibration line printed beside every estimate. It names the metric, the
 * naive comparator it was measured against, the calibration error, and the
 * denominator -- an estimate whose accompanying numbers do not say how many
 * rows they were measured on is not accompanied by evidence.
 */
export function formatCalibration(calibration) {
  if (!calibration) return null;
  const parts = [];
  if (calibration.primary_metric) {
    const comparison = calibration.comparison ?? {};
    const verdict = comparison.beats_comparator === null || comparison.beats_comparator === undefined
      ? "not comparable on this holdout"
      : comparison.beats_comparator
        ? "better than the naive comparator"
        : "NOT better than the naive comparator";
    parts.push(`${humanize(calibration.primary_metric)} ${formatNumber(comparison.baseline)} against ${formatNumber(comparison.comparator)} for ${humanize(calibration.comparator_name ?? "the naive comparator")} - ${verdict}`);
  }
  if (calibration.expected_calibration_error !== null && calibration.expected_calibration_error !== undefined) {
    parts.push(`expected calibration error ${formatNumber(calibration.expected_calibration_error)}`);
  }
  if (calibration.brier_score !== null && calibration.brier_score !== undefined) {
    parts.push(`Brier ${formatNumber(calibration.brier_score)}`);
  }
  if (calibration.interquartile_interval_coverage !== null && calibration.interquartile_interval_coverage !== undefined) {
    parts.push(`observed inside the quoted range ${formatPercent(calibration.interquartile_interval_coverage)} of the time`);
  }
  parts.push(`measured out of time on ${calibration.scored_rows ?? 0} held-out row(s) across ${calibration.fold_count ?? 0} rolling-origin fold(s)`);
  if (calibration.censored_rows) parts.push(`${calibration.censored_rows} censored row(s) excluded from scoring`);
  return parts.join("; ");
}

/**
 * One fact. `factClass` decides the markup class, the visible tag and the
 * treatment; nothing else in this module may set a class attribute on a fact.
 */
function fact({ id, factClass, label, value, detail = null, calibration = null }) {
  if (!Object.values(REVIEW_CARD_FACT_CLASSES).includes(factClass)) {
    throw new SeqraReviewCardError(`unknown fact class ${JSON.stringify(factClass)}`);
  }
  if (factClass === REVIEW_CARD_FACT_CLASSES.ESTIMATE && !calibration) {
    throw new SeqraReviewCardError(`estimate ${JSON.stringify(id)} carries no calibration; every estimate on this card must show how it was measured`);
  }
  if (factClass !== REVIEW_CARD_FACT_CLASSES.ESTIMATE && calibration) {
    throw new SeqraReviewCardError(`fact ${JSON.stringify(id)} is not an estimate but carries calibration`);
  }
  return { id, fact_class: factClass, label, value, detail, calibration };
}

function renderFact(entry) {
  const calibrationLine = entry.calibration ? formatCalibration(entry.calibration) : null;
  return [
    `      <div class="fact ${entry.fact_class}" data-fact-class="${escapeHtml(entry.fact_class)}" data-fact-id="${escapeHtml(entry.id)}">`,
    `        <span class="fact-tag">${escapeHtml(REVIEW_CARD_FACT_LABELS[entry.fact_class])}</span>`,
    `        <span class="fact-label">${escapeHtml(entry.label)}</span>`,
    `        <span class="fact-value">${escapeHtml(entry.value)}</span>`,
    entry.detail ? `        <span class="fact-detail">${escapeHtml(entry.detail)}</span>` : null,
    calibrationLine ? `        <span class="fact-calibration">Measured calibration: ${escapeHtml(calibrationLine)}</span>` : null,
    "      </div>",
  ].filter((line) => line !== null).join("\n");
}

function renderSection(title, note, facts) {
  return [
    `    <section class="card-section">`,
    `      <h2>${escapeHtml(title)}</h2>`,
    note ? `      <p class="section-note">${escapeHtml(note)}</p>` : null,
    ...facts.map(renderFact),
    "    </section>",
  ].filter((line) => line !== null).join("\n");
}

const STYLE = `
    :root { color-scheme: light; }
    body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c1c1c; background: #f4f4f2; }
    main { max-width: 54rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
    .internal-banner { background: #3a2f00; color: #fff6d8; padding: 0.65rem 1rem; border-radius: 6px; font-weight: 600; }
    .internal-banner span { display: block; font-weight: 400; font-size: 0.85rem; opacity: 0.9; }
    h1 { font-size: 1.35rem; margin: 1.25rem 0 0.25rem; }
    .subject { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; color: #555; word-break: break-all; }
    .card-section { margin-top: 1.75rem; }
    .card-section h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.06em; color: #444; border-bottom: 1px solid #d5d5d0; padding-bottom: 0.3rem; }
    .section-note { font-size: 0.85rem; color: #555; margin: 0.4rem 0 0.8rem; }
    .fact { display: grid; grid-template-columns: 7.5rem 1fr; gap: 0.15rem 0.75rem; padding: 0.6rem 0.75rem; margin: 0.5rem 0; border-radius: 5px; }
    .fact-tag { grid-row: span 4; align-self: start; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; padding: 0.15rem 0.4rem; border-radius: 3px; text-align: center; }
    .fact-label { font-weight: 600; }
    .fact-value { }
    .fact-detail { font-size: 0.85rem; color: #444; }
    .fact-calibration { font-size: 0.8rem; }

    /* Observed: a record says so. Solid rule, plain background. */
    .fact.observed-fact { background: #ffffff; border-left: 5px solid #1f5c3a; }
    .fact.observed-fact .fact-tag { background: #1f5c3a; color: #ffffff; }
    .fact.observed-fact .fact-value { font-weight: 500; }

    /* Estimate: a model says so. Dashed rule, tinted panel, calibration attached. */
    .fact.estimate { background: #f0f4ff; border-left: 5px dashed #27408b; box-shadow: inset 0 0 0 1px #cfd9f4; }
    .fact.estimate .fact-tag { background: #27408b; color: #ffffff; }
    .fact.estimate .fact-value { font-style: italic; }
    .fact.estimate .fact-calibration { display: block; margin-top: 0.35rem; padding: 0.35rem 0.5rem; background: #dfe7fb; border-radius: 3px; color: #1b2c5c; }

    /* Missing: nobody says so. Hatched rule, muted, phrased as an absence. */
    .fact.missing-data { background: repeating-linear-gradient(135deg, #f7f7f4, #f7f7f4 6px, #efefe9 6px, #efefe9 12px); border-left: 5px dotted #8a7a3a; color: #4a4a44; }
    .fact.missing-data .fact-tag { background: #efe4bd; color: #4a3d10; border: 1px dashed #8a7a3a; }
    .fact.missing-data .fact-value { font-style: italic; color: #5a5a52; }

    .legend { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1rem; font-size: 0.85rem; }
    .legend div { padding: 0.35rem 0.6rem; border-radius: 4px; }
    footer { margin-top: 2.5rem; font-size: 0.8rem; color: #555; border-top: 1px solid #d5d5d0; padding-top: 0.75rem; }
`;

/**
 * Render one internal review card.
 *
 * `calibrationFor(targetName)` must return the measured out-of-time report for
 * that target at the tier the estimates were produced at. There is no default:
 * an estimate with no measured calibration is refused above, because a card
 * that could quietly omit it would eventually omit it.
 */
export function renderReviewCard({
  row,
  estimates,
  calibrationFor,
  sourceFreshness,
  sourceTier,
  foldId,
  observationHorizon,
  corpusReceiptPath,
} = {}) {
  if (!row) throw new SeqraReviewCardError("renderReviewCard requires a corpus row");
  if (typeof calibrationFor !== "function") throw new SeqraReviewCardError("renderReviewCard requires calibrationFor(targetName)");

  const state = row.snapshot.review_state;
  const facts = [];
  const sections = [];

  // -- Observed review state ------------------------------------------------
  const observedFacts = [];
  observedFacts.push(fact({
    id: "review_key",
    factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
    label: "Review",
    value: row.review_key,
    detail: `state reconstructed as of ${row.cutoff}`,
  }));
  observedFacts.push(state.current_stage
    ? fact({
      id: "current_stage",
      factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
      label: "Latest recorded milestone",
      value: humanize(state.current_stage),
      detail: `${state.milestones.length} public review event(s) on the record by the cutoff`,
    })
    : fact({
      id: "current_stage",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Latest recorded milestone",
      value: "no public review event is on the record as of the cutoff",
    }));
  const determinations = Object.values(state.determinations);
  observedFacts.push(determinations.length > 0
    ? fact({
      id: "determination",
      factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
      label: "Final determination",
      value: `${humanize(determinations[0].outcome)} on ${determinations[0].date}`,
      detail: determinations[0].determination_key,
    })
    : fact({
      id: "determination",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Final determination",
      value: "no determination is recorded as of the cutoff",
    }));
  const documents = Object.values(state.documents);
  observedFacts.push(documents.length > 0
    ? fact({
      id: "documents",
      factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
      label: "Published documents",
      value: documents.map((document) => `${humanize(document.document_type)} (${humanize(document.document_stage)}, ${document.effective_at.slice(0, 10)})`).join("; "),
    })
    : fact({
      id: "documents",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Published documents",
      value: "no environmental review document has been published as of the cutoff",
    }));
  sections.push(["Observed review state", "Everything in this section is a record, read as of the cutoff. Nothing here is predicted.", observedFacts]);

  // -- Likely next milestone, and the timing range --------------------------
  const nextMilestoneEstimate = estimates.next_milestone_type;
  const durationEstimate = estimates.next_milestone_duration;
  const nextFacts = [];
  nextFacts.push(nextMilestoneEstimate
    ? fact({
      id: "next_milestone_type",
      factClass: REVIEW_CARD_FACT_CLASSES.ESTIMATE,
      label: "Likely next milestone",
      value: `${humanize(nextMilestoneEstimate.top.class_name)} (${formatPercent(nextMilestoneEstimate.top.probability)})`,
      detail: nextMilestoneEstimate.ranked.slice(1, 4).map((entry) => `${humanize(entry.class_name)} ${formatPercent(entry.probability)}`).join("; "),
      calibration: calibrationFor("next_milestone_type"),
    })
    : fact({
      id: "next_milestone_type",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Likely next milestone",
      value: "no next-milestone estimate was produced for this review",
    }));
  nextFacts.push(durationEstimate
    ? fact({
      id: "next_milestone_timing",
      factClass: REVIEW_CARD_FACT_CLASSES.ESTIMATE,
      label: "Estimated timing range",
      value: `${Math.round(durationEstimate.p25_days)} to ${Math.round(durationEstimate.p75_days)} days from the cutoff (median ${Math.round(durationEstimate.p50_days)})`,
      detail: `the median-time heuristic for this fold says ${Math.round(durationEstimate.comparator_median_days)} days for every review`,
      calibration: calibrationFor("next_milestone_duration"),
    })
    : fact({
      id: "next_milestone_timing",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Estimated timing range",
      value: "no timing estimate was produced for this review",
    }));
  const reviewPathEstimate = estimates.review_path;
  nextFacts.push(reviewPathEstimate
    ? fact({
      id: "review_path",
      factClass: REVIEW_CARD_FACT_CLASSES.ESTIMATE,
      label: "Likely review path",
      value: `${humanize(reviewPathEstimate.top.class_name)} (${formatPercent(reviewPathEstimate.top.probability)})`,
      detail: reviewPathEstimate.ranked.slice(1).map((entry) => `${humanize(entry.class_name)} ${formatPercent(entry.probability)}`).join("; "),
      calibration: calibrationFor("review_path"),
    })
    : fact({
      id: "review_path",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Likely review path",
      value: "no review-path estimate was produced for this review",
    }));
  sections.push(["Likely next milestone and timing", "Each estimate carries the out-of-time measurement it earned, against the naive comparator it has to beat.", nextFacts]);

  // -- Unresolved technical topics -----------------------------------------
  const topicFacts = [];
  const ordinal = estimates.technical_issue_state;
  if (!ordinal || ordinal.per_topic.length === 0) {
    topicFacts.push(fact({
      id: "technical_topics",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Technical topics",
      value: "no technical topic assessment is on the record as of the cutoff, so no topic can be reported as screened out",
    }));
  } else {
    for (const topic of ordinal.per_topic) {
      topicFacts.push(fact({
        id: `topic_observed:${topic.technical_topic}`,
        factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
        label: humanize(topic.technical_topic),
        value: `recorded state at the cutoff: ${humanize(topic.state_at_cutoff ?? "not recorded")}`,
      }));
      topicFacts.push(fact({
        id: `topic_estimate:${topic.technical_topic}`,
        factClass: REVIEW_CARD_FACT_CLASSES.ESTIMATE,
        label: `${humanize(topic.technical_topic)} - where it is likely to end`,
        value: `${humanize(topic.top.level_name)} (${formatPercent(topic.top.probability)})`,
        detail: `ordinal ladder: ${TECHNICAL_ISSUE_ORDINAL_LEVELS.map(humanize).join(" < ")}`,
        calibration: calibrationFor("technical_issue_state"),
      }));
    }
  }
  sections.push(["Unresolved technical topics", "The recorded assessment state and the estimated end state are shown as separate facts, never merged into one.", topicFacts]);

  // -- Mitigation and monitoring -------------------------------------------
  const mitigationFacts = [];
  mitigationFacts.push(state.mitigations.length > 0
    ? fact({
      id: "mitigations",
      factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
      label: "Mitigation commitments",
      value: state.mitigations.map((mitigation) => `${mitigation.description} (${humanize(mitigation.status)})`).join("; "),
    })
    : fact({
      id: "mitigations",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Mitigation commitments",
      value: "no mitigation commitment is recorded as of the cutoff",
    }));
  mitigationFacts.push(state.alternatives.length > 0
    ? fact({
      id: "alternatives",
      factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
      label: "Alternatives considered",
      value: state.alternatives.map((alternative) => `${alternative.name} (${humanize(alternative.status)})`).join("; "),
    })
    : fact({
      id: "alternatives",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Alternatives considered",
      value: "no alternative is recorded as considered as of the cutoff",
    }));
  sections.push(["Mitigation and monitoring", "Commitments are records. This card does not estimate whether a commitment will be honoured.", mitigationFacts]);

  // -- Supplementation indicators ------------------------------------------
  const supplementFacts = [];
  for (const [name, estimate] of Object.entries(estimates).sort()) {
    if (!name.startsWith("supplemental_review:")) continue;
    const horizon = name.slice("supplemental_review:".length);
    const positive = estimate.ranked.find((entry) => entry.class_name === "supplemental_review");
    supplementFacts.push(fact({
      id: `supplementation:${horizon}`,
      factClass: REVIEW_CARD_FACT_CLASSES.ESTIMATE,
      label: `Supplemental review ${humanize(horizon)}`,
      value: `${formatPercent(positive.probability)} likely`,
      detail: "a technical memorandum or a supplemental environmental impact statement, within this horizon",
      calibration: calibrationFor(name),
    }));
  }
  if (supplementFacts.length === 0) {
    supplementFacts.push(fact({
      id: "supplementation",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Supplementation indicators",
      value: "no supplemental-review estimate was produced for this review",
    }));
  }
  sections.push(["Supplementation indicators", "Every horizon is reported separately. A review can be a fully observed negative at one horizon and censored at another.", supplementFacts]);

  // -- Institutional participation -----------------------------------------
  const institutionFacts = [];
  if (state.positions.length === 0) {
    institutionFacts.push(fact({
      id: "institutional_participation",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Recorded positions",
      value: "no institutional position is on the record as of the cutoff, which is not the same as no institution holding one",
    }));
  } else {
    const byOrganization = new Map();
    for (const position of state.positions) {
      const bucket = byOrganization.get(position.organization_key) ?? [];
      bucket.push(position);
      byOrganization.set(position.organization_key, bucket);
    }
    for (const [organizationKey, positions] of [...byOrganization.entries()].sort()) {
      institutionFacts.push(fact({
        id: `institutional_participation:${organizationKey}`,
        factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
        label: organizationKey,
        value: positions.map((position) => `${humanize(position.position)}${position.named_issue ? ` on ${humanize(position.named_issue)}` : ""} (${position.effective_at.slice(0, 10)})`).join("; "),
      }));
    }
  }
  sections.push(["Institutional participation", "Positions are records of what an organization said, on the date it said it.", institutionFacts]);

  // -- Source freshness and missing data ------------------------------------
  const freshnessFacts = [];
  freshnessFacts.push(sourceFreshness.latest_public_event_at
    ? fact({
      id: "source_freshness",
      factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
      label: "Most recent public event",
      value: `${sourceFreshness.latest_public_event_at} (${sourceFreshness.days_since_latest_public_event} day(s) before the cutoff)`,
    })
    : fact({
      id: "source_freshness",
      factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
      label: "Most recent public event",
      value: "nothing public is recorded for this review",
    }));
  if (sourceFreshness.warnings.length === 0) {
    freshnessFacts.push(fact({
      id: "missing_data_warnings",
      factClass: REVIEW_CARD_FACT_CLASSES.OBSERVED,
      label: "Missing-data warnings",
      value: "none: every section above is backed by at least one record",
    }));
  } else {
    for (const [index, warning] of sourceFreshness.warnings.entries()) {
      freshnessFacts.push(fact({
        id: `missing_data_warning:${index}`,
        factClass: REVIEW_CARD_FACT_CLASSES.MISSING,
        label: "Missing-data warning",
        value: warning,
      }));
    }
  }
  sections.push(["Source freshness and missing data", "What the record does not say, said plainly, rather than left to be inferred from a blank.", freshnessFacts]);

  for (const [, , sectionFacts] of sections) facts.push(...sectionFacts);

  assertNoForbiddenEstimate(
    facts.filter((entry) => entry.fact_class === REVIEW_CARD_FACT_CLASSES.ESTIMATE).flatMap((entry) => [entry.id, entry.label, entry.value]),
    "renderReviewCard",
  );

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <meta name="robots" content="noindex, nofollow">',
    `    <title>Internal review card - ${escapeHtml(row.review_key)}</title>`,
    `    <style>${STYLE}    </style>`,
    "  </head>",
    '  <body data-audience="internal" data-schema="' + escapeHtml(SEQRA_REVIEW_CARD_SCHEMA) + '">',
    "    <main>",
    '      <div class="internal-banner">Internal review card - not a resident-facing page',
    "        <span>Built from the warehouse backtest corpus for review inside the project. It is not served by the site, has no route, and states no legal conclusion.</span>",
    "      </div>",
    `      <h1>Environmental review, as of ${escapeHtml(row.cutoff)}</h1>`,
    `      <p class="subject">${escapeHtml(row.review_key)}</p>`,
    '      <div class="legend">',
    `        <div class="fact observed-fact"><span class="fact-tag">${escapeHtml(REVIEW_CARD_FACT_LABELS[REVIEW_CARD_FACT_CLASSES.OBSERVED])}</span><span class="fact-label">a record says so</span></div>`,
    `        <div class="fact estimate"><span class="fact-tag">${escapeHtml(REVIEW_CARD_FACT_LABELS[REVIEW_CARD_FACT_CLASSES.ESTIMATE])}</span><span class="fact-label">a fitted baseline says so, with its measured calibration</span></div>`,
    `        <div class="fact missing-data"><span class="fact-tag">${escapeHtml(REVIEW_CARD_FACT_LABELS[REVIEW_CARD_FACT_CLASSES.MISSING])}</span><span class="fact-label">nobody says so; the record is silent</span></div>`,
    "      </div>",
    ...sections.map(([title, note, sectionFacts]) => renderSection(title, note, sectionFacts)),
    "      <footer>",
    `        <p>Estimates come from the ${escapeHtml(humanize(sourceTier))} source tier, fitted on ${escapeHtml(foldId)}'s training rows only; this review is in that fold's held-out test split. Observation horizon ${escapeHtml(observationHorizon)}.</p>`,
    `        <p>Measurements: <code>${escapeHtml(corpusReceiptPath)}</code>. Targets are reported separately and are never combined into a single project score.</p>`,
    "      </footer>",
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");

  return { schema: SEQRA_REVIEW_CARD_SCHEMA, review_key: row.review_key, html, facts };
}

/** The fact-class audit A2 asserts: three classes present, and no estimate wearing the observed class. */
export function auditFactClasses(facts) {
  const classes = new Set(facts.map((entry) => entry.fact_class));
  const misclassified = facts.filter((entry) => entry.calibration && entry.fact_class !== REVIEW_CARD_FACT_CLASSES.ESTIMATE);
  const uncalibratedEstimates = facts.filter((entry) => entry.fact_class === REVIEW_CARD_FACT_CLASSES.ESTIMATE && !entry.calibration);
  return {
    ok: classes.size === 3 && misclassified.length === 0 && uncalibratedEstimates.length === 0,
    fact_classes_present: [...classes].sort(),
    fact_class_counts: Object.fromEntries(
      Object.values(REVIEW_CARD_FACT_CLASSES).map((factClass) => [factClass, facts.filter((entry) => entry.fact_class === factClass).length]),
    ),
    misclassified_estimate_count: misclassified.length,
    uncalibrated_estimate_count: uncalibratedEstimates.length,
  };
}
