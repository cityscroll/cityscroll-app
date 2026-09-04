/**
 * SEQRA-05: human-reviewed benchmark scoring (card acceptance A4 --
 * "precision and recall are reported per topic and per document type
 * against a human-reviewed benchmark set").
 *
 * A benchmark entry names one page of one document a human reviewer has
 * actually looked at (`reviewed: true`) and the set of (technical_topic,
 * finding_type) pairs they confirmed are genuinely present on that page --
 * possibly empty, when the reviewer confirmed nothing extractable is there.
 * Scoring only ever compares extractor output against *reviewed* pages:
 * an extractor finding on a page nobody has reviewed is neither a true nor
 * a false positive, it is simply out of the benchmark's scope, and this
 * module reports that count separately (`unscored_finding_count`) rather
 * than silently folding it into precision.
 *
 * The fixture benchmark set this module ships with
 * (warehouse/fixtures/seqra-ceqr-access/sample_topic_extraction_fixtures.mjs)
 * is a small synthetic set built to exercise this scoring mechanism -- like
 * every other SEQRA-02/04/05 fixture in this codebase, it is not a claim
 * about a real environmental review, and a real benchmark of the size A4
 * ultimately needs is a later, larger human-labeling effort.
 */
export const SEQRA_TOPIC_EXTRACTION_BENCHMARK_SCHEMA = "cityscroll.seqra_topic_extraction_benchmark_report.v1";

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function pairKey(technicalTopic, findingType) {
  return `${technicalTopic}|${findingType}`;
}

function pageKey(documentKey, pageNumber) {
  return `${documentKey}#${pageNumber}`;
}

function emptyCounts() {
  return { true_positive: 0, false_positive: 0, false_negative: 0 };
}

function precisionRecall(counts) {
  const { true_positive: tp, false_positive: fp, false_negative: fn } = counts;
  const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null;
  const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null;
  const f1 = precision != null && recall != null && precision + recall > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : null;
  return {
    ...counts,
    precision,
    recall,
    f1,
    insufficient_data: precision == null && recall == null,
  };
}

/**
 * Score `findings` (typed findings from seqra_topic_finding_extraction.mjs
 * and seqra_comment_response_extraction.mjs) against `benchmarkSet` and
 * report precision/recall broken out per technical_topic and per
 * document_type, plus an overall roll-up.
 */
export function computeExtractionBenchmarkReport({ benchmarkSet = [], findings = [] } = {}) {
  requireArray(benchmarkSet, "benchmarkSet");
  requireArray(findings, "findings");

  const reviewedPages = new Map(); // pageKey -> { documentType, expected: Set<pairKey> }
  for (const entry of benchmarkSet) {
    if (!entry.reviewed) continue;
    reviewedPages.set(pageKey(entry.document_key, entry.page_number), {
      documentType: entry.document_type,
      expected: new Set((entry.expected_findings ?? []).map((e) => pairKey(e.technical_topic, e.finding_type))),
    });
  }

  const findingsByPage = new Map();
  let unscoredFindingCount = 0;
  for (const finding of findings) {
    const key = pageKey(finding.document_key, finding.page_number);
    if (!reviewedPages.has(key)) {
      unscoredFindingCount += 1;
      continue;
    }
    if (!findingsByPage.has(key)) findingsByPage.set(key, new Set());
    findingsByPage.get(key).add(pairKey(finding.technical_topic, finding.finding_type));
  }

  const byTopic = new Map();
  const byDocumentType = new Map();
  const overall = emptyCounts();

  function accumulate(map, key, delta) {
    if (!map.has(key)) map.set(key, emptyCounts());
    const counts = map.get(key);
    counts.true_positive += delta.true_positive;
    counts.false_positive += delta.false_positive;
    counts.false_negative += delta.false_negative;
  }

  for (const [key, page] of reviewedPages.entries()) {
    const actual = findingsByPage.get(key) ?? new Set();
    const topicsSeen = new Set([...page.expected, ...actual].map((pk) => pk.split("|")[0]));
    for (const topic of topicsSeen) {
      const expectedForTopic = [...page.expected].filter((pk) => pk.startsWith(`${topic}|`));
      const actualForTopic = [...actual].filter((pk) => pk.startsWith(`${topic}|`));
      const tp = expectedForTopic.filter((pk) => actual.has(pk)).length;
      const fp = actualForTopic.filter((pk) => !page.expected.has(pk)).length;
      const fn = expectedForTopic.filter((pk) => !actual.has(pk)).length;
      const delta = { true_positive: tp, false_positive: fp, false_negative: fn };
      accumulate(byTopic, topic, delta);
      accumulate(byDocumentType, page.documentType, delta);
      overall.true_positive += tp;
      overall.false_positive += fp;
      overall.false_negative += fn;
    }
  }

  return Object.freeze({
    schema: SEQRA_TOPIC_EXTRACTION_BENCHMARK_SCHEMA,
    benchmark_source: "human_reviewed_fixture_v1",
    reviewed_page_count: reviewedPages.size,
    unscored_finding_count: unscoredFindingCount,
    by_topic: Object.fromEntries([...byTopic.entries()].map(([k, v]) => [k, precisionRecall(v)])),
    by_document_type: Object.fromEntries([...byDocumentType.entries()].map(([k, v]) => [k, precisionRecall(v)])),
    overall: precisionRecall(overall),
  });
}
