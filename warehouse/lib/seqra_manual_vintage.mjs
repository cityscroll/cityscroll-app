/**
 * SEQRA-05: the manual-vintage registry a technical-topic finding is scored
 * against (card acceptance A3 -- "topic vocabulary and thresholds are
 * applied at the vintage of the manual governing each review, with any
 * crosswalk documented").
 *
 * `MANUAL_VINTAGES` lists known editions of the governing technical manual
 * by regime (the NYC CEQR Technical Manual for CEQR, the NYS SEQR Handbook
 * for SEQRA). The two CEQR effective-date boundaries recorded here reflect
 * this pipeline's best public knowledge of when NYC OEC's Technical Manual
 * editions took effect (2014 and 2020); like SEQRA-02/04's fixtures, this
 * module does not claim those dates were confirmed against a primary-source
 * fetch in this pass, and every vintage record carries `date_basis` so a
 * caller can see that distinction rather than assume it was verified.
 * Threshold *values* under `thresholds` are illustrative placeholders that
 * exercise the vintage-comparison mechanism -- not asserted, real regulatory
 * figures -- exactly as SEQRA-02/04's synthetic fixture documents are not
 * claims about a real project.
 *
 * The negative rule ("do not apply current technical thresholds
 * retrospectively without a documented vintage crosswalk") is enforced
 * structurally, not just by convention: `compareThresholdFact` requires an
 * explicit `manualVintageId` and only ever looks up a threshold definition
 * under that exact vintage. There is no "current" or "latest" fallback
 * anywhere in this module, so a caller cannot silently compare an older
 * review's fact against a newer edition's threshold by omission.
 */
import { SEQRA_ENVIRONMENTAL_REGIMES, SEQRA_TECHNICAL_TOPICS } from "./seqra_ontology_spec.mjs";

export const SEQRA_MANUAL_VINTAGE_SCHEMA = "cityscroll.seqra_manual_vintage.v1";

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

function requireDateOnly(value, field) {
  requireNonEmptyString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  return value;
}

// Every threshold entry here is a synthetic placeholder value used only to
// exercise the vintage-comparison mechanism (see module docstring). Real
// deployment would source these from the manual edition's own published
// text, with a citation carried in `basis`.
export const MANUAL_VINTAGES = Object.freeze([
  Object.freeze({
    manual_vintage_id: "nyc_ceqr_technical_manual_2014",
    environmental_regime: "CEQR",
    publisher: "NYC Mayor's Office of Environmental Coordination",
    edition_label: "CEQR Technical Manual (2014 edition)",
    effective_start: "2014-03-01",
    effective_end: "2020-02-29",
    date_basis: "public_edition_date_not_verified_by_this_pipeline",
    thresholds: Object.freeze({
      transportation: Object.freeze({
        intersection_level_of_service_delay: Object.freeze({
          operator: ">=",
          value: 4,
          unit: "seconds_of_delay",
          basis: "illustrative_placeholder_not_a_verified_regulatory_figure",
        }),
      }),
      shadows: Object.freeze({
        open_space_shadow_duration: Object.freeze({
          operator: ">",
          value: 0.25,
          unit: "fraction_of_daylight_hours",
          basis: "illustrative_placeholder_not_a_verified_regulatory_figure",
        }),
      }),
    }),
  }),
  Object.freeze({
    manual_vintage_id: "nyc_ceqr_technical_manual_2020",
    environmental_regime: "CEQR",
    publisher: "NYC Mayor's Office of Environmental Coordination",
    edition_label: "CEQR Technical Manual (2020 edition)",
    effective_start: "2020-03-01",
    effective_end: null,
    date_basis: "public_edition_date_not_verified_by_this_pipeline",
    thresholds: Object.freeze({
      transportation: Object.freeze({
        intersection_level_of_service_delay: Object.freeze({
          operator: ">=",
          value: 5,
          unit: "seconds_of_delay",
          basis: "illustrative_placeholder_not_a_verified_regulatory_figure; revised from the 2014 edition's value",
        }),
      }),
      shadows: Object.freeze({
        open_space_shadow_duration: Object.freeze({
          operator: ">",
          value: 0.2,
          unit: "fraction_of_daylight_hours",
          basis: "illustrative_placeholder_not_a_verified_regulatory_figure; revised from the 2014 edition's value",
        }),
      }),
    }),
  }),
  Object.freeze({
    manual_vintage_id: "nys_seqr_handbook_2020",
    environmental_regime: "SEQRA",
    publisher: "NYS Department of Environmental Conservation",
    edition_label: "SEQR Handbook (most recent statewide edition on record)",
    effective_start: "2020-01-01",
    effective_end: null,
    date_basis: "public_edition_date_not_verified_by_this_pipeline",
    thresholds: Object.freeze({}),
  }),
]);

const VINTAGES_BY_ID = new Map(MANUAL_VINTAGES.map((v) => [v.manual_vintage_id, v]));

