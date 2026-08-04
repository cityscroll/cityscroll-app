/**
 * Civil-service exam interest-area / series taxonomy.
 *
 * Pure helpers over the committed mapping file
 * `site/data/exam_sources/interest_area_taxonomy.json` (data, not code).
 * Tags each exam into a subscribable interest area and builds per-area
 * open-window indexes for the staffing artifact.
 *
 * Alerts that subscribe by interest area are a separate gated product surface —
 * this module only exposes taxonomy + window state for that future card.
 */

export const INTEREST_TAXONOMY_SCHEMA_VERSION = 1;

/** Stable area id order when taxonomy areas are missing order fields. */
export const FALLBACK_INTEREST_AREA_IDS = Object.freeze([
  "public-safety",
  "health-care",
  "engineering-construction",
  "technology-science",
  "community-social-services",
  "administration-finance",
  "trades-operations",
  "other",
]);

/**
 * @param {object|null|undefined} taxonomy
 * @returns {string}
 */
export function defaultInterestArea(taxonomy) {
  const id = taxonomy?.default_area;
  return typeof id === "string" && id ? id : "other";
}

/**
 * Ordered area ids from taxonomy (or fallback list).
 * @param {object|null|undefined} taxonomy
 * @returns {string[]}
 */
export function interestAreaIds(taxonomy) {
  const areas = Array.isArray(taxonomy?.areas) ? taxonomy.areas : [];
  if (!areas.length) return [...FALLBACK_INTEREST_AREA_IDS];
  return areas
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)))
    .map((area) => area.id)
    .filter(Boolean);
}

/**
 * Public area descriptors for the staffing payload (no compiled regexes).
 * @param {object|null|undefined} taxonomy
 * @returns {object[]}
 */
export function publicInterestAreas(taxonomy) {
  const areas = Array.isArray(taxonomy?.areas) ? taxonomy.areas : [];
  if (!areas.length) {
    return FALLBACK_INTEREST_AREA_IDS.map((id, index) => ({
      id,
      label: id,
      description: "",
      subscribable: id !== "other",
      order: (index + 1) * 10,
      i18n_key: null,
    }));
  }
  return areas
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)))
    .map((area) => ({
      id: area.id,
      label: area.label || area.id,
      description: area.description || "",
      subscribable: area.subscribable !== false && area.id !== "other",
      order: Number(area.order) || 0,
      i18n_key: area.i18n_key || null,
    }));
}

/**
 * Compile title rules once per taxonomy load.
 * @param {object|null|undefined} taxonomy
 * @returns {{ area: string, re: RegExp }[]}
 */
export function compileTitleRules(taxonomy) {
  const rules = Array.isArray(taxonomy?.title_rules) ? taxonomy.title_rules : [];
  const compiled = [];
  for (const rule of rules) {
    const area = String(rule?.area || "").trim();
    const pattern = String(rule?.pattern || "");
    if (!area || !pattern) continue;
    const flags = String(rule?.flags || "i");
    try {
      compiled.push({ area, re: new RegExp(pattern, flags) });
    } catch {
      // Fail closed on a bad pattern — skip rather than crash the build.
    }
  }
  return compiled;
}

/**
 * Classify one exam into an interest area id.
 * Precedence: exam_number override → title_code override → first title_rule → default.
 *
 * @param {object|string|null|undefined} examOrTitle — exam row or bare title string
 * @param {object|null|undefined} taxonomy
 * @param {{ compiledRules?: { area: string, re: RegExp }[] }|null} [opts]
 * @returns {string}
 */
export function classifyInterest(examOrTitle, taxonomy, opts = null) {
  const fallback = defaultInterestArea(taxonomy);
  const known = new Set(interestAreaIds(taxonomy));

  const exam = examOrTitle && typeof examOrTitle === "object" ? examOrTitle : null;
  const title = exam
    ? String(exam.title || exam.exam_title || "")
    : String(examOrTitle || "");
  const examNumber = exam ? String(exam.exam_number || "").trim() : "";
  const titleCode = exam ? String(exam.title_code || "").trim() : "";

  const examOverrides = taxonomy?.exam_overrides && typeof taxonomy.exam_overrides === "object"
    ? taxonomy.exam_overrides
    : {};
  if (examNumber && examOverrides[examNumber]) {
    const id = String(examOverrides[examNumber]);
    return known.has(id) ? id : fallback;
  }

  const codeOverrides = taxonomy?.title_code_overrides && typeof taxonomy.title_code_overrides === "object"
    ? taxonomy.title_code_overrides
    : {};
  if (titleCode && codeOverrides[titleCode]) {
    const id = String(codeOverrides[titleCode]);
    return known.has(id) ? id : fallback;
  }

  const rules = Array.isArray(opts?.compiledRules)
    ? opts.compiledRules
    : compileTitleRules(taxonomy);
  for (const rule of rules) {
    if (rule.re.test(title)) {
      return known.has(rule.area) ? rule.area : fallback;
    }
  }
  return fallback;
}

/**
 * Application-window status for one exam (calendar dates, NY civil-service product).
 * Mirrors site/staffing.js statusFor — keep in lockstep.
 *
 * @param {object} exam
 * @param {string} today YYYY-MM-DD
 * @returns {string}
 */
