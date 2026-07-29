export const REVIEW_WEIGHTS = Object.freeze({
  amount_percentile: 18,
  method: 12,
  one_bid: 14,
  alarms: 24,
  amendments: 10,
  succession: 12,
  incompleteness: 10
});

const NONCOMPETITIVE_METHODS = new Set([
  "negotiated_acquisition",
  "sole_source",
  "emergency"
]);

export function reviewComponents(record) {
  return {
    amount_percentile: Math.round(Math.max(0, Math.min(1, record.amount_percentile || 0)) * REVIEW_WEIGHTS.amount_percentile),
    method: NONCOMPETITIVE_METHODS.has(record.procurement_method) ? REVIEW_WEIGHTS.method : 0,
    one_bid: record.responsive_bid_count === 1 ? REVIEW_WEIGHTS.one_bid : 0,
    alarms: Math.min(REVIEW_WEIGHTS.alarms, (record.alarm_case_ids?.length || 0) * 8),
    amendments: Math.min(REVIEW_WEIGHTS.amendments, (record.amendment_count || 0) * 5),
    succession: record.succession_gap ? REVIEW_WEIGHTS.succession : 0,
    incompleteness: Math.min(REVIEW_WEIGHTS.incompleteness, (record.missing_field_count || 0) * 2)
  };
}

export function scoreReviewRecord(record) {
  const components = reviewComponents(record);
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  return {
    process_id: record.process_id,
    title: record.title,
    score,
    components,
    remove_one: Object.fromEntries(Object.entries(components).map(([component, value]) => [
      component,
      {score_without: score - value, change: value ? -value : 0}
    ])),
    facts: {
      amount_percentile: record.amount_percentile,
      procurement_method: record.procurement_method,
      responsive_bid_count: record.responsive_bid_count,
      alarm_case_ids: record.alarm_case_ids,
      amendment_count: record.amendment_count,
      succession_gap: record.succession_gap,
      missing_field_count: record.missing_field_count
    },
    source_urls: record.source_urls,
    investigation_href: record.investigation_href,
    label: "Review priority",
    caveat: "Review leads organize human attention; they are not findings."
  };
}

export function buildReviewQueue(records) {
  return records.map(scoreReviewRecord)
    .sort((a, b) => b.score - a.score || a.process_id.localeCompare(b.process_id))
    .map((record, index) => ({...record, rank: index + 1}));
}
