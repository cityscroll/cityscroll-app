// Civil Service List (Active) vx8i-nprf — exam-level aggregates only.
//
// PII HARD RULE: never index or return per-applicant rows, names, or ranks.
// Input records must already be group-by aggregates (list_count, dates, title_count).
//
// Measured 2026-07-30 (see site/data/exam_sources/verification_receipts/
// civil_service_list_closed_exams_2026-07-30.json):
//
//   Closed annual exams (application_period_end_date < 2026-07-30):
//     exam_no overlap with list presence 44.54% (494 / 1,109) — above ~30%.
//   Open annual exams: 0% (series mismatch; open schedule is 7xxx vs list mix).
//
// Verdict: ship post-list aggregate depth on exam outcomes for closed exams with
// list presence. Individual results stay not_published.

/** Normalize exam numbers for join (zero-pad and strip leading zeros). */
export function examNumberKeys(value) {
  const s = String(value || "").trim();
  if (!s) return [];
  const keys = new Set([s]);
  if (/^\d+$/.test(s)) {
    keys.add(s.replace(/^0+/, "") || "0");
    if (s.length <= 4) keys.add(s.padStart(4, "0"));
    if (s.length <= 5) keys.add(s.padStart(5, "0"));
  }
  return [...keys];
}

/**
 * Build an exam_number → aggregate index from privacy-safe aggregate rows.
 * @param {Array<{exam_number?: string, exam_no?: string, exam_no_raw?: string, list_count?: number|string, established_date?: string|null, extension_date?: string|null, title_count?: number|string}>} records
 */
export function buildListAggregateIndex(records) {
  const byKey = new Map();
  for (const row of records || []) {
    const raw = String(row.exam_number || row.exam_no || row.exam_no_raw || "").trim();
    if (!raw) continue;
    const listCount = Number(row.list_count || 0);
    if (!Number.isFinite(listCount) || listCount < 0) continue;
    // Reject any accidental PII-shaped fields
    for (const k of Object.keys(row)) {
      if (/first_name|last_name|middle_name|ssn|address|phone|email|list_rank/i.test(k)) {
        throw new Error(`civil service list aggregate must not include PII field: ${k}`);
      }
    }
    const agg = {
      exam_number: raw,
      list_count: listCount,
      established_date: row.established_date ? String(row.established_date).slice(0, 10) : null,
      extension_date: row.extension_date ? String(row.extension_date).slice(0, 10) : null,
      title_count: Number(row.title_count || 0) || 0,
    };
    for (const key of examNumberKeys(raw)) {
      const prev = byKey.get(key);
      if (!prev || agg.list_count > prev.list_count) byKey.set(key, agg);
    }
  }
  return byKey;
}

/**
 * Join an exam_number to list aggregates.
 * @returns {{ exam_number: string, list_count: number, established_date: string|null, extension_date: string|null, title_count: number } | null}
 */
export function joinExamToListAggregate(examNumber, index) {
  if (!index) return null;
  for (const key of examNumberKeys(examNumber)) {
    const hit = index.get(key);
    if (hit) return { ...hit };
  }
  return null;
}

/**
 * Measure exam_no overlap between a set of exam numbers and the list index.
 * @returns {{ joined: number, total: number, rate: number }}
 */
export function measureListPresence(examNumbers, index) {
  const nums = [...new Set((examNumbers || []).map((n) => String(n || "").trim()).filter(Boolean))];
  let joined = 0;
  for (const n of nums) {
    if (joinExamToListAggregate(n, index)) joined += 1;
  }
  const total = nums.length;
  return {
    joined,
    total,
    rate: total ? joined / total : 0,
  };
}
