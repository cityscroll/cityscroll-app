/**
 * Reader-facing exam-card copy for non-English UI languages.
 *
 * CityScroll compresses NOE “how to qualify” text into `exam.qualifications`
 * plus category stamps (`education_level`, `no_experience_required`). Browse
 * cards must not pair a translated label with an English value. Prefer a
 * complete localized category sentence; when no translation exists, fail closed
 * to a see-NOE line or omit the value — never a mid-sentence language switch.
 */

export const EXAM_QUAL_I18N = Object.freeze({
  bachelors: "career_qual_bachelors",
  associates: "career_qual_associates",
  masters: "career_qual_masters",
  high_school: "career_qual_high_school",
  high_school_plus: "career_qual_high_school_plus",
  education_and_experience: "career_qual_education_and_experience",
  experience: "career_qual_experience",
  no_prior_experience: "career_qual_no_prior_experience",
  city_employees: "career_qual_city_employees",
  see_official_noe: "career_qual_see_official_noe",
});

/** English canonicals used to detect missing locale translations (fail closed). */
export const EXAM_QUAL_EN = Object.freeze({
  bachelors: "A bachelor's degree from an accredited college or university.",
  associates: "An associate degree from an accredited college or university.",
  masters: "A master's degree from an accredited college or university.",
  high_school: "A high school diploma or equivalent.",
  high_school_plus:
    "A high school diploma or equivalent, plus the license, medical, or screening requirements in the NOE.",
  education_and_experience:
    "Education and experience requirements apply — see the official NOE for every path.",
  experience: "Prior work experience is required — see the official NOE for details.",
  no_prior_experience: "No prior experience is required.",
  city_employees: "Open to eligible City employees only — see the official NOE.",
  see_official_noe: "See the official Notice of Examination for who may qualify.",
});

export const EXAM_RESIDENCY_EN = Object.freeze({
  not_required: "City residency is not required for this position.",
  may_be_required: "City residency may be required — see the official NOE.",
});

export const EXAM_FEE_WAIVER_EN = Object.freeze({
  none: "No application fee is charged for this exam.",
  boilerplate:
    "Fee waivers may apply for veterans, unemployed applicants, students, first-time test takers, and public-assistance recipients.",
});

const KNOWN_EN_BACHELORS = /^a\s+(?:bachelor'?s|baccalaureate)\s+degree\b/i;
const KNOWN_EN_ASSOCIATES = /^an?\s+associate'?s?\s+degree\b/i;
const KNOWN_EN_MASTERS = /^an?\s+master'?s\s+degree\b/i;
const KNOWN_EN_HS = /^a\s+high\s+school\s+diploma\b/i;

function clean(value) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text || null;
}

function mentionsExperience(text) {
  const q = String(text || "");
  return (
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b/i.test(q)
    || /\byears?\s+of\s+(?:full-time\s+)?(?:satisfactory\s+)?experience\b/i.test(q)
    || /\b(?:work|maintenance|service|automotive|performing)\s+experience\b/i.test(q)
    || /\bexperience\b.*\b(?:garage|maintenance|service|performing|paths?)\b/i.test(q)
    || /\bdegree plus experience\b/i.test(q)
    || /\beducation and experience\b/i.test(q)
  );
}

function mentionsLicenseOrScreen(text) {
  return /\b(?:license|medical|psychological|screening|certificate|emt|citizenship|appointment requirements)\b/i
    .test(String(text || ""));
}

function mentionsEducationPath(text) {
  return /\b(?:degree|diploma|college|university|education|graduate study|trade or technical)\b/i
    .test(String(text || ""));
}

/**
 * Map an exam row to a normalized eligibility category for reader copy.
 * @param {object} exam
 * @returns {keyof typeof EXAM_QUAL_I18N | null}
 */
