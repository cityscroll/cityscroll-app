export const MISSING_REASONS = Object.freeze([
  "not_published",
  "not_applicable",
  "source_unavailable",
  "adapter_failed",
  "unresolved_join",
  "self_reported_unverified"
]);

const REASONS = new Set(MISSING_REASONS);

export function validateCoverageEntry(entry) {
  const required = [
    "process_id",
    "stage",
    "expected_fields",
    "observed_fields",
    "source_url",
    "source_key",
    "fetch_status",
    "schema_version",
    "last_success_at",
    "content_hash",
    "join_method",
    "join_confidence",
    "missing_reason",
    "stale"
  ];
  const absent = required.filter((field) => !Object.hasOwn(entry, field));
  if (absent.length) throw new TypeError(`coverage entry missing: ${absent.join(", ")}`);
  const missingCount = entry.expected_fields.filter((field) => !entry.observed_fields.includes(field)).length;
  if (missingCount && !REASONS.has(entry.missing_reason)) {
    throw new TypeError("every missing field requires a typed missingness reason");
  }
  if (!missingCount && entry.missing_reason !== null) {
    throw new TypeError("complete coverage cannot carry a missingness reason");
  }
  return entry;
}

export function preserveLastKnownSnapshot(previous, failedReceipt) {
  if (!previous || failedReceipt?.status === "ok") throw new TypeError("failed refresh needs a prior snapshot");
  return validateCoverageEntry({
    ...previous,
    fetch_status: "stale",
    stale: true,
    stale_receipt: {
      attempted_at: failedReceipt.attempted_at,
      status: failedReceipt.status,
      reason: failedReceipt.reason
    }
  });
}

export function aggregateCoverage(entries) {
  const stages = {};
  for (const entry of entries) {
    validateCoverageEntry(entry);
    const stage = (stages[entry.stage] ||= {total: 0, complete: 0, partial: 0, missing: 0, reasons: {}});
    stage.total++;
    const missingCount = entry.expected_fields.filter((field) => !entry.observed_fields.includes(field)).length;
    if (!missingCount) stage.complete++;
    else if (entry.observed_fields.length) stage.partial++;
    else stage.missing++;
    if (entry.missing_reason) stage.reasons[entry.missing_reason] = (stage.reasons[entry.missing_reason] || 0) + 1;
  }
  return stages;
}
