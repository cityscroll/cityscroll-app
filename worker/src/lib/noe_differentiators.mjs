/**
 * Parse Notice of Examination (NOE) body text into filterable differentiators.
 *
 * Interface preference (documented for product):
 * 1. NYC Open Data — schedule/list only (`4ptz-hmtc`, `vx8i-nprf`); no NOE body corpus.
 * 2. OASys bulk JSON `GET /OASysWeb/api/Exam/GetActiveExams` — fee, promotional flag,
 *    examParts (EEE / MC / …), PDF URL. Best structured bulk for open exams.
 * 3. OASys NOE HTML pages (`/OASysWeb/noe?examId=`) — server-rendered full notice text;
 *    polite build-time parse (cached densify), same family as City Record body extract.
 *
 * Pure: no fetch. Provenance on every filled field; honest null when labels absent.
 */

import {
  parseNoeFeeSalaryFromBody,
  toMoneyAmount,
} from "./noe_fee_salary.mjs";

/** OASys partTypeCode → product exam_format token. */
export const OASY_PART_TYPE_TO_FORMAT = Object.freeze({
  EEE: "education_experience",
  MC: "multiple_choice",
  // Observed / reserved codes — map when present without inventing.
  WR: "written",
  PT: "physical",
  OR: "oral",
  PR: "practical",
});

export const EXAM_FORMATS = Object.freeze([
  "education_experience",
  "multiple_choice",
  "physical",
  "written",
  "oral",
  "practical",
  "mixed",
  "other",
]);

export const SALARY_BANDS = Object.freeze([
  "under_45k",
  "45k_60k",
  "60k_80k",
  "80k_plus",
  "unknown",
]);

export const FEE_LEVELS = Object.freeze([
  "none",
  "low", // 1–40
  "mid", // 41–70
  "high", // 71+
  "unknown",
]);

/** Generic fee-waiver phrasing that repeats across most DCAS NOEs (boilerplate). */
const GENERIC_FEE_WAIVER_RE =
  /veterans?|unemployed|public assistance|supplemental security|high school students?|first-time test takers?/i;

const BOILERPLATE_PHRASE_HINTS = Object.freeze([
  "you are responsible for determining whether",
  "application fee will not be refunded",
  "candidates paying the application fee with a credit",
  "nonrefundable 2.00% service fee",
  "review the civil service guidance for veterans",
  "you must be able to understand and be understood in english",
  "proof of identity",
  "immigration reform and control act",
  "penal law",
  "exam site admission",
  "use of electronic devices",
]);

/**
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function plainNoeText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map OASys examParts array to a product exam_format.
 * @param {Array<object>|null|undefined} examParts
 * @returns {{ exam_format: string|null, part_type_codes: string[], provenance: object|null }}
 */
export function examFormatFromOasysParts(examParts) {
  const codes = [];
  for (const part of examParts || []) {
    const code = String(part?.partTypeCode || part?.part_type_code || "").trim().toUpperCase();
    if (code) codes.push(code);
  }
  const unique = [...new Set(codes)];
  if (!unique.length) {
    return { exam_format: null, part_type_codes: [], provenance: null };
  }
  const mapped = unique
    .map((c) => OASY_PART_TYPE_TO_FORMAT[c] || null)
    .filter(Boolean);
  let exam_format = null;
  if (mapped.length === 1) exam_format = mapped[0];
  else if (mapped.length > 1) exam_format = "mixed";
  else exam_format = "other";
  return {
    exam_format,
    part_type_codes: unique,
    provenance: {
      source: "oasys_get_active_exams",
      field: "examParts.partTypeCode",
      codes: unique,
    },
  };
}

/**
 * Infer exam_format from THE TEST section when OASys parts are unavailable.
 * @param {string} text
 * @returns {{ exam_format: string|null, excerpt: string|null }}
 */