export function classifyExamQualificationCategory(exam) {
  if (!exam || typeof exam !== "object") return null;
  const quals = clean(exam.qualifications);
  const education = clean(exam.education_level);
  const noExp = exam.no_experience_required;
  const eligibility = clean(exam.eligibility);

  if (!quals) {
    if (eligibility === "promotion") return "city_employees";
    if (noExp === true) return "no_prior_experience";
    if (noExp === false) return "experience";
    return null;
  }

  const exp = mentionsExperience(quals);
  const license = mentionsLicenseOrScreen(quals);
  const multiPath =
    /\bseveral paths\b/i.test(quals)
    || /\ballowed combination\b/i.test(quals)
    || /\bincluding a .+ degree plus\b/i.test(quals);

  if (eligibility === "promotion" && !exp && !education) return "city_employees";

  if (education === "bachelors" && !exp) return "bachelors";
  if (education === "associates" && !exp) return "associates";
  if (education === "masters" && !exp) return "masters";
  if (education === "high_school" && license && !exp) return "high_school_plus";
  if (education === "high_school" && !exp) return "high_school";
  if (
    (education === "bachelors" || education === "associates" || education === "masters"
      || education === "high_school" || education === "trade")
    && exp
  ) {
    return "education_and_experience";
  }
  if (multiPath || (exp && mentionsEducationPath(quals))) return "education_and_experience";
  if (exp) return "experience";

  if (KNOWN_EN_BACHELORS.test(quals)) return "bachelors";
  if (KNOWN_EN_ASSOCIATES.test(quals)) return "associates";
  if (KNOWN_EN_MASTERS.test(quals)) return "masters";
  if (KNOWN_EN_HS.test(quals) && license) return "high_school_plus";
  if (KNOWN_EN_HS.test(quals)) return "high_school";
  if (noExp === true && !exp) return "no_prior_experience";
  if (noExp === false) return "experience";

  // Still have source-derived prose we could not classify — fail closed.
  return "see_official_noe";
}

/**
 * @param {(key: string, vars?: object) => string} t
 * @param {string} lang
 * @param {string} key
 * @param {string} englishCanonical
 */
export function translationAvailable(t, lang, key, englishCanonical) {
  if (!t || typeof t !== "function") return false;
  if (!lang || lang === "en") return true;
  const got = t(key);
  if (got == null || got === "" || got === key) return false;
  if (englishCanonical && got === englishCanonical) return false;
  return true;
}

function resolveCategoryText(category, { lang, t }) {
  const key = EXAM_QUAL_I18N[category];
  const english = EXAM_QUAL_EN[category];
  if (!key) return null;
  if (!lang || lang === "en") return english;
  if (!translationAvailable(t, lang, key, english)) return null;
  return t(key);
}

/**
 * Localized (or English-source) who-may-qualify prose for exam cards.
 * @returns {{ text: string, category: string|null, source: "localized"|"en_source"|"fail_safe", sourceText: string|null }|null}
 */
export function examQualificationCopy(exam, { lang = "en", t } = {}) {
  const sourceText = clean(exam?.qualifications);
  const category = classifyExamQualificationCategory(exam);
  if (!sourceText && !category) return null;

  if (!lang || lang === "en") {
    if (sourceText) {
      return { text: sourceText, category, source: "en_source", sourceText };
    }
    const en = category ? EXAM_QUAL_EN[category] : null;
    return en
      ? { text: en, category, source: "localized", sourceText: null }
      : null;
  }

  // Non-English: never emit raw English under a translated label.
  if (category) {
    const localized = resolveCategoryText(category, { lang, t });
    if (localized) {
      return {
        text: localized,
        category,
        source: category === "see_official_noe" ? "fail_safe" : "localized",
        sourceText,
      };
    }
  }

  const fallback = resolveCategoryText("see_official_noe", { lang, t });
  if (fallback) {
    return {
      text: fallback,
      category: "see_official_noe",
      source: "fail_safe",
      sourceText,
    };
  }

  // No safe translated sentence available — omit rather than hybridize.
  return null;
}

export function isFeeWaiverBoilerplateText(text) {
  const body = clean(text);
  if (!body) return false;
  if (/^no application fee is charged for this exam\.?$/i.test(body)) return false;
  return (
    /\bveterans?\b/i.test(body)
    && /\bunemployed\b/i.test(body)
    && /\b(?:public assistance|ssi|supplemental security)\b/i.test(body)
  );
}

export function isNoFeeWaiverText(text) {
  return /^no application fee is charged for this exam\.?$/i.test(clean(text) || "");
}

/**
 * @returns {{ text: string, source: "localized"|"en_source"|"omit", sourceText: string|null }|null}
 */
export function examFeeWaiverCopy(exam, { lang = "en", t } = {}) {
  const sourceText = clean(exam?.fee_waiver);
  const markedBoilerplate = Boolean(exam?.fee_waiver_is_boilerplate);
  const boilerplate = markedBoilerplate || isFeeWaiverBoilerplateText(sourceText);
  const none = isNoFeeWaiverText(sourceText) || (exam?.fee === 0 && !sourceText);

  if (!lang || lang === "en") {
    if (boilerplate) {
      return {
        text: t ? t("career_fee_waiver_boilerplate") : EXAM_FEE_WAIVER_EN.boilerplate,
        source: "localized",
        sourceText,
      };
    }
    if (none || isNoFeeWaiverText(sourceText)) {
      return {
        text: sourceText || EXAM_FEE_WAIVER_EN.none,
        source: sourceText ? "en_source" : "localized",
        sourceText,
      };
    }
    return sourceText ? { text: sourceText, source: "en_source", sourceText } : null;
  }

  if (boilerplate) {
    if (translationAvailable(t, lang, "career_fee_waiver_boilerplate", EXAM_FEE_WAIVER_EN.boilerplate)) {
      return { text: t("career_fee_waiver_boilerplate"), source: "localized", sourceText };
    }
    return null;
  }
  if (none || isNoFeeWaiverText(sourceText)) {
    if (translationAvailable(t, lang, "career_fee_none_charged", EXAM_FEE_WAIVER_EN.none)) {
      return { text: t("career_fee_none_charged"), source: "localized", sourceText };
    }
    return null;
  }
  // Distinctive English fee-waiver prose: do not hybridize under a translated label.
  return null;
}

