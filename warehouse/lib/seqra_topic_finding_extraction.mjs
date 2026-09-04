/**
 * SEQRA-05: pattern-based impact/mitigation/alternative/threshold extraction
 * over one document's already-extracted page text (warehouse/lib/
 * seqra_document_extraction.mjs owns turning bytes into page text; this
 * module only ever reads the text SEQRA-04 already produced).
 *
 * Every match becomes a typed finding via `buildTopicFinding`
 * (warehouse/lib/seqra_topic_finding.mjs), which is the single place that
 * enforces "no finding without page and span evidence" (A1) -- this module
 * never constructs a finding by any other path.
 *
 * A page whose own extraction quality was measured `low`
 * (seqra_document_extraction.mjs#assessPageQuality) still gets scanned --
 * silently skipping it would make a garbled page invisible rather than
 * identifiable -- but every finding from it is confidence-capped below the
 * quarantine threshold (warehouse/lib/seqra_topic_finding_quarantine.mjs),
 * so a garbled read is never accepted as if it were a clean one.
 */
import {
  compareThresholdFact,
  resolveManualVintageForReview,
} from "./seqra_manual_vintage.mjs";
import { SEQRA_TECHNICAL_TOPICS } from "./seqra_ontology_spec.mjs";
import { buildTopicFinding } from "./seqra_topic_finding.mjs";

export const SEQRA_TOPIC_EXTRACTOR_TYPE = "seqra05_pattern_extractor";
export const SEQRA_TOPIC_EXTRACTOR_VERSION = "v1";

const LOW_QUALITY_CONFIDENCE_CAP = 0.4;