export function examWindowStatus(exam, today) {
  if (!exam) return "unscheduled";
  if (exam.schedule_status === "canceled") return "canceled";
  if (exam.schedule_status === "postponed") return "postponed";
  if (!exam.application_start || !exam.application_end) return "unscheduled";
  if (today < exam.application_start) return "upcoming";
  if (today <= exam.application_end) return "open";
  return "closed";
}

function isContinuousExam(exam) {
  const mode = `${exam?.application_mode || ""} ${exam?.filing_method || ""} ${exam?.schedule_status || ""}`.toLowerCase();
  return /continuous|walk[- ]?in/.test(mode);
}

/**
 * Build taxonomy + per-area exam lists with open-window state for the staffing payload.
 *
 * @param {object[]} exams
 * @param {object} taxonomy
 * @param {string} today YYYY-MM-DD
 * @returns {object}
 */
export function buildInterestTaxonomyIndex(exams, taxonomy, today) {
  const areaIds = interestAreaIds(taxonomy);
  const areas = publicInterestAreas(taxonomy);
  const byArea = Object.create(null);

  for (const id of areaIds) {
    byArea[id] = {
      id,
      exam_count: 0,
      open_count: 0,
      upcoming_count: 0,
      closed_count: 0,
      canceled_count: 0,
      postponed_count: 0,
      unscheduled_count: 0,
      continuous_count: 0,
      actionable_count: 0,
      open_exam_numbers: [],
      upcoming_exam_numbers: [],
      continuous_exam_numbers: [],
      exam_numbers: [],
    };
  }

  const list = Array.isArray(exams) ? exams : [];
  for (const exam of list) {
    const id = exam?.interest_area && byArea[exam.interest_area]
      ? exam.interest_area
      : defaultInterestArea(taxonomy);
    const bucket = byArea[id] || byArea[defaultInterestArea(taxonomy)];
    if (!bucket) continue;
    const number = String(exam.exam_number || "").trim();
    if (!number) continue;
    bucket.exam_numbers.push(number);
    bucket.exam_count += 1;
    const status = examWindowStatus(exam, today);
    const continuous = isContinuousExam(exam);
    if (continuous) {
      bucket.continuous_count += 1;
      bucket.continuous_exam_numbers.push(number);
    }
    if (status === "open") {
      bucket.open_count += 1;
      bucket.open_exam_numbers.push(number);
    } else if (status === "upcoming") {
      bucket.upcoming_count += 1;
      bucket.upcoming_exam_numbers.push(number);
    } else if (status === "closed") {
      bucket.closed_count += 1;
    } else if (status === "canceled") {
      bucket.canceled_count += 1;
    } else if (status === "postponed") {
      bucket.postponed_count += 1;
    } else {
      bucket.unscheduled_count += 1;
    }
    if (status === "open" || status === "upcoming" || continuous) {
      bucket.actionable_count += 1;
    }
  }

  for (const id of areaIds) {
    const bucket = byArea[id];
    bucket.exam_numbers.sort();
    bucket.open_exam_numbers.sort();
    bucket.upcoming_exam_numbers.sort();
    bucket.continuous_exam_numbers.sort();
  }

  return {
    schema_version: Number(taxonomy?.schema_version) || INTEREST_TAXONOMY_SCHEMA_VERSION,
    id: taxonomy?.id || "exam-interest-area-taxonomy",
    name: taxonomy?.name || "Civil-service exam interest areas",
    mapping_source: "exam_sources/interest_area_taxonomy.json",
    default_area: defaultInterestArea(taxonomy),
    // Alerts-by-area is a separate gated card; only the flag rides on the payload.
    alerts_surface: "separate_gated_card",
    areas,
    by_area: byArea,
    summary: {
      exam_count: list.length,
      area_count: areaIds.length,
      tagged_non_other: list.filter((e) => e?.interest_area && e.interest_area !== defaultInterestArea(taxonomy)).length,
      open_count: list.filter((e) => examWindowStatus(e, today) === "open").length,
      upcoming_count: list.filter((e) => examWindowStatus(e, today) === "upcoming").length,
    },
  };
}

/**
 * Validate taxonomy shape for build --check / unit tests.
 * @param {object} taxonomy
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateInterestTaxonomy(taxonomy) {
  const errors = [];
  if (!taxonomy || typeof taxonomy !== "object") {
    return { ok: false, errors: ["taxonomy missing"] };
  }
  if (!Array.isArray(taxonomy.areas) || taxonomy.areas.length === 0) {
    errors.push("areas must be a non-empty array");
  } else {
    const ids = new Set();
    for (const area of taxonomy.areas) {
      if (!area?.id) errors.push("area missing id");
      else if (ids.has(area.id)) errors.push(`duplicate area id ${area.id}`);
      else ids.add(area.id);
    }
    const def = defaultInterestArea(taxonomy);
    if (!ids.has(def)) errors.push(`default_area ${def} not in areas`);
  }
  if (!Array.isArray(taxonomy.title_rules)) {
    errors.push("title_rules must be an array");
  } else {
    for (const [i, rule] of taxonomy.title_rules.entries()) {
      if (!rule?.area) errors.push(`title_rules[${i}] missing area`);
      if (!rule?.pattern) errors.push(`title_rules[${i}] missing pattern`);
      else {
        try {
          // eslint-disable-next-line no-new
          new RegExp(rule.pattern, rule.flags || "i");
        } catch (error) {
          errors.push(`title_rules[${i}] invalid pattern: ${error.message}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
