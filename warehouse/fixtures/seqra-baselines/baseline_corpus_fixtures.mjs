/**
 * SEQRA-09 fixtures: a synthetic labelled corpus large enough to fit and
 * score the card's baselines out-of-time.
 *
 * SEQRA-08's own fixture (warehouse/fixtures/seqra-labels/) is six reviews
 * chosen to exercise one behaviour each -- exactly right for proving the
 * corpus builder's invariants, and far too small to say anything about
 * whether a fitted baseline beats a prevalence heuristic. This module
 * generates a larger corpus with the same shape, through the same builders:
 * every review here is an ordinary SEQRA-02 review event log, so SEQRA-08's
 * `buildAsOfFeatureSnapshot`, `classifyReviewPathLabel` and
 * `classifySupplementalReviewLabel` consume it unchanged.
 *
 * Synthetic identity fixtures, not claims about real reviews, projects or
 * organizations. The generator is a fixed-seed linear congruential sequence
 * over integer arithmetic, so the corpus is byte-identical on every run and
 * every platform; nothing here reads the clock or the network.
 *
 * The generating process is deliberately one where the three source tiers
 * carry different amounts of signal (structured < documents < institutional
 * participation). That is what makes the ablation in
 * `tools/build_seqra_baselines.mjs` a real measurement rather than a
 * formality: a tier that adds nothing must be able to show that it adds
 * nothing, and a fixture where every tier were equally informative could
 * never demonstrate the difference.
 */
import { buildActionKey, buildDeterminationKey, buildEnvironmentalReviewKey } from "../../lib/seqra_stable_keys.mjs";
import { buildReviewEventKey } from "../../lib/seqra_review_event_log.mjs";

/** The corpus's data-completeness horizon: nothing after this date is knowable. */
export const OBSERVATION_HORIZON = "2026-01-01T00:00:00.000Z";

export const REVIEW_COUNT = 220;

const DAY_MS = 24 * 60 * 60 * 1000;
const CORPUS_START_MS = Date.parse("2018-06-01T00:00:00.000Z");

/**
 * A 32-bit linear congruential generator (Numerical Recipes constants) over
 * integer arithmetic only. Chosen over Math.random for the obvious reason and
 * over a float-mixing hash for a less obvious one: every operation here is
 * exact in a 32-bit integer, so the corpus cannot drift with a platform's
 * floating-point library.
 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return {
    /** Uniform in [0, 1) with 32 bits of resolution. */
    next() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    },
    /** Uniform integer in [0, bound). */
    int(bound) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    },
  };
}

function isoAt(baseMs, dayOffset) {
  return new Date(baseMs + dayOffset * DAY_MS).toISOString();
}

function event({ reviewKey, eventType, effectiveAt, sourceId, sourceRecordId, payload = {} }) {
  const base = { reviewKey, eventType, effectiveAt, sourceId, sourceRecordId, payload };
  return Object.freeze({
    event_key: buildReviewEventKey(base),
    review_key: reviewKey,
    event_type: eventType,
    effective_at: effectiveAt,
    supersedes_event_key: null,
    payload,
    observed_at: effectiveAt,
    // These synthetic sources publish on the day the event takes effect, so
    // available_to_public_at === effective_at throughout. SEQRA-08's leakage
    // audit still re-checks every included record against the cutoff rather
    // than trusting that equality.
    available_to_public_at: effectiveAt,
    source_id: sourceId,
    source_record_id: sourceRecordId,
    source_vintage: effectiveAt.slice(0, 10),
    evidence: null,
    confidence: 0.9,
    rival_explanation: null,
    suppression_rule: null,
  });
}

/**
 * Topics screened at EAS time. A generated review screens a prefix of this
 * list, so a larger action screens more topics -- the "how much of the
 * technical manual did this action trigger" signal a document tier carries
 * and a structured record does not.
 */
const SCREENED_TOPICS = Object.freeze([
  "transportation",
  "air_quality",
  "noise",
  "shadows",
  "historic_cultural_resources",
  "hazardous_materials",
  "socioeconomic_conditions",
  "open_space",
  "urban_design_visual_resources",
  "neighborhood_character",
  "construction",
  "water_sewer_infrastructure",
]);

const ORGANIZATIONS = Object.freeze([
  "organization:community_board:sample-cb-1",
  "organization:community_board:sample-cb-2",
  "organization:elected_official:sample-council-member",
  "organization:civic_group:sample-preservation-alliance",
  "organization:agency:sample-transportation-agency",
  "organization:civic_group:sample-tenants-association",
]);

const POSITIONS = Object.freeze(["support", "conditional", "oppose"]);

