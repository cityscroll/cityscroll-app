/**
 * Build-time OASys examId ↔ DCAS exam_number mapping.
 *
 * OASys internal examId is not the public DCAS exam number (e.g. examId 9619 →
 * exam 6125). The public listing API enumerates open exams with both fields;
 * we join product rows on exact exam number and deep-link to the per-exam NOE
 * page when present. Unmapped rows keep the generic examsforjobs landing.
 */

export const OASY_APPLY_LANDING_URL = "https://www.nyc.gov/examsforjobs";
export const OASY_API_ACTIVE_EXAMS =
  "https://a856-exams.nyc.gov/OASysWeb/api/Exam/GetActiveExams";
export const OASY_NOE_URL_PREFIX =
  "https://a856-exams.nyc.gov/OASysWeb/noe?examId=";
export const OASY_HOST = "a856-exams.nyc.gov";
export const OASY_SOURCE_ID = "oasys-active-exams";

/** Normalize DCAS / OASys exam numbers for join (leading zeros preserved as string digits). */
export function normalizeExamNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // Keep digit runs; pad common 3-digit forms to 4 when entirely numeric.
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (/^\d{1,4}$/.test(digits)) return digits.padStart(4, "0");
  return digits;
}

/**
 * True when a URL is a generic OASys / exams-for-jobs hub (not a per-exam door).
 * @param {string|null|undefined} value
 */