export function examFormatFromNoeText(text) {
  const body = plainNoeText(text);
  if (!body) return { exam_format: null, excerpt: null };
  const testSection = body.match(
    /THE\s+TEST\s*:?\s*(.{0,480})/i,
  );
  const window = testSection ? testSection[1] : body.slice(0, 1200);
  const excerpt = testSection ? testSection[0].slice(0, 240) : null;
  const hasEEE = /education\s+and\s+experience\s+exam/i.test(window);
  const hasMC = /multiple[- ]choice/i.test(window);
  const hasPhysical = /\bphysical\b(?:\s+(?:test|exam|agility|performance))?/i.test(window)
    && !/physical\s+performance.*probation/i.test(window);
  const hits = [];
  if (hasEEE) hits.push("education_experience");
  if (hasMC) hits.push("multiple_choice");
  if (hasPhysical && !hasMC && !hasEEE) hits.push("physical");
  if (!hits.length) {
    if (/written\s+test/i.test(window)) return { exam_format: "written", excerpt };
    return { exam_format: null, excerpt };
  }
  if (hits.length === 1) return { exam_format: hits[0], excerpt };
  return { exam_format: "mixed", excerpt };
}

/**
 * @param {number|null|undefined} salaryMin
 * @returns {string}
 */
export function salaryBandFor(salaryMin) {
  const n = Number(salaryMin);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n < 45000) return "under_45k";
  if (n < 60000) return "45k_60k";
  if (n < 80000) return "60k_80k";
  return "80k_plus";
}

/**
 * @param {number|null|undefined} fee
 * @returns {string}
 */
export function feeLevelFor(fee) {
  if (fee == null || fee === "") return "unknown";
  const n = Number(fee);
  if (!Number.isFinite(n)) return "unknown";
  if (n === 0) return "none";
  if (n <= 40) return "low";
  if (n <= 70) return "mid";
  return "high";
}

/**
 * Extract a short qualifications summary from HOW TO QUALIFY / EDUCATION AND EXPERIENCE.
 * @param {string} text
 * @returns {{ qualifications: string|null, excerpt: string|null, no_experience_required: boolean|null, education_level: string|null }}
 */