/**
 * One synthetic review. `scale` and `contention` are the latent variables the
 * generator uses; neither is ever exposed as a feature. What a model sees is
 * only what the event log made public before its cutoff.
 */
function generateReview(index, random) {
  const scale = random.next();
  const contention = random.next();
  const regime = index % 3 === 0 ? "SEQRA" : "CEQR";
  const reviewKey = regime === "SEQRA"
    ? buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: "NYS DEC", sourceReviewId: `baseline-${String(index).padStart(4, "0")}` })
    : buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: `${20 + (index % 6)}DCP${String(1000 + index)}X` });

  const startMs = CORPUS_START_MS + random.int(2650) * DAY_MS;
  const events = [];
  const source = regime === "SEQRA" ? "nys_dec_dart" : "ceqr_access";
  const record = `baseline-${String(index).padStart(4, "0")}`;

  events.push(event({
    reviewKey, eventType: "eas_or_eaf_accepted", effectiveAt: isoAt(startMs, 0),
    sourceId: source, sourceRecordId: `${record}-eaf`,
  }));
  const leadAgencyDay = 10 + random.int(40);
  events.push(event({
    reviewKey, eventType: "lead_agency_established", effectiveAt: isoAt(startMs, leadAgencyDay),
    sourceId: source, sourceRecordId: `${record}-lead-agency`,
  }));

  // Document tier, available before the classification decision: the EAS
  // screening pass. A bigger action screens more topics and carries more of
  // them into detailed analysis.
  const screenedCount = 2 + Math.floor(scale * 9);
  const detailedCount = Math.round(scale * screenedCount * 0.8);
  const screeningDay = leadAgencyDay + 5;
  for (let t = 0; t < screenedCount; t++) {
    events.push(event({
      reviewKey, eventType: "topic_assessed", effectiveAt: isoAt(startMs, screeningDay),
      sourceId: source, sourceRecordId: `${record}-screen-${t}`,
      payload: { technical_topic: SCREENED_TOPICS[t], state: t < detailedCount ? "detailed_analysis" : "screened_out", document_key: null },
    }));
  }

  // Institutional tier, available before the classification decision: early
  // scoping and comment positions.
  const earlyPositionCount = Math.floor(contention * 5);
  for (let p = 0; p < earlyPositionCount; p++) {
    const opposes = random.next() < contention;
    events.push(event({
      reviewKey, eventType: "position_taken", effectiveAt: isoAt(startMs, leadAgencyDay + 8 + p * 3),
      sourceId: "community_board_positions", sourceRecordId: `${record}-early-position-${p}`,
      payload: {
        organization_key: ORGANIZATIONS[(index + p) % ORGANIZATIONS.length],
        position: opposes ? "oppose" : POSITIONS[(index + p) % 2],
        named_issue: SCREENED_TOPICS[p % SCREENED_TOPICS.length],
      },
    }));
  }

  // The cutoff sits strictly before the classification decision: every
  // feature above is public by then, and the review path is still open.
  const cutoffDay = leadAgencyDay + 30 + random.int(20);
  const cutoff = isoAt(startMs, cutoffDay);

  // The generating process for the review path. Structured signal (scale)
  // separates type II from everything else; the document tier (how many
  // topics went to detailed analysis) and the institutional tier (early
  // opposition) are what separate a negative declaration from a conditioned
  // one and from a positive declaration.
  const escalation = 0.9 * scale + 0.7 * (detailedCount / SCREENED_TOPICS.length) + 0.8 * contention + 0.25 * random.next();
  let classification;
  if (escalation < 0.66) classification = "type_ii_classified";
  else if (escalation < 1.12) classification = "negative_declaration_issued";
  else if (escalation < 1.55) classification = "conditioned_negative_declaration_issued";
  else classification = "positive_declaration_issued";

  // A minority of reviews go administratively quiet and never reach a
  // classifying milestone at all. That is target A's fifth category
  // ("unknown_or_incomplete") occurring for its real reason, rather than an
  // artefact of the corpus running out of calendar at one end.
  const dormant = 0.3 * (1 - contention) + 0.7 * random.next() > 0.78;
  // Bigger, more contested actions take longer to classify. Without that the
  // duration target would carry no signal at all and its baseline could only
  // ever tie the median-time heuristic by construction.
  const classificationDay = cutoffDay + 20 + Math.round(70 * scale + 50 * contention) + random.int(50);
  const classificationAt = isoAt(startMs, classificationDay);
  const classificationReachesHorizon = !dormant && startMs + classificationDay * DAY_MS <= Date.parse(OBSERVATION_HORIZON);
  if (classificationReachesHorizon) {
    events.push(event({
      reviewKey, eventType: classification, effectiveAt: classificationAt,
      sourceId: source, sourceRecordId: `${record}-classification`,
    }));
  }

  let determinationDate = null;
  let implementationCompletionDate = null;

  if (classificationReachesHorizon && classification !== "type_ii_classified") {
    const eisPath = classification === "positive_declaration_issued";
    let day = classificationDay;

    if (eisPath) {
      day += 40 + random.int(60);
      const draftKey = `review_document:${reviewKey}:deis:${isoAt(startMs, day).slice(0, 10)}:${String(index).padStart(12, "0")}`;
      const draftAt = isoAt(startMs, day);
      const draftReaches = startMs + day * DAY_MS <= Date.parse(OBSERVATION_HORIZON);
      if (draftReaches) {
        events.push(event({
          reviewKey, eventType: "draft_document_published", effectiveAt: draftAt,
          sourceId: source, sourceRecordId: `${record}-deis`,
          payload: { document_key: draftKey, document_type: "deis", content_hash: `${String(index).padStart(4, "0")}`.repeat(16) },
        }));
        day += 30 + random.int(40);
        const hearingReaches = startMs + day * DAY_MS <= Date.parse(OBSERVATION_HORIZON);
        if (hearingReaches) {
          events.push(event({
            reviewKey, eventType: "public_hearing_held", effectiveAt: isoAt(startMs, day),
            sourceId: source, sourceRecordId: `${record}-hearing`,
          }));
          // Late institutional participation, well after the cutoff: it is
          // part of the outcome story, never part of a feature snapshot.
          const lateCount = Math.floor(contention * 4);
          for (let p = 0; p < lateCount; p++) {
            events.push(event({
              reviewKey, eventType: "position_taken", effectiveAt: isoAt(startMs, day + 1 + p),
              sourceId: "community_board_positions", sourceRecordId: `${record}-late-position-${p}`,
              payload: {
                organization_key: ORGANIZATIONS[(index + p + 3) % ORGANIZATIONS.length],
                position: "oppose",
                named_issue: SCREENED_TOPICS[(p + 2) % SCREENED_TOPICS.length],
              },
            }));
          }
          day += 60 + random.int(60);
          const finalReaches = startMs + day * DAY_MS <= Date.parse(OBSERVATION_HORIZON);
          if (finalReaches) {
            events.push(event({
              reviewKey, eventType: "final_document_published", effectiveAt: isoAt(startMs, day),
              sourceId: source, sourceRecordId: `${record}-feis`,
              payload: {
                document_key: `review_document:${reviewKey}:feis:${isoAt(startMs, day).slice(0, 10)}:${String(index).padStart(12, "0")}`,
                document_type: "feis",
                content_hash: `${String(index + 1).padStart(4, "0")}`.repeat(16),
                supersedes_document_key: draftKey,
              },
            }));
          }
        }
      }
    }

    // Topic outcomes: the eventual assessment state of each topic that went
    // to detailed analysis. Contention decides whether an identified impact
    // ends mitigated, unmitigated, or disputed in comments.
    const outcomeDay = day + 10 + random.int(30);
    if (startMs + outcomeDay * DAY_MS <= Date.parse(OBSERVATION_HORIZON)) {
      for (let t = 0; t < detailedCount; t++) {
        const severity = 0.55 * contention + 0.45 * random.next();
        let state;
        if (severity < 0.32) state = "detailed_analysis";
        else if (severity < 0.52) state = "impact_identified";
        else if (severity < 0.7) state = "mitigation_proposed";
        else if (severity < 0.85) state = "disputed_in_comments";
        else state = "unmitigated";
        events.push(event({
          reviewKey, eventType: "topic_assessed", effectiveAt: isoAt(startMs, outcomeDay),
          sourceId: source, sourceRecordId: `${record}-outcome-${t}`,
          payload: { technical_topic: SCREENED_TOPICS[t], state, document_key: null },
        }));
      }
      if (classification === "conditioned_negative_declaration_issued" || eisPath) {
        events.push(event({
          reviewKey, eventType: "mitigation_committed", effectiveAt: isoAt(startMs, outcomeDay + 1),
          sourceId: source, sourceRecordId: `${record}-mitigation`,
          payload: { description: "Restrict construction staging hours and monitor noise at the nearest receptor.", status: "committed" },
        }));
      }
      if (eisPath) {
        events.push(event({
          reviewKey, eventType: "alternative_considered", effectiveAt: isoAt(startMs, outcomeDay + 1),
          sourceId: source, sourceRecordId: `${record}-alternative`,
          payload: { name: "Reduced-density alternative", status: "analyzed" },
        }));
      }
      day = outcomeDay;
    }

    // Supplemental review: a technical memorandum or supplemental EIS after
    // the cutoff. Driven by contention and by how many topics were left
    // unresolved -- the institutional tier again.
    const supplementalDay = cutoffDay + 40 + random.int(200);
    const supplementalScore = 0.65 * contention + 0.35 * (detailedCount / SCREENED_TOPICS.length);
    if (supplementalScore > 0.52 && startMs + supplementalDay * DAY_MS <= Date.parse(OBSERVATION_HORIZON)) {
      events.push(event({
        reviewKey,
        eventType: supplementalScore > 0.78 ? "supplemental_eis_initiated" : "technical_memorandum_issued",
        effectiveAt: isoAt(startMs, supplementalDay),
        sourceId: source, sourceRecordId: `${record}-supplemental`,
      }));
      day = Math.max(day, supplementalDay);
    }

    const determinationDay = day + 20 + random.int(80);
    if (startMs + determinationDay * DAY_MS <= Date.parse(OBSERVATION_HORIZON)) {
      determinationDate = isoAt(startMs, determinationDay).slice(0, 10);
      events.push(event({
        reviewKey, eventType: "final_determination_issued", effectiveAt: `${determinationDate}T00:00:00.000Z`,
        sourceId: source, sourceRecordId: `${record}-determination`,
        payload: {
          action_key: buildActionKey({ agency: "DCP", sourceSystem: "ZAP", sourceActionId: `N-BASELINE-${String(index).padStart(4, "0")}` }),
          determination_key: buildDeterminationKey({ agency: "DCP", actionId: `N-BASELINE-${String(index).padStart(4, "0")}`, date: determinationDate }),
          agency: "DCP",
          date: determinationDate,
          outcome: contention > 0.85 ? "approved_with_modifications" : "approved",
          supersedes_determination_key: null,
        },
      }));
      const completionDay = determinationDay + 200 + random.int(300);
      if (startMs + completionDay * DAY_MS <= Date.parse(OBSERVATION_HORIZON)) {
        implementationCompletionDate = isoAt(startMs, completionDay).slice(0, 10);
      }
    }
  }

  return {
    reviewKey,
    projectKey: `project:zap:baseline-${String(index).padStart(4, "0")}`,
    regime,
    cutoff,
    events: Object.freeze(events),
    publicPositions: [],
    determinationDate,
    implementationCompletionDate,
  };
}