export function isOasysGenericHub(value) {
  if (!value) return false;
  try {
    const u = new URL(String(value));
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    const href = `${host}${path}`.toLowerCase();

    if (/examsforjobs/i.test(href)) return true;
    if (host.includes("nyc.gov") && /\/examsforjobs$/i.test(path)) return true;

    // City redirect shim into OASys.
    if (host.includes("nyc.gov") && /\/redirects\/oasys\.html$/i.test(path)) return true;

    if (host === OASY_HOST || host.endsWith(".nyc.gov") && host.includes("exams")) {
      // Root, home, exams list (no examId), login/register — all hubs.
      if (
        path === "/"
        || path === "/OASysWeb"
        || path === "/OASysWeb/home"
        || path === "/OASysWeb/exams"
        || path === "/OASysWeb/login"
        || path === "/OASysWeb/register"
        || path === "/oasysweb"
        || path === "/oasysweb/home"
        || path === "/oasysweb/exams"
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * True when URL is a per-exam OASys NOE page (examId query or path).
 * @param {string|null|undefined} value
 */
export function isOasysNoeDeepLink(value) {
  if (!value) return false;
  try {
    const u = new URL(String(value));
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (!(host === OASY_HOST || host.includes("a856-exams"))) return false;
    const path = u.pathname || "";
    if (/\/noe$/i.test(path.replace(/\/+$/, "")) && u.searchParams.get("examId")) {
      return /^\d+$/.test(String(u.searchParams.get("examId")));
    }
    // PDF path published on the listing: /OASysWeb/noe/20266125000.pdf — still per-exam.
    if (/\/noe\/[^/]+\.pdf$/i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Build the human-facing per-exam NOE webpage URL from an OASys examId. */
export function oasysNoeUrl(examId) {
  const id = String(examId ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  return `${OASY_NOE_URL_PREFIX}${encodeURIComponent(id)}`;
}

/**
 * Normalize one GetActiveExams row into a join record.
 * @param {object} row
 */
export function normalizeOasysActiveExam(row) {
  if (!row || typeof row !== "object") return null;
  const examId = row.examId ?? row.ExamId ?? row.exam_id;
  const examNumber = normalizeExamNumber(row.examNumber ?? row.ExamNumber ?? row.exam_number);
  if (examId == null || examId === "" || !examNumber) return null;
  const idStr = String(examId).trim();
  if (!/^\d+$/.test(idStr)) return null;
  const title = String(row.title ?? row.Title ?? "").trim() || null;
  const noePageUrl = oasysNoeUrl(idStr);
  const noePdfUrl = typeof row.noeUrl === "string" && /^https:\/\//i.test(row.noeUrl)
    ? row.noeUrl
    : null;
  return {
    exam_number: examNumber,
    oasys_exam_id: idStr,
    title,
    is_promotional: Boolean(row.isPromotional ?? row.IsPromotional),
    filing_start: row.filingStart ? String(row.filingStart).slice(0, 10) : null,
    filing_end: row.filingEnd ? String(row.filingEnd).slice(0, 10) : null,
    filing_fee: row.filingFee == null ? null : Number(row.filingFee),
    noe_page_url: noePageUrl,
    noe_pdf_url: noePdfUrl,
    // Kinetic apply handoff: the per-exam NOE page is the public door (apply still
    // requires an OASys account after reading the notice).
    official_application_url: noePageUrl,
  };
}

/**
 * @param {Array<object>|object} payload GetActiveExams JSON (array or wrapped)
 * @returns {{ records: object[], by_exam_number: Map<string, object>, summary: object }}
 */
export function buildOasysExamMap(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.exams)
      ? payload.exams
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
  const records = [];
  const by_exam_number = new Map();
  let skipped = 0;
  for (const row of rows) {
    const norm = normalizeOasysActiveExam(row);
    if (!norm) {
      skipped += 1;
      continue;
    }
    // Prefer open-competitive over promotional when the same exam_number appears twice.
    const prior = by_exam_number.get(norm.exam_number);
    if (prior && prior.is_promotional === false && norm.is_promotional) {
      skipped += 1;
      continue;
    }
    by_exam_number.set(norm.exam_number, norm);
  }
  for (const rec of by_exam_number.values()) records.push(rec);
  records.sort((a, b) => a.exam_number.localeCompare(b.exam_number));
  return {
    records,
    by_exam_number,
    summary: {
      input_rows: rows.length,
      mapped: records.length,
      skipped,
    },
  };
}

/**
 * Stamp OASys deep-link fields onto a staffing exam row.
 * Never overwrites a non-hub publisher official_application_url already present.
 * @param {object} exam
 * @param {Map<string, object>|object|null} mapByNumber
 */
export function attachOasysDeepLink(exam, mapByNumber) {
  if (!exam || typeof exam !== "object") return exam;
  const num = normalizeExamNumber(exam.exam_number);
  if (!num) {
    return {
      ...exam,
      application_handoff_mode: "landing",
    };
  }
  const map = mapByNumber instanceof Map
    ? mapByNumber
    : mapByNumber && typeof mapByNumber === "object"
      ? new Map(Object.entries(mapByNumber))
      : null;
  const hit = map?.get(num) || null;
  if (!hit) {
    // Unmapped: keep generic landing; do not invent examId.
    const out = { ...exam };
    if (!out.official_application_url || isOasysGenericHub(out.official_application_url)) {
      out.official_application_url = OASY_APPLY_LANDING_URL;
    }
    out.application_handoff_mode = isOasysNoeDeepLink(out.official_application_url)
      ? "deep"
      : "landing";
    return out;
  }

  const deepUrl = hit.official_application_url || hit.noe_page_url || oasysNoeUrl(hit.oasys_exam_id);
  const out = {
    ...exam,
    oasys_exam_id: hit.oasys_exam_id,
    oasys_noe_url: deepUrl,
    application_handoff_mode: "deep",
  };
  const existing = exam.official_application_url;
  if (!existing || isOasysGenericHub(existing)) {
    out.official_application_url = deepUrl;
  } else if (isOasysNoeDeepLink(existing)) {
    out.official_application_url = existing;
  } else {
    // Non-OASys publisher URL already present — keep it, still stamp ids for diagnostics.
    out.official_application_url = existing;
    out.application_handoff_mode = "deep";
  }
  const sources = new Set([...(out.sources || []), OASY_SOURCE_ID]);
  out.sources = [...sources];
  return out;
}

/**
 * Resolve the apply handoff URL for an exam-like matter (shared by action rail + cards).
 * Prefers official_application_url when it is not a generic hub; else oasys_noe_url;
 * else landing.
 */
export function resolveExamApplyUrl(matter, landingUrl = OASY_APPLY_LANDING_URL) {
  if (!matter || typeof matter !== "object") return landingUrl;
  const candidates = [
    matter.official_application_url,
    matter.oasys_noe_url,
    matter.oasys_exam_id ? oasysNoeUrl(matter.oasys_exam_id) : null,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(String(c));
      if (u.protocol !== "https:") continue;
      if (isOasysGenericHub(u.toString())) continue;
      return u.toString();
    } catch {
      continue;
    }
  }
  return landingUrl;
}

/**
 * Materialized map artifact shape committed under site/data/exam_sources/.
 */
export function materializeOasysMapArtifact(payload, options = {}) {
  const built = buildOasysExamMap(payload);
  const fetchedAt = options.fetched_at || new Date().toISOString().slice(0, 10);
  return {
    schema_version: 1,
    source: {
      id: OASY_SOURCE_ID,
      name: "OASys active exams (GetActiveExams)",
      url: OASY_API_ACTIVE_EXAMS,
      listing_page: "https://a856-exams.nyc.gov/OASysWeb/exams",
      noe_url_pattern: `${OASY_NOE_URL_PREFIX}:examId`,
      fetched_at: fetchedAt,
      refresh_cadence: "Rebuild with staffing exams while application windows are open.",
      stale_after_days: 3,
      note: "OASys examId is not the DCAS exam number; join on examNumber from this listing.",
    },
    summary: built.summary,
    records: built.records,
  };
}