/** Section headers that end a qualifications capture (case-insensitive). */
const QUALS_STOP_RE =
  /\s+(?:THE\s+TEST\b|Residency\s+Requirement(?:\s+Advisory)?\b|SELECTIVE\s+CERT(?:IFICATION)?\b|Driver(?:'?s)?\s+License\s+Requirement\b|English\s+Requirement\b|PROOF\s+OF\s+IDENTITY\b|Age\s+Requirement\b|Character\s+Requirement\b|Medical\s+Requirement\b|Citizenship\s+Requirement\b|Drug\s+Screening\b|Probationary\s+Period\b|APPLICATION\s+PERIOD\b|HOW\s+TO\s+APPLY\b|You\s+must\s+Final\s+Submit\b|Final\s+Submit\s+your\b)/i;

/**
 * Slice text from a labeled requirements header until the next known section.
 * @param {string} body
 * @param {RegExp} startRe must include a capture group for the body after the label
 * @returns {{ block: string, excerpt: string }|null}
 */
function sliceUntilNextSection(body, startRe) {
  const m = body.match(startRe);
  if (!m || m.index == null) return null;
  const afterLabel = m[1] != null ? m[1] : "";
  const startAt = m.index + m[0].length - afterLabel.length;
  const tail = body.slice(startAt);
  const stop = tail.search(QUALS_STOP_RE);
  let block = (stop >= 0 ? tail.slice(0, stop) : tail.slice(0, 1400)).trim();
  // Drop leading boilerplate ("It is your responsibility…") when we captured HOW TO QUALIFY whole.
  const eeeInner = block.match(
    /EDUCATION\s+AND\s+EXPERIENCE\s+REQUIREMENTS?\s*:?\s*([\s\S]+)/i,
  );
  if (eeeInner) block = eeeInner[1].trim();
  if (block.length < 20) return null;
  return {
    block,
    excerpt: body.slice(m.index, m.index + Math.min(280, m[0].length + 80)),
  };
}

export function parseQualificationsBlock(text) {
  const body = plainNoeText(text);
  if (!body) {
    return {
      qualifications: null,
      excerpt: null,
      no_experience_required: null,
      education_level: null,
    };
  }

  let hit =
    sliceUntilNextSection(
      body,
      /EDUCATION\s+AND\s+EXPERIENCE\s+REQUIREMENTS?\s*:?\s*/i,
    )
    || sliceUntilNextSection(
      body,
      /HOW\s+TO\s+QUALIFY\s*:?\s*/i,
    );

  // Police-style age line (only when no EEE block).
  if (!hit) {
    const ageEdu = body.match(
      /\bAge\s+Requirement\s*:\s*(.{20,500}?)(?:\s+(?:Education\s+Requirement|Character|Medical|Residency|THE\s+TEST)\b)/i,
    );
    if (ageEdu) {
      hit = { block: ageEdu[1].trim(), excerpt: ageEdu[0].slice(0, 280) };
    }
  }

  if (!hit) {
    return {
      qualifications: null,
      excerpt: null,
      no_experience_required: null,
      education_level: null,
    };
  }

  const { block, excerpt } = hit;

  // Collapse multi-path lists into a readable one-liner (cap length for cards).
  let qualifications = block
    .replace(/\s*\(\d+\)\s*/g, "; ")
    .replace(/\s{2,}/g, " ")
    .replace(/^;\s*/, "")
    .trim();
  if (qualifications.length > 320) {
    qualifications = `${qualifications.slice(0, 317).trim()}…`;
  }

  const lower = qualifications.toLowerCase();
  const mentionsExperience =
    /\b(?:\d+\s+years?\s+of|years?\s+of\s+(?:full-time\s+)?(?:satisfactory\s+)?experience|work experience|full-time\s+satisfactory\s+experience)\b/i
      .test(qualifications)
    || /\bexperience\b.*\b(?:garage|maintenance|service|performing)\b/i.test(qualifications);
  const pureDegree =
    /\b(baccalaureate|bachelor'?s|associate'?s|high school|ged|diploma)\b/i.test(qualifications)
    && !mentionsExperience
    // College credits alone (police) still education-only, not prior job experience.
    && !/\byears?\s+of\s+(?:honorable\s+)?(?:full-time\s+)?(?:u\.?s\.?\s+)?military\b/i.test(qualifications);
  const noExperienceExplicit =
    /no\s+(?:prior\s+)?(?:work\s+)?experience\s+(?:is\s+)?required/i.test(body)
    || /experience\s+is\s+not\s+required/i.test(body);

  let no_experience_required = null;
  if (noExperienceExplicit || pureDegree) no_experience_required = true;
  else if (mentionsExperience) no_experience_required = false;
  // Degree-or-credits paths with optional military service still need no prior civilian job.
  else if (
    /\b(high school|diploma|college\s+semester\s+credits)\b/i.test(qualifications)
    && !/\b(?:years?\s+of\s+full-time\s+satisfactory\s+experience|work experience)\b/i.test(qualifications)
  ) {
    no_experience_required = true;
  }

  let education_level = null;
  if (/\bbaccalaureate\b|\bbachelor/i.test(lower)) education_level = "bachelors";
  else if (/\bassociate/i.test(lower)) education_level = "associates";
  else if (/\bmaster/i.test(lower)) education_level = "masters";
  else if (/\bhigh school\b|\bged\b|\bequivalen/i.test(lower)) education_level = "high_school";
  else if (/\btrade school\b|\bvocation/i.test(lower)) education_level = "trade";

  return {
    qualifications,
    excerpt,
    no_experience_required,
    education_level,
  };
}

/**
 * @param {string} text
 * @returns {{ residency: string|null, residency_required: boolean|null, excerpt: string|null }}
 */
export function parseResidency(text) {
  const body = plainNoeText(text);
  if (!body) return { residency: null, residency_required: null, excerpt: null };

  const notRequired = body.match(
    /Residency\s+Requirement(?:\s+Advisory)?\s*:?\s*City\s+residency\s+is\s+not\s+required[^.]*\./i,
  );
  if (notRequired) {
    return {
      residency: "City residency is not required for this position.",
      residency_required: false,
      excerpt: notRequired[0].slice(0, 200),
    };
  }

  const police = body.match(
    /Residency\s+Requirement(?:\s+Advisory)?\s*:?\s*(The\s+New\s+York\s+State\s+Public\s+Officers\s+Law[^.]*\.(?:\s*[^.]*counties[^.]*\.)?)/i,
  );
  if (police) {
    const line = police[1].replace(/\s+/g, " ").trim();
    return {
      residency: line.length > 220 ? `${line.slice(0, 217)}…` : line,
      residency_required: true,
      excerpt: police[0].slice(0, 240),
    };
  }

  const advisory = body.match(
    /Residency\s+Requirement(?:\s+Advisory)?\s*:?\s*(.{20,280}?\.)/i,
  );
  if (advisory) {
    const line = advisory[1].replace(/\s+/g, " ").trim();
    const required = !/not\s+required/i.test(line);
    // Generic "might need to be a resident… vary by title" is weak signal.
    const weak = /might\s+need|vary\s+by\s+title/i.test(line);
    return {
      residency: line,
      residency_required: weak ? null : required,
      excerpt: advisory[0].slice(0, 240),
    };
  }
  return { residency: null, residency_required: null, excerpt: null };
}

/**
 * @param {string} text
 * @returns {{ has_selective_certification: boolean, selective_certification_summary: string|null, excerpt: string|null }}
 */
export function parseSelectiveCertification(text) {
  const body = plainNoeText(text);
  if (!body) {
    return {
      has_selective_certification: false,
      selective_certification_summary: null,
      excerpt: null,
    };
  }
  const m = body.match(
    /Selective\s+Certification[^.]*\.\s*(.{0,200})/i,
  );
  if (!m) {
    return {
      has_selective_certification: false,
      selective_certification_summary: null,
      excerpt: null,
    };
  }
  const summary = m[0].replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    has_selective_certification: true,
    selective_certification_summary: summary,
    excerpt: m[0].slice(0, 200),
  };
}

/**
 * Fee-waiver line: keep short distinctive note; mark generic DCAS boilerplate.
 * @param {string} text
 * @param {number|null} fee
 * @returns {{ fee_waiver: string|null, fee_waiver_is_boilerplate: boolean, excerpt: string|null }}
 */
export function parseFeeWaiver(text, fee) {
  const body = plainNoeText(text);
  if (fee === 0) {
    return {
      fee_waiver: "No application fee is charged for this exam.",
      fee_waiver_is_boilerplate: false,
      excerpt: "fee=0",
    };
  }
  if (!body) {
    return { fee_waiver: null, fee_waiver_is_boilerplate: false, excerpt: null };
  }
  const m = body.match(
    /Application\s+Fee\s*:\s*\$?[\d.,]+\s*(.{0,320}?)(?:\s+WHAT\s+THE\s+JOB|\s+THE\s+SALARY|\s+HOW\s+TO\s+QUALIFY)/i,
  );
  if (!m) {
    return { fee_waiver: null, fee_waiver_is_boilerplate: false, excerpt: null };
  }
  const tail = m[1].replace(/\s+/g, " ").trim();
  if (/may\s+qualify|fee\s+waiver|veterans/i.test(tail) && GENERIC_FEE_WAIVER_RE.test(tail)) {
    return {
      fee_waiver:
        "Veterans, unemployed applicants, NYC high school students, first-time test takers, and applicants receiving public assistance or SSI may qualify for a waiver.",
      fee_waiver_is_boilerplate: true,
      excerpt: m[0].slice(0, 200),
    };
  }
  if (tail.length > 40) {
    return {
      fee_waiver: tail.length > 240 ? `${tail.slice(0, 237)}…` : tail,
      fee_waiver_is_boilerplate: false,
      excerpt: m[0].slice(0, 200),
    };
  }
  return { fee_waiver: null, fee_waiver_is_boilerplate: false, excerpt: null };
}

/**
 * Job summary one-liner from WHAT THE JOB INVOLVES.
 * @param {string} text
 * @returns {{ summary: string|null, excerpt: string|null }}
 */
export function parseJobSummary(text) {
  const body = plainNoeText(text);
  if (!body) return { summary: null, excerpt: null };
  const m = body.match(
    /WHAT\s+THE\s+JOB\s+INVOLVES\s*:?\s*(.{40,320}?)(?:\s+\(|\s+Special\s+Working|\s+THE\s+SALARY|\s+HOW\s+TO\s+QUALIFY)/i,
  );
  if (!m) return { summary: null, excerpt: null };
  let summary = m[1].replace(/\s+/g, " ").trim();
  // First sentence-ish
  const period = summary.indexOf(". ");
  if (period > 40 && period < 220) summary = summary.slice(0, period + 1);
  if (summary.length > 220) summary = `${summary.slice(0, 217)}…`;
  return { summary, excerpt: m[0].slice(0, 200) };
}

/**
 * Full differentiator parse from NOE body (+ optional OASys parts).
 * @param {string} bodyText
 * @param {{ examParts?: Array<object>, source_url?: string|null, oasys_exam_id?: string|null }} [meta]
 */
export function parseNoeDifferentiators(bodyText, meta = {}) {
  const text = plainNoeText(bodyText);
  const money = parseNoeFeeSalaryFromBody(text);
  const fromParts = examFormatFromOasysParts(meta.examParts);
  const fromText = examFormatFromNoeText(text);
  const exam_format = fromParts.exam_format || fromText.exam_format;
  const quals = parseQualificationsBlock(text);
  const residency = parseResidency(text);
  const selective = parseSelectiveCertification(text);
  const waiver = parseFeeWaiver(text, money.fee);
  const job = parseJobSummary(text);

  const provenance = {};
  const field = (name, value, prov) => {
    if (value == null || value === "") return;
    provenance[name] = prov;
  };

  if (money.fee != null) {
    field("fee", money.fee, {
      source: "noe_body",
      method: "labeled_application_fee",
      excerpt: money.fee_excerpt,
      source_url: meta.source_url || null,
    });
  }
  if (money.salary_min != null) {
    field("salary_min", money.salary_min, {
      source: "noe_body",
      method: "labeled_minimum_salary",
      excerpt: money.salary_excerpt,
      source_url: meta.source_url || null,
    });
  }
  if (money.salary_max != null) {
    field("salary_max", money.salary_max, {
      source: "noe_body",
      method: "labeled_salary_range",
      excerpt: money.salary_excerpt,
      source_url: meta.source_url || null,
    });
  }
  if (exam_format) {
    field(
      "exam_format",
      exam_format,
      fromParts.exam_format
        ? fromParts.provenance
        : {
          source: "noe_body",
          method: "the_test_section",
          excerpt: fromText.excerpt,
          source_url: meta.source_url || null,
        },
    );
  }
  if (quals.qualifications) {
    field("qualifications", quals.qualifications, {
      source: "noe_body",
      method: "education_experience_or_how_to_qualify",
      excerpt: quals.excerpt,
      source_url: meta.source_url || null,
    });
  }
  if (quals.no_experience_required != null) {
    field("no_experience_required", quals.no_experience_required, {
      source: "noe_body",
      method: "qualifications_inference",
      source_url: meta.source_url || null,
    });
  }
  if (residency.residency) {
    field("residency", residency.residency, {
      source: "noe_body",
      method: "residency_requirement_advisory",
      excerpt: residency.excerpt,
      source_url: meta.source_url || null,
    });
  }
  if (selective.has_selective_certification) {
    field("has_selective_certification", true, {
      source: "noe_body",
      method: "selective_certification_heading",
      excerpt: selective.excerpt,
      source_url: meta.source_url || null,
    });
  }
  if (waiver.fee_waiver) {
    field("fee_waiver", waiver.fee_waiver, {
      source: "noe_body",
      method: waiver.fee_waiver_is_boilerplate ? "generic_fee_waiver_compress" : "fee_block",
      excerpt: waiver.excerpt,
      source_url: meta.source_url || null,
    });
  }
  if (job.summary) {
    field("summary", job.summary, {
      source: "noe_body",
      method: "what_the_job_involves",
      excerpt: job.excerpt,
      source_url: meta.source_url || null,
    });
  }

  const fee = money.fee;
  const salary_min = money.salary_min;
  const salary_max = money.salary_max;

  return {
    fee,
    salary_min,
    salary_max,
    salary_note: money.salary_note,
    salary_band: salaryBandFor(salary_min),
    fee_level: feeLevelFor(fee),
    exam_format,
    part_type_codes: fromParts.part_type_codes,
    qualifications: quals.qualifications,
    education_level: quals.education_level,
    no_experience_required: quals.no_experience_required,
    residency: residency.residency,
    residency_required: residency.residency_required,
    has_selective_certification: selective.has_selective_certification,
    selective_certification_summary: selective.selective_certification_summary,
    fee_waiver: waiver.fee_waiver,
    fee_waiver_is_boilerplate: waiver.fee_waiver_is_boilerplate,
    summary: job.summary,
    test_method: testMethodLabel(exam_format),
    oasys_exam_id: meta.oasys_exam_id || null,
    source_url: meta.source_url || null,
    provenance,
  };
}

/**
 * @param {string|null} exam_format
 * @returns {string|null}
 */
export function testMethodLabel(exam_format) {
  switch (exam_format) {
    case "education_experience":
      return "Education and experience exam";
    case "multiple_choice":
      return "Multiple-choice test";
    case "physical":
      return "Physical test";
    case "written":
      return "Written test";
    case "oral":
      return "Oral test";
    case "practical":
      return "Practical test";
    case "mixed":
      return "Multiple test parts — see the NOE";
    default:
      return null;
  }
}

/**
 * Cross-corpus frequency: fields identical (normalized) on ≥ threshold of rows
 * with a value are BOILERPLATE; rarer values are DISTINCTIVE.
 *
 * @param {Array<object>} records parsed differentiator rows
 * @param {{ threshold?: number, fields?: string[] }} [opts]
 * @returns {{
 *   field_stats: object,
 *   boilerplate_fields: string[],
 *   distinctive_fields: string[],
 *   per_record_leads: object
 * }}
 */
export function classifyCorpusBoilerplate(records, opts = {}) {
  const threshold = opts.threshold ?? 0.55;
  const fields = opts.fields || [
    "exam_format",
    "fee_level",
    "salary_band",
    "no_experience_required",
    "residency_required",
    "fee_waiver_is_boilerplate",
    "has_selective_certification",
    "education_level",
  ];
  const n = (records || []).length || 1;
  const field_stats = {};
  const boilerplate_fields = [];
  const distinctive_fields = [];

  for (const field of fields) {
    const counts = new Map();
    let present = 0;
    for (const row of records || []) {
      const v = row?.[field];
      if (v == null || v === "") continue;
      present += 1;
      const key = String(v);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let top = null;
    let topCount = 0;
    for (const [key, count] of counts) {
      if (count > topCount) {
        top = key;
        topCount = count;
      }
    }
    const share = present ? topCount / present : 0;
    const isBoilerplate = present >= 2 && share >= threshold;
    field_stats[field] = {
      present,
      distinct_values: counts.size,
      top_value: top,
      top_share: present ? Number(share.toFixed(3)) : 0,
      is_boilerplate: isBoilerplate,
    };
    if (isBoilerplate) boilerplate_fields.push(field);
    else if (present) distinctive_fields.push(field);
  }

  // Phrase-level: mark fee_waiver boilerplate when the generic flag is common.
  if (field_stats.fee_waiver_is_boilerplate?.top_value === "true"
    && field_stats.fee_waiver_is_boilerplate.top_share >= threshold) {
    if (!boilerplate_fields.includes("fee_waiver")) boilerplate_fields.push("fee_waiver");
  }

  const per_record_leads = {};
  for (const row of records || []) {
    const id = String(row.exam_number || row.oasys_exam_id || "");
    if (!id) continue;
    const leads = [];
    // Lead order: format → fee surprise → salary → quals experience → residency
    if (row.exam_format && !field_stats.exam_format?.is_boilerplate) {
      leads.push({ key: "exam_format", value: row.exam_format });
    } else if (
      row.exam_format
      && field_stats.exam_format?.is_boilerplate
      && String(row.exam_format) !== String(field_stats.exam_format.top_value)
    ) {
      leads.push({ key: "exam_format", value: row.exam_format });
    }
    if (row.fee_level === "none" || row.fee === 0) {
      leads.push({ key: "fee", value: 0 });
    } else if (
      row.fee_level
      && field_stats.fee_level?.is_boilerplate
      && String(row.fee_level) !== String(field_stats.fee_level.top_value)
    ) {
      leads.push({ key: "fee_level", value: row.fee_level });
    }
    if (row.salary_min != null) {
      leads.push({ key: "salary_min", value: row.salary_min });
    }
    if (row.no_experience_required === true) {
      leads.push({ key: "no_experience_required", value: true });
    } else if (row.no_experience_required === false) {
      leads.push({ key: "experience_required", value: true });
    }
    if (row.residency_required === true) {
      leads.push({ key: "residency_required", value: true });
    } else if (
      row.residency_required === false
      && !field_stats.residency_required?.is_boilerplate
    ) {
      leads.push({ key: "residency_not_required", value: true });
    }
    if (row.qualifications) {
      leads.push({ key: "qualifications", value: row.qualifications });
    }
    per_record_leads[id] = leads.slice(0, 5);
  }

  return {
    field_stats,
    boilerplate_fields,
    distinctive_fields,
    per_record_leads,
    boilerplate_phrase_hints: BOILERPLATE_PHRASE_HINTS,
  };
}

/**
 * Merge densify differentiators onto a staffing exam row (fill-only).
 * @param {object} exam
 * @param {object|null|undefined} densifyRow
 */
export function applyNoeDifferentiatorRecord(exam, densifyRow) {
  if (!exam || !densifyRow) return exam;
  const out = { ...exam };
  let changed = false;
  const fill = (key, value) => {
    if (value == null || value === "") return;
    if (out[key] == null || out[key] === "") {
      out[key] = value;
      changed = true;
    }
  };
  // Money: never overwrite non-null fee (incl 0) or salary_min.
  if (out.fee == null && densifyRow.fee != null) {
    out.fee = densifyRow.fee;
    changed = true;
  }
  fill("salary_min", densifyRow.salary_min);
  fill("salary_max", densifyRow.salary_max);
  fill("salary_note", densifyRow.salary_note);
  fill("qualifications", densifyRow.qualifications);
  fill("test_method", densifyRow.test_method);
  fill("summary", densifyRow.summary);
  fill("fee_waiver", densifyRow.fee_waiver);
  fill("exam_format", densifyRow.exam_format);
  fill("education_level", densifyRow.education_level);
  fill("residency", densifyRow.residency);
  if (out.no_experience_required == null && densifyRow.no_experience_required != null) {
    out.no_experience_required = densifyRow.no_experience_required;
    changed = true;
  }
  if (out.residency_required == null && densifyRow.residency_required != null) {
    out.residency_required = densifyRow.residency_required;
    changed = true;
  }
  if (out.has_selective_certification == null && densifyRow.has_selective_certification) {
    out.has_selective_certification = true;
    changed = true;
  }
  fill("selective_certification_summary", densifyRow.selective_certification_summary);

  // Always recompute filter facets from merged amounts/format.
  const salaryMin = out.salary_min;
  const fee = out.fee;
  out.salary_band = salaryBandFor(salaryMin);
  out.fee_level = feeLevelFor(fee);
  if (densifyRow.exam_format && !out.exam_format) out.exam_format = densifyRow.exam_format;

  // Card lead keys from densify (precomputed) or recompute lightly.
  if (Array.isArray(densifyRow.card_leads) && densifyRow.card_leads.length) {
    out.card_leads = densifyRow.card_leads;
    changed = true;
  }
  if (densifyRow.provenance && typeof densifyRow.provenance === "object") {
    out.differentiator_provenance = densifyRow.provenance;
    changed = true;
  }
  if (densifyRow.fee_waiver_is_boilerplate != null) {
    out.fee_waiver_is_boilerplate = densifyRow.fee_waiver_is_boilerplate;
    changed = true;
  }

  if (!changed && densifyRow.exam_format == null && densifyRow.fee == null) return exam;

  const sources = new Set([...(out.sources || [])]);
  sources.add("dcas-noe-differentiators");
  if (densifyRow.source_interface) sources.add(String(densifyRow.source_interface));
  out.sources = [...sources];
  out.noe_differentiators = {
    densify_method: densifyRow.densify_method || "noe_html_body",
    source_url: densifyRow.source_url || null,
    oasys_exam_id: densifyRow.oasys_exam_id || null,
  };
  return out;
}

/**
 * Stamp filter facets + card leads when densify is absent but row already has fields.
 * @param {object} exam
 * @param {object|null} [corpusLeads] map exam_number → lead array
 */
export function stampExamDifferentiatorFacets(exam, corpusLeads = null) {
  if (!exam || typeof exam !== "object") return exam;
  const out = { ...exam };
  out.salary_band = salaryBandFor(out.salary_min);
  out.fee_level = feeLevelFor(out.fee);
  if (!out.exam_format && out.test_method) {
    const tm = String(out.test_method).toLowerCase();
    if (/education\s+and\s+experience/.test(tm)) out.exam_format = "education_experience";
    else if (/multiple[- ]choice/.test(tm)) out.exam_format = "multiple_choice";
    else if (/physical/.test(tm)) out.exam_format = "physical";
  }
  if ((!out.card_leads || !out.card_leads.length) && corpusLeads) {
    const id = String(out.exam_number || "").padStart(4, "0");
    const leads = corpusLeads[id] || corpusLeads[out.exam_number];
    if (leads) out.card_leads = leads;
  }
  if (!out.card_leads || !out.card_leads.length) {
    out.card_leads = buildFallbackCardLeads(out);
  }
  return out;
}

/**
 * @param {object} exam
 * @returns {Array<{key: string, value: *}>}
 */
export function buildFallbackCardLeads(exam) {
  const leads = [];
  if (exam.exam_format) leads.push({ key: "exam_format", value: exam.exam_format });
  if (exam.fee === 0) leads.push({ key: "fee", value: 0 });
  else if (exam.fee != null) leads.push({ key: "fee", value: exam.fee });
  if (exam.salary_min != null) leads.push({ key: "salary_min", value: exam.salary_min });
  if (exam.no_experience_required === true) {
    leads.push({ key: "no_experience_required", value: true });
  } else if (exam.qualifications) {
    leads.push({ key: "qualifications", value: exam.qualifications });
  }
  if (exam.residency_required === true) {
    leads.push({ key: "residency_required", value: true });
  }
  return leads.slice(0, 5);
}

/**
 * Filter helpers for the staffing guide (client + tests).
 * @param {object} exam
 * @param {object} filters
 */
export function examMatchesDifferentiatorFilters(exam, filters = {}) {
  if (!exam) return false;
  if (filters.format && filters.format !== "all") {
    if (String(exam.exam_format || "") !== String(filters.format)) return false;
  }
  if (filters.salary_band && filters.salary_band !== "all") {
    const band = exam.salary_band || salaryBandFor(exam.salary_min);
    if (band !== filters.salary_band) return false;
  }
  if (filters.fee_level && filters.fee_level !== "all") {
    const level = exam.fee_level || feeLevelFor(exam.fee);
    if (level !== filters.fee_level) return false;
  }
  if (filters.no_experience === "yes") {
    if (exam.no_experience_required !== true) return false;
  } else if (filters.no_experience === "no") {
    if (exam.no_experience_required !== false) return false;
  }
  return true;
}

export { toMoneyAmount };
