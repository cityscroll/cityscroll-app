import { emptyScope, routeHashFromScope } from "./scope_v0.mjs";

export const EXAM_FACETS = Object.freeze({
  interest: Object.freeze({ routeKey: "interest", values: [
    "public-safety", "health-care", "engineering-construction", "technology-science",
    "community-social-services", "administration-finance", "trades-operations", "other",
  ] }),
  window: Object.freeze({ routeKey: "window", values: ["actionable", "open", "upcoming", "closed"] }),
  format: Object.freeze({ routeKey: "format", values: [
    "education_experience", "multiple_choice", "physical", "mixed", "written", "oral", "practical", "other",
  ] }),
  salary: Object.freeze({ routeKey: "salary", values: ["under_45k", "45k_60k", "60k_80k", "80k_plus"] }),
  fee: Object.freeze({ routeKey: "fee", values: ["none", "low", "fee-bearing"] }),
  experience: Object.freeze({ routeKey: "experience", values: ["yes", "no"] }),
});

const UNKNOWN = "unknown";

function dateStatus(exam, today) {
  if (!exam?.application_start || !exam?.application_end || !today) return UNKNOWN;
  if (today < exam.application_start) return "upcoming";
  if (today <= exam.application_end) return "open";
  return "closed";
}

/** Return only a publisher-backed or date-derived facet value. Missing facts stay unknown. */
export function examFacetValue(exam, facet, { today = "", statusFor = null } = {}) {
  if (!exam || !EXAM_FACETS[facet]) return UNKNOWN;
  if (facet === "interest") return String(exam.interest_area || "").trim() || UNKNOWN;
  if (facet === "window") {
    const status = typeof statusFor === "function" ? statusFor(exam, today) : dateStatus(exam, today);
    return ["open", "upcoming", "closed"].includes(status) ? status : UNKNOWN;
  }
  if (facet === "format") return String(exam.exam_format || "").trim() || UNKNOWN;
  if (facet === "salary") return String(exam.salary_band || "").trim() || UNKNOWN;
  if (facet === "fee") {
    const level = String(exam.fee_level || "").trim();
    if (!level || level === UNKNOWN) return UNKNOWN;
    if (["none", "low"].includes(level)) return level;
    if (["mid", "high"].includes(level)) return "fee-bearing";
    return UNKNOWN;
  }
  if (facet === "experience") {
    if (typeof exam.no_experience_required !== "boolean") return UNKNOWN;
    return exam.no_experience_required ? "yes" : "no";
  }
  return UNKNOWN;
}

export function examFacetOptionValues(exams, facet, options = {}) {
  const values = new Set((Array.isArray(exams) ? exams : [])
    .map((exam) => examFacetValue(exam, facet, options)));
  const known = EXAM_FACETS[facet]?.values || [];
  const present = known.filter((value) => values.has(value));
  if (values.has(UNKNOWN)) present.push(UNKNOWN);
  return present;
}

/** Mint the typed People scope used by both finder chips and exam-detail pivots. */
export function examFacetHref(filters, facet, value, { language = "en" } = {}) {
  const definition = EXAM_FACETS[facet];
  if (!definition || !value || value === UNKNOWN || (value !== "all" && !definition.values.includes(value))) return "";
  const scope = emptyScope(language);
  scope.facets.domains = ["people"];
  scope.facets.values.view = "guide";
  const current = filters && typeof filters === "object" ? filters : {};
  const currentValues = {
    interest: current.interest,
    eligibility: current.eligibility,
    window: current.window,
    format: current.format,
    salary: current.salary_band,
    fee: current.fee_level,
    experience: current.no_experience,
  };
  for (const [key, currentValue] of Object.entries(currentValues)) {
    if (key === definition.routeKey || currentValue == null || currentValue === "" || currentValue === "all") continue;
    scope.facets.values[key] = currentValue;
  }
  if (value !== "all") scope.facets.values[definition.routeKey] = value;
  return routeHashFromScope(scope, { surface: "people" });
}
