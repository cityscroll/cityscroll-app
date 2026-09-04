/**
 * SEQRA-05: comment and agency-response extraction over the dispute record
 * (card deliverable "Comment and agency-response extraction covers the
 * dispute record").
 *
 * `comment_letter` and `agency_response` are already-recognized document
 * types in SEQRA-02's ontology (warehouse/lib/seqra_ontology_spec.mjs) and
 * already classified by SEQRA-04's classifier
 * (warehouse/lib/seqra_document_classifier.mjs); this module only adds the
 * page-level extraction *within* a document of those two types, reusing the
 * same `buildTopicFinding` choke point (and therefore the same A1 evidence
 * guarantee) as impact/mitigation/alternative/threshold extraction.
 *
 * A comment finding's topic and an agency_response finding's topic are
 * linked purely by technical_topic -- this pipeline records the pairing a
 * topic-assessment projection needs (does a response exist for a topic that
 * was disputed) without claiming sentence-level correspondence between one
 * specific comment and one specific response, which is not something this
 * pattern-based extractor can determine.
 */
import { buildTopicFinding } from "./seqra_topic_finding.mjs";
import { SEQRA_TECHNICAL_TOPICS } from "./seqra_ontology_spec.mjs";

export const SEQRA_COMMENT_RESPONSE_EXTRACTOR_TYPE = "seqra05_comment_response_extractor";
export const SEQRA_COMMENT_RESPONSE_EXTRACTOR_VERSION = "v1";

const RESPONSE_DISPOSITIONS = Object.freeze(["addressed", "disputed_unresolved", "deferred", "unknown"]);

const TOPIC_KEYWORD_PATTERNS = Object.freeze({
  land_use_zoning_public_policy: /\bland use(?:s)?\b|\bzoning\b/i,
  socioeconomic_conditions: /\bsocioeconomic\b/i,
  community_facilities_services: /\bcommunity facilit(?:y|ies)\b|\bschool seats?\b/i,
  open_space: /\bopen space\b/i,
  shadows: /\bshadows?\b/i,
  historic_cultural_resources: /\bhistoric(?:al)?(?:\s+and)?\s+cultural resources?\b|\bhistoric resources?\b/i,
  urban_design_visual_resources: /\burban design\b|\bvisual resources?\b/i,
  natural_resources: /\bnatural resources?\b|\bwetlands?\b/i,
  hazardous_materials: /\bhazardous materials?\b/i,
  water_sewer_infrastructure: /\bwater\s*(?:and|\/)?\s*sewer(?:\s+infrastructure)?\b|\bstormwater\b/i,
  solid_waste_sanitation: /\bsolid waste\b|\bsanitation\b/i,
  energy: /\benergy\b/i,
  transportation: /\btransportation\b|\btraffic\b|\bintersection\b/i,
  air_quality: /\bair quality\b/i,
  greenhouse_gas_climate: /\bgreenhouse gas(?:es)?\b|\bclimate\b/i,
  noise: /\bnoise\b/i,
  public_health: /\bpublic health\b/i,
  neighborhood_character: /\bneighborhood character\b/i,
  construction: /\bconstruction(?:\s+period)?\b/i,
  disadvantaged_communities: /\bdisadvantaged communit(?:y|ies)\b/i,
  alternatives: /\balternatives?\b/i,
});

const COMMENT_CUES = Object.freeze([
  /\bcommenters?\s+(?:raised|expressed|stated|noted)\b/i,
  /\bconcern(?:ed)?\s+(?:about|regarding)\b/i,
  /\bpublic\s+comments?\s+(?:raised|noted|expressed)\b/i,
]);

const RESPONSE_CUES = Object.freeze([/\bin response\b/i, /\bthe lead agency\s+(?:responds?|clarifies|notes)\b/i, /\bresponse to comment\b/i]);

