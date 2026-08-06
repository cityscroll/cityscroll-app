/**
 * Exact exam-number join for the LL50 eligible-list utilization publication.
 *
 * This module deliberately keeps the source row separate from the owning exam
 * card. The two titles can disagree because they are publisher fields from
 * different sources; neither is silently overwritten by the other.
 */

export const ELIGIBLE_LIST_UTILIZATION_SOURCE = Object.freeze({
  id: "dcas-eligible-list-utilization",
  dataset_id: "qjzt-ytn9",
  key: "exam_no",
});

const SOURCE_FIELDS = Object.freeze([
  "title_description",
  "o_c_or_prom",
  "list_title_code",
  "exam_no",
  "list_agency_code",
  "agency_desc",
  "list_div_code",
  "list_est_date",
  "aac_cnt",
  "aol_cnt",
  "dce_cnt",
  "dea_cnt",
  "dlx_cnt",
  "fra_cnt",
  "frh_cnt",
  "fri_cnt",
  "frm_cnt",
  "frp_cnt",
  "ftr_cnt",
  "nfp_cnt",
  "nle_cnt",
  "ova_cnt",
  "rli_cnt",
  "tin_cnt",
  "unf_cnt",
  "appt_cnt",
  "cns_cnt",
  "cns_restored_cnt",
  "elig_restored_cnt",
]);

function exactKey(value) {
  const key = String(value ?? "").trim();
  return /^\d+$/.test(key) ? key : null;
}

function copySourceRow(row) {
  return Object.fromEntries(SOURCE_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(row || {}, field))
    .map((field) => [field, row[field]]));
}

/**
 * Build the published graph slice. Only exact exam_no ↔ exam_number matches
 * survive; no title, agency, or zero-padding inference is performed.
 */
export function buildEligibleListUtilizationSlice(exams = [], sourceRows = [], options = {}) {
  const source = options.source || ELIGIBLE_LIST_UTILIZATION_SOURCE;
  const eligibleKeys = new Set((exams || []).map((exam) => exactKey(exam?.exam_number)).filter(Boolean));
  const records = [];
  for (const row of sourceRows || []) {
    const examNo = exactKey(row?.exam_no);
    if (!examNo || !eligibleKeys.has(examNo)) continue;
    records.push({
      exam_number: examNo,
      source_row: copySourceRow(row),
      provenance: {
        join: "exact",
        join_key: "exam_no",
        source: source.id,
        dataset_id: source.dataset_id,
        source_row_key: `exam_no:${examNo}`,
        owning_source: "staffing_exams",
        owning_field: "exam_number",
        confidence: "strong",
      },
    });
  }
  const linked = new Set(records.map((record) => record.exam_number));
  const eligible = eligibleKeys.size;
  return {
    schema_version: 1,
    source: { ...source },
    coverage: {
      eligible,
      linked: linked.size,
      rate: eligible ? linked.size / eligible : 0,
    },
    records,
  };
}

export function utilizationRowsForExam(slice, examNumber) {
  const key = exactKey(examNumber);
  if (!key || !slice || !Array.isArray(slice.records)) return [];
  return slice.records.filter((record) => record.exam_number === key);
}