function generateCorpus() {
  const random = makeRandom(20260905);
  const reviews = [];
  const projects = [];
  for (let index = 0; index < REVIEW_COUNT; index++) {
    const review = generateReview(index, random);
    reviews.push(review);
    // Every twelfth project is a resubmission of the previous site: it shares
    // a BBL, so SEQRA-08's project-family grouping puts both in one family and
    // the fold builder must keep that family off both sides of a boundary.
    const siteIndex = index % 12 === 11 ? index - 1 : index;
    projects.push({ projectKey: review.projectKey, bbls: [`3${String(100000 + siteIndex).padStart(9, "0")}`.slice(0, 10)] });
  }
  return { reviews: Object.freeze(reviews), projects: Object.freeze(projects) };
}

const CORPUS = generateCorpus();

export const BASELINE_CORPUS_REVIEWS = CORPUS.reviews;
export const BASELINE_CORPUS_PROJECTS = CORPUS.projects;

/**
 * Four rolling-origin folds. Each fold trains on everything up to its
 * `trainEnd` and tests on the window that follows -- strictly time-ordered,
 * never a random row split (SEQRA-08's `buildRollingOriginFolds` contract).
 */
export const BASELINE_CORPUS_FOLDS = Object.freeze([
  { foldId: "fold-2021", trainEnd: "2020-12-31T23:59:59.999Z", testStart: "2020-12-31T23:59:59.999Z", testEnd: "2021-12-31T23:59:59.999Z" },
  { foldId: "fold-2022", trainEnd: "2021-12-31T23:59:59.999Z", testStart: "2021-12-31T23:59:59.999Z", testEnd: "2022-12-31T23:59:59.999Z" },
  { foldId: "fold-2023", trainEnd: "2022-12-31T23:59:59.999Z", testStart: "2022-12-31T23:59:59.999Z", testEnd: "2023-12-31T23:59:59.999Z" },
  { foldId: "fold-2024", trainEnd: "2023-12-31T23:59:59.999Z", testStart: "2023-12-31T23:59:59.999Z", testEnd: "2024-12-31T23:59:59.999Z" },
  { foldId: "fold-2025", trainEnd: "2024-12-31T23:59:59.999Z", testStart: "2024-12-31T23:59:59.999Z", testEnd: "2025-12-31T23:59:59.999Z" },
]);