// One keyword pattern per topic, chosen to be as topic-specific as this
// pipeline's fixed vocabulary allows. A page can legitimately match more
// than one topic; each match is scored independently rather than forcing a
// single topic per page.
const TOPIC_KEYWORD_PATTERNS = Object.freeze({
  land_use_zoning_public_policy: /\bland use(?:s)?\b|\bzoning\b|\bpublic policy\b/i,
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

const TOPIC_HEADING_PATTERNS = Object.freeze(
  Object.fromEntries(
    Object.entries(TOPIC_KEYWORD_PATTERNS).map(([topic, pattern]) => [topic, new RegExp(`^\\s*(?:chapter\\s+\\d+[:.]?\\s*)?(?:${pattern.source})\\s*$`, "im")]),
  ),
);

const TABLE_OR_FIGURE_PATTERN = /\b(Table|Figure)\s+([0-9]+(?:[.-][0-9A-Za-z]+)?)\b/;

const FINDING_TYPE_CUES = Object.freeze({
  screened_out_statement: [/\bscreened out\b/i, /\bno further analysis (?:is |was )?(?:required|warranted)\b/i, /\bnot applicable to this action\b/i],
  impact: [/\bpotential(?:ly)? significant adverse impact\b/i, /\bwould result in an? (?:adverse )?impact\b/i, /\bimpact (?:on|to) (?:the )?/i],
  mitigation: [/\bmitigation measures?\b/i, /\bwill mitigate\b/i, /\bproposed mitigation\b/i, /\bcommits? to\b.*\bmitigat/i],
  alternative: [/\balternative\b.*\b(?:considered|analyzed|rejected|selected)\b/i, /\bno[- ]action alternative\b/i],
  threshold_comparison: [/\bthreshold\b/i, /\bexceeds?\b.*\b(?:threshold|standard|significance)\b/i, /\bde minimis\b/i, /seconds? of delay/i, /of daylight hours/i],
});

// Numeric threshold fact extraction, one pattern per (topic, fact_type) this
// pipeline's manual-vintage registry (seqra_manual_vintage.mjs) actually
// carries a definition for. A topic/fact_type this map does not name is
// still eligible for a plain `threshold_comparison` finding (cue-phrase
// matched) but never gets a numeric normalizedValue/unit invented for it.
const THRESHOLD_FACT_PATTERNS = Object.freeze({
  transportation: [{ factType: "intersection_level_of_service_delay", unit: "seconds_of_delay", pattern: /([0-9]+(?:\.[0-9]+)?)\s*seconds? of delay/i }],
  shadows: [{ factType: "open_space_shadow_duration", unit: "fraction_of_daylight_hours", pattern: /([0-9]+(?:\.[0-9]+)?)\s*%?\s*of daylight hours/i, percentToFraction: true }],
});

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

function detectSectionHeading(pageText) {
  const lines = pageText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    for (const [topic, headingPattern] of Object.entries(TOPIC_HEADING_PATTERNS)) {
      if (headingPattern.test(line)) return { topic, heading: line };
    }
  }
  return { topic: null, heading: null };
}

function splitSentences(pageText) {
  return pageText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function boundedExcerpt(sentence, maxLength = 280) {
  return sentence.length <= maxLength ? sentence : `${sentence.slice(0, maxLength - 1).trim()}…`;
}

function detectTableOrFigure(sentence) {
  const match = TABLE_OR_FIGURE_PATTERN.exec(sentence);
  return match ? `${match[1]} ${match[2]}` : null;
}

function normalizedThresholdValue(rawMatch, config) {
  const value = Number(rawMatch[1]);
  return config.percentToFraction && /%/.test(rawMatch[0]) ? value / 100 : value;
}

function extractorConfidence({ headingMatchesTopic, pageQualityState }) {
  let base = headingMatchesTopic ? 0.9 : 0.7;
  if (pageQualityState === "low") base = Math.min(base, LOW_QUALITY_CONFIDENCE_CAP);
  else if (pageQualityState === "medium") base -= 0.15;
  return Math.max(0, Math.min(1, Number(base.toFixed(4))));
}

/**
 * Extract typed findings from one already-extracted page. `context` carries
 * everything a finding must trace back to its stored bytes
 * (documentKey/documentType/reviewKey/fetchId/contentHash/rawObjectPath),
 * plus the review's resolved manual vintage (nullable -- a threshold finding
 * simply carries no numeric comparison when the vintage cannot be resolved,
 * it never borrows another vintage's definition) and the page's own
 * extraction-quality state from SEQRA-04.
 */
export function extractTopicFindingsFromPage({ pageNumber, text, context } = {}) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error(`pageNumber must be a positive integer, got ${JSON.stringify(pageNumber)}`);
  requireNonEmptyString(text, "text");
  const { documentKey, documentType, reviewKey, fetchId, contentHash, rawObjectPath, manualVintageId = null, pageQualityState = "high", observedAt, extractorVersion = SEQRA_TOPIC_EXTRACTOR_VERSION } = context ?? {};
  requireNonEmptyString(documentKey, "context.documentKey");
  requireNonEmptyString(documentType, "context.documentType");
  requireNonEmptyString(reviewKey, "context.reviewKey");
  requireNonEmptyString(fetchId, "context.fetchId");
  requireNonEmptyString(contentHash, "context.contentHash");
  requireNonEmptyString(rawObjectPath, "context.rawObjectPath");
  requireNonEmptyString(observedAt, "context.observedAt");

  const { topic: headingTopic, heading } = detectSectionHeading(text);
  const findings = [];
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    const tableOrFigureId = detectTableOrFigure(sentence);

    for (const topic of SEQRA_TECHNICAL_TOPICS) {
      const keywordPattern = TOPIC_KEYWORD_PATTERNS[topic];
      if (!keywordPattern.test(sentence)) continue;
      const headingMatchesTopic = headingTopic === topic;

      for (const [findingType, cues] of Object.entries(FINDING_TYPE_CUES)) {
        if (!cues.some((cue) => cue.test(sentence))) continue;

        const confidence = extractorConfidence({ headingMatchesTopic, pageQualityState });
        const evidenceExcerpt = boundedExcerpt(sentence);

        if (findingType === "threshold_comparison") {
          const thresholdPatterns = THRESHOLD_FACT_PATTERNS[topic] ?? [];
          const numericMatch = thresholdPatterns.map((cfg) => ({ cfg, match: cfg.pattern.exec(sentence) })).find((entry) => entry.match);
          if (numericMatch && manualVintageId) {
            const normalizedValue = normalizedThresholdValue(numericMatch.match, numericMatch.cfg);
            findings.push(
              buildTopicFinding({
                reviewKey,
                documentKey,
                documentType,
                findingType,
                technicalTopic: topic,
                pageNumber,
                sectionHeading: heading,
                tableOrFigureId,
                evidenceExcerpt,
                fetchId,
                contentHash,
                rawObjectPath,
                manualVintageId,
                factType: numericMatch.cfg.factType,
                normalizedValue,
                unit: numericMatch.cfg.unit,
                extractorType: SEQRA_TOPIC_EXTRACTOR_TYPE,
                extractorVersion,
                confidence,
                observedAt,
              }),
            );
            continue;
          }
          // A threshold cue with no resolvable numeric fact under the
          // review's own vintage is still recorded as a cited finding, just
          // without a normalized comparison -- never silently dropped and
          // never filled in from a different vintage's definition.
        }

        findings.push(
          buildTopicFinding({
            reviewKey,
            documentKey,
            documentType,
            findingType,
            technicalTopic: topic,
            pageNumber,
            sectionHeading: heading,
            tableOrFigureId,
            evidenceExcerpt,
            fetchId,
            contentHash,
            rawObjectPath,
            manualVintageId: findingType === "threshold_comparison" ? manualVintageId : null,
            extractorType: SEQRA_TOPIC_EXTRACTOR_TYPE,
            extractorVersion,
            confidence,
            observedAt,
          }),
        );
      }
    }
  }
  return findings;
}

/** Extract findings across every page of one document. */
export function extractTopicFindingsFromDocument({ pages = [], context } = {}) {
  return pages.flatMap((page) => extractTopicFindingsFromPage({ pageNumber: page.page_number, text: page.text, context: { ...context, pageQualityState: page.quality_state ?? context?.pageQualityState ?? "high" } }));
}

/**
 * Attach a vintage-explicit threshold comparison to an already-built
 * threshold_comparison finding, using this module's manual-vintage registry.
 * Never called with an implied "current" vintage -- `finding.manual_vintage_id`
 * (set at extraction time from the review's own resolved vintage) is the
 * only vintage this ever compares against.
 */
export function evaluateThresholdFinding(finding) {
  if (finding.finding_type !== "threshold_comparison" || finding.normalized_value == null) {
    return { status: "not_a_numeric_threshold_finding", exceeds_threshold: null };
  }
  return compareThresholdFact({
    manualVintageId: finding.manual_vintage_id,
    technicalTopic: finding.technical_topic,
    factType: finding.fact_type,
    normalizedValue: finding.normalized_value,
  });
}

export { resolveManualVintageForReview };