// Documented crosswalk entries: every case where the *same* technical_topic
// token names a differently-scoped or differently-thresholded chapter
// across two vintages. This module's own vocabulary (SEQRA_TECHNICAL_TOPICS)
// has not changed token names between the two recorded CEQR editions, so
// every crosswalk entry here is a threshold or scope revision, never a
// renamed topic -- but the shape supports a renamed topic (`to_topic`
// differing from `topic`) so a future vintage that does rename a chapter
// does not require a new mechanism, only a new entry.
export const MANUAL_VINTAGE_CROSSWALK = Object.freeze([
  Object.freeze({
    from_vintage_id: "nyc_ceqr_technical_manual_2014",
    to_vintage_id: "nyc_ceqr_technical_manual_2020",
    topic: "transportation",
    to_topic: "transportation",
    change_description:
      "Illustrative: the intersection level-of-service delay threshold this pipeline models moved from >=4s to >=5s of " +
      "delay between the two recorded editions. A review governed by the 2014 edition must be scored against the " +
      "2014 threshold, not the 2020 one, even when the extraction pass itself runs after 2020.",
  }),
  Object.freeze({
    from_vintage_id: "nyc_ceqr_technical_manual_2014",
    to_vintage_id: "nyc_ceqr_technical_manual_2020",
    topic: "shadows",
    to_topic: "shadows",
    change_description:
      "Illustrative: the open-space shadow-duration threshold this pipeline models moved from >0.25 to >0.2 of daylight " +
      "hours between the two recorded editions.",
  }),
]);

export function listManualVintages({ environmentalRegime = null } = {}) {
  if (environmentalRegime != null && !SEQRA_ENVIRONMENTAL_REGIMES.includes(environmentalRegime)) {
    throw new Error(`environmentalRegime must be one of ${SEQRA_ENVIRONMENTAL_REGIMES.join("|")}, got ${JSON.stringify(environmentalRegime)}`);
  }
  return MANUAL_VINTAGES.filter((v) => environmentalRegime == null || v.environmental_regime === environmentalRegime);
}

export function getManualVintage(manualVintageId) {
  requireNonEmptyString(manualVintageId, "manualVintageId");
  const vintage = VINTAGES_BY_ID.get(manualVintageId);
  if (!vintage) throw new Error(`unknown manual_vintage_id ${JSON.stringify(manualVintageId)}`);
  return vintage;
}

/**
 * Resolve the single manual vintage governing a review as of `referenceDate`
 * (the review's own governing date -- typically the date the review's lead
 * agency was established or its earliest scoping document was issued, never
 * "today"). Returns `{ status: "resolved", vintage }` or, when no vintage's
 * effective window covers the date, `{ status: "unknown_vintage", reason }`
 * -- this function never guesses the nearest vintage or falls back to the
 * most recent one.
 */
export function resolveManualVintageForReview({ environmentalRegime, referenceDate } = {}) {
  if (!SEQRA_ENVIRONMENTAL_REGIMES.includes(environmentalRegime)) {
    throw new Error(`environmentalRegime must be one of ${SEQRA_ENVIRONMENTAL_REGIMES.join("|")}, got ${JSON.stringify(environmentalRegime)}`);
  }
  requireDateOnly(referenceDate, "referenceDate");
  const candidates = listManualVintages({ environmentalRegime });
  const match = candidates.find((v) => referenceDate >= v.effective_start && (v.effective_end == null || referenceDate <= v.effective_end));
  if (!match) {
    return {
      status: "unknown_vintage",
      reason: `no ${environmentalRegime} manual vintage's recorded effective window covers ${referenceDate}`,
      vintage: null,
    };
  }
  return { status: "resolved", reason: null, vintage: match };
}

/**
 * Compare one extracted normalized threshold fact against the threshold
 * definition of one explicit vintage. `manualVintageId` is required (no
 * default, no "current" fallback) -- this is the structural half of the
 * negative rule: a caller that omits the vintage, or names a vintage this
 * topic/fact_type has no definition under, gets an explicit
 * `no_threshold_definition_for_vintage` result rather than a silently
 * substituted definition from any other vintage.
 */
export function compareThresholdFact({ manualVintageId, technicalTopic, factType, normalizedValue } = {}) {
  requireNonEmptyString(manualVintageId, "manualVintageId");
  if (!SEQRA_TECHNICAL_TOPICS.includes(technicalTopic)) {
    throw new Error(`technicalTopic must be one of SEQRA_TECHNICAL_TOPICS, got ${JSON.stringify(technicalTopic)}`);
  }
  requireNonEmptyString(factType, "factType");
  if (typeof normalizedValue !== "number" || !Number.isFinite(normalizedValue)) {
    throw new Error(`normalizedValue must be a finite number, got ${JSON.stringify(normalizedValue)}`);
  }
  const vintage = getManualVintage(manualVintageId);
  const definition = vintage.thresholds?.[technicalTopic]?.[factType];
  if (!definition) {
    return {
      status: "no_threshold_definition_for_vintage",
      manual_vintage_id: manualVintageId,
      technical_topic: technicalTopic,
      fact_type: factType,
      exceeds_threshold: null,
    };
  }
  const exceeds = definition.operator === ">=" ? normalizedValue >= definition.value : normalizedValue > definition.value;
  return {
    status: "compared",
    manual_vintage_id: manualVintageId,
    technical_topic: technicalTopic,
    fact_type: factType,
    threshold_definition: definition,
    normalized_value: normalizedValue,
    exceeds_threshold: exceeds,
  };
}

/** Crosswalk entries touching one topic, in either direction -- the documented explanation a caller must be able to cite before comparing facts across two vintages. */
export function crosswalkEntriesForTopic(technicalTopic) {
  if (!SEQRA_TECHNICAL_TOPICS.includes(technicalTopic)) {
    throw new Error(`technicalTopic must be one of SEQRA_TECHNICAL_TOPICS, got ${JSON.stringify(technicalTopic)}`);
  }
  return MANUAL_VINTAGE_CROSSWALK.filter((entry) => entry.topic === technicalTopic || entry.to_topic === technicalTopic);
}
