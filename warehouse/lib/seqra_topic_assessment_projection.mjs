/**
 * SEQRA-05: project a review's typed findings into one
 * `technical_topic_assessment` observation per topic (card acceptance A2 --
 * "a topic not mentioned is recorded as not located and is never reported
 * as screened out").
 *
 * This is the one place that boundary is enforced structurally rather than
 * by convention: `screened_out` is reachable *only* through an explicit
 * `screened_out_statement` finding (built only from explicit screening
 * language -- see FINDING_TYPE_CUES.screened_out_statement in
 * seqra_topic_finding_extraction.mjs). Every topic this function is asked
 * to project that has zero surviving findings of any kind gets
 * `not_located`; there is no code path from "no findings" to
 * `screened_out`, so the two can never be confused by a scoring bug the way
 * a single "did we see this topic at all" boolean could be.
 *
 * Every record this function returns is validated against SEQRA-02's own
 * `technical_topic_assessment` entity spec
 * (warehouse/lib/seqra_ontology_spec.mjs#validateSeqraEntity) before it is
 * returned, so a projection bug that produced a malformed observation would
 * fail loudly here rather than downstream.
 */
import {
  SEQRA_TECHNICAL_TOPICS,
  SEQRA_TOPIC_ASSESSMENT_STATES,
  validateSeqraEntity,
} from "./seqra_ontology_spec.mjs";

export const SEQRA_TOPIC_ASSESSMENT_PROJECTION_SCHEMA = "cityscroll.seqra_topic_assessment_projection.v1";

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

function buildAssessmentKey({ reviewKey, documentKey, technicalTopic }) {
  return `technical_topic_assessment:${reviewKey}:${documentKey ?? "no_document"}:${technicalTopic}`;
}

/**
 * Decide one topic's state from the findings already gathered for it
 * (across impact/mitigation/alternative/threshold/comment/agency_response
 * finding types, already filtered to a single topic by the caller). Order
 * matters: screening is checked first because it is the most specific,
 * explicit signal; disputes and responses are checked before generic
 * impact/mitigation because they represent a more advanced stage of the
 * same topic's record.
 */
function decideTopicState(topicFindings) {
  if (topicFindings.length === 0) return "not_located";
  const types = new Set(topicFindings.map((f) => f.finding_type));
  if (types.has("screened_out_statement")) return "screened_out";

  const hasResponse = types.has("agency_response");
  const hasComment = types.has("comment");
  if (hasComment && hasResponse) return "agency_response_complete";
  if (hasComment && !hasResponse) return "disputed_in_comments";

  const hasMitigation = types.has("mitigation");
  const hasImpact = types.has("impact");
  const hasThreshold = types.has("threshold_comparison");
  const hasAlternative = types.has("alternative");

  if (hasImpact && hasMitigation) return "mitigation_proposed";
  if (hasImpact && !hasMitigation) return "unmitigated";
  if (hasThreshold || hasAlternative) return "detailed_analysis";
  return "detailed_analysis";
}

/**
 * Project one `technical_topic_assessment` observation per entry of
 * `topics` (defaults to the full SEQRA_TECHNICAL_TOPICS vocabulary, so a
 * caller who wants every topic represented -- required to make "not
 * located" observable for topics with zero findings -- does not have to
 * enumerate it by hand).
 */
export function projectTopicAssessments({
  reviewKey,
  documentKey = null,
  findings = [],
  topics = SEQRA_TECHNICAL_TOPICS,
  manualVintageId = null,
  observedAt,
  availableToPublicAt,
  sourceId = "seqra05_topic_extraction",
  sourceRecordId,
} = {}) {
  requireNonEmptyString(reviewKey, "reviewKey");
  requireNonEmptyString(observedAt, "observedAt");
  requireNonEmptyString(availableToPublicAt, "availableToPublicAt");
  requireNonEmptyString(sourceRecordId, "sourceRecordId");

  const findingsByTopic = new Map(topics.map((t) => [t, []]));
  for (const finding of findings) {
    if (!findingsByTopic.has(finding.technical_topic)) continue;
    findingsByTopic.get(finding.technical_topic).push(finding);
  }

  const assessments = [];
  for (const topic of topics) {
    const topicFindings = findingsByTopic.get(topic) ?? [];
    const state = decideTopicState(topicFindings);
    if (!SEQRA_TOPIC_ASSESSMENT_STATES.includes(state)) {
      throw new Error(`projectTopicAssessments: decideTopicState produced an unrecognized state ${JSON.stringify(state)} for topic ${topic}`);
    }
    const evidence = topicFindings.length > 0
      ? topicFindings.map((f) => `${f.finding_key} (p.${f.page_number}${f.section_heading ? `, "${f.section_heading}"` : ""})`).join("; ")
      : null;
    const record = Object.freeze({
      assessment_key: buildAssessmentKey({ reviewKey, documentKey, technicalTopic: topic }),
      review_key: reviewKey,
      document_key: documentKey,
      technical_topic: topic,
      state,
      observed_at: observedAt,
      available_to_public_at: availableToPublicAt,
      source_id: sourceId,
      source_record_id: sourceRecordId,
      source_vintage: manualVintageId,
      evidence,
      confidence: topicFindings.length > 0 ? Math.max(...topicFindings.map((f) => f.confidence)) : 1,
      rival_explanation: topicFindings.length === 0
        ? "topic may have been discussed in a document or page this pipeline has not yet fetched or extracted; absence here reflects this pipeline's coverage, not a confirmed absence in the underlying review"
        : null,
      suppression_rule: null,
    });
    const findingsErr = validateSeqraEntity("technical_topic_assessment", record, `${reviewKey}:${topic}`);
    if (findingsErr.length > 0) {
      throw new Error(`projectTopicAssessments: projected assessment failed ontology validation: ${findingsErr.join("; ")}`);
    }
    assessments.push(record);
  }
  return Object.freeze({
    schema: SEQRA_TOPIC_ASSESSMENT_PROJECTION_SCHEMA,
    review_key: reviewKey,
    document_key: documentKey,
    assessment_count: assessments.length,
    not_located_count: assessments.filter((a) => a.state === "not_located").length,
    screened_out_count: assessments.filter((a) => a.state === "screened_out").length,
    assessments: Object.freeze(assessments),
  });
}