/**
 * @returns {{ text: string, source: "localized"|"en_source", sourceText: string|null }|null}
 */
export function examResidencyCopy(exam, { lang = "en", t } = {}) {
  const sourceText = clean(exam?.residency);
  const required = exam?.residency_required;
  const notRequired =
    required === false
    || /city residency is not required/i.test(sourceText || "");
  const mayBeRequired =
    required === true
    || /might need to be a resident|must be a resident|residency requirement/i.test(sourceText || "");

  if (!lang || lang === "en") {
    if (sourceText) return { text: sourceText, source: "en_source", sourceText };
    if (notRequired) {
      return { text: EXAM_RESIDENCY_EN.not_required, source: "localized", sourceText: null };
    }
    return null;
  }

  if (notRequired) {
    if (translationAvailable(t, lang, "career_residency_not_required", EXAM_RESIDENCY_EN.not_required)) {
      return { text: t("career_residency_not_required"), source: "localized", sourceText };
    }
    if (translationAvailable(t, lang, "career_diff_no_residency", "City residency not required")) {
      return { text: t("career_diff_no_residency"), source: "localized", sourceText };
    }
    return null;
  }
  if (mayBeRequired) {
    if (translationAvailable(t, lang, "career_residency_may_be_required", EXAM_RESIDENCY_EN.may_be_required)) {
      return { text: t("career_residency_may_be_required"), source: "localized", sourceText };
    }
    return null;
  }
  return null;
}

/**
 * Prefer exam_format chips over free-text test_method under non-English UI.
 * @returns {{ text: string, source: "localized"|"en_source", sourceText: string|null }|null}
 */
export function examTestMethodCopy(exam, { lang = "en", t, formatLabel } = {}) {
  const sourceText = clean(exam?.test_method);
  const format = clean(exam?.exam_format);
  const localizedFormat = typeof formatLabel === "function" && format
    ? clean(formatLabel(format))
    : null;

  if (!lang || lang === "en") {
    if (sourceText) return { text: sourceText, source: "en_source", sourceText };
    if (localizedFormat) return { text: localizedFormat, source: "localized", sourceText: null };
    return null;
  }

  if (localizedFormat) {
    return { text: localizedFormat, source: "localized", sourceText };
  }
  if (format && t && translationAvailable(t, lang, "career_diff_format_other", "See NOE for test format")) {
    return { text: t("career_diff_format_other"), source: "localized", sourceText };
  }
  return null;
}

export function examNoePostedLabel({ lang = "en", t } = {}) {
  const en = "NOE posted";
  if (!lang || lang === "en") return en;
  if (translationAvailable(t, lang, "career_noe_posted", en)) return t("career_noe_posted");
  return en;
}

export function examWindowBandLabel(band, { lang = "en", t } = {}) {
  const key = {
    far: "career_window_band_far",
    approaching: "career_window_band_approaching",
    imminent: "career_window_band_imminent",
  }[band];
  const en = { far: "Later", approaching: "Soon", imminent: "Imminent" }[band] || band;
  if (!key) return band;
  if (!lang || lang === "en") return band; // keep machine band token on EN cards (existing)
  if (translationAvailable(t, lang, key, en)) return t(key);
  return band;
}

/**
 * Build the who-may-qualify HTML line without mixing languages mid-sentence.
 */
export function examQualificationLineHTML(exam, {
  lang = "en",
  t,
  esc = (s) => String(s ?? ""),
  labelKey = "career_diff_quals",
  className = "career-diff-quals",
} = {}) {
  const copy = examQualificationCopy(exam, { lang, t });
  if (!copy?.text) return "";
  const label = esc(t(labelKey));
  const value = esc(copy.text);
  if (copy.source === "en_source" && lang && lang !== "en") {
    // Should not happen — defense in depth.
    return "";
  }
  if (copy.source === "en_source") {
    return `<p class="${className}" lang="en" dir="ltr"><b>${label}</b> ${value}</p>`;
  }
  return `<p class="${className}"><b>${label}</b> ${value}</p>`;
}