const RESPONSE_DISPOSITION_CUES = Object.freeze([
  { disposition: "addressed", pattern: /\bno (?:further|additional) (?:mitigation|analysis) is (?:required|warranted)\b|\bhas been addressed\b/i },
  { disposition: "deferred", pattern: /\bwill be addressed in (?:a|the) (?:supplemental|subsequent)\b|\bwill be evaluated further\b/i },
  { disposition: "disputed_unresolved", pattern: /\bdisagrees? with\b|\bdoes not (?:agree|concur)\b/i },
]);

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

function splitSentences(pageText) {
  return pageText.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function boundedExcerpt(sentence, maxLength = 280) {
  return sentence.length <= maxLength ? sentence : `${sentence.slice(0, maxLength - 1).trim()}…`;
}

function detectResponseDisposition(sentence) {
  const hit = RESPONSE_DISPOSITION_CUES.find((entry) => entry.pattern.test(sentence));
  return hit ? hit.disposition : "unknown";
}

/**
 * Extract comment findings from one page of a `comment_letter` document.
 */
export function extractCommentFindingsFromPage({ pageNumber, text, context } = {}) {
  return extractDisputeFindingsFromPage({ pageNumber, text, context, findingType: "comment", cues: COMMENT_CUES });
}

/**
 * Extract agency-response findings from one page of an `agency_response`
 * document. Each finding carries `response_disposition` (addressed /
 * deferred / disputed_unresolved / unknown) alongside the standard finding
 * fields, folded into `normalized_value`/`unit` is deliberately avoided --
 * a disposition is categorical, not a numeric threshold fact, so it is
 * carried as its own field rather than overloading the threshold-fact
 * shape.
 */
export function extractResponseFindingsFromPage({ pageNumber, text, context } = {}) {
  const findings = extractDisputeFindingsFromPage({ pageNumber, text, context, findingType: "agency_response", cues: RESPONSE_CUES });
  return findings.map((f) => Object.freeze({ ...f, response_disposition: detectResponseDisposition(f.evidence_excerpt) }));
}

function extractDisputeFindingsFromPage({ pageNumber, text, context, findingType, cues }) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error(`pageNumber must be a positive integer, got ${JSON.stringify(pageNumber)}`);
  requireNonEmptyString(text, "text");
  const { documentKey, documentType, reviewKey, fetchId, contentHash, rawObjectPath, observedAt, extractorVersion = SEQRA_COMMENT_RESPONSE_EXTRACTOR_VERSION, pageQualityState = "high" } = context ?? {};
  requireNonEmptyString(documentKey, "context.documentKey");
  requireNonEmptyString(documentType, "context.documentType");
  requireNonEmptyString(reviewKey, "context.reviewKey");
  requireNonEmptyString(fetchId, "context.fetchId");
  requireNonEmptyString(contentHash, "context.contentHash");
  requireNonEmptyString(rawObjectPath, "context.rawObjectPath");
  requireNonEmptyString(observedAt, "context.observedAt");

  const findings = [];
  for (const sentence of splitSentences(text)) {
    if (!cues.some((cue) => cue.test(sentence))) continue;
    for (const topic of SEQRA_TECHNICAL_TOPICS) {
      if (!TOPIC_KEYWORD_PATTERNS[topic].test(sentence)) continue;
      const confidence = pageQualityState === "low" ? 0.3 : pageQualityState === "medium" ? 0.65 : 0.85;
      findings.push(
        buildTopicFinding({
          reviewKey,
          documentKey,
          documentType,
          findingType,
          technicalTopic: topic,
          pageNumber,
          sectionHeading: null,
          tableOrFigureId: null,
          evidenceExcerpt: boundedExcerpt(sentence),
          fetchId,
          contentHash,
          rawObjectPath,
          extractorType: SEQRA_COMMENT_RESPONSE_EXTRACTOR_TYPE,
          extractorVersion,
          confidence,
          observedAt,
        }),
      );
    }
  }
  return findings;
}

export { RESPONSE_DISPOSITIONS };
