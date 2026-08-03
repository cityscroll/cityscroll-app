(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CrolStaffing = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Stable OASys landing for unmapped exams. Mapped open exams use per-exam NOE URLs
  // (build-time OASys examId join → official_application_url on each exam row).
  const OASY_APPLY_URL = "https://www.nyc.gov/examsforjobs";
  const DCAS_OPEN_COMPETITIVE_URL =
    "https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page";
  const INTEREST_AREAS = [
    "public-safety",
    "health-care",
    "engineering-construction",
    "technology-science",
    "community-social-services",
    "administration-finance",
    "trades-operations",
    "other",
  ];

  function statusFor(exam, today) {
    if (exam.schedule_status === "canceled") return "canceled";
    if (exam.schedule_status === "postponed") return "postponed";
    if (!exam.application_start || !exam.application_end) return "unscheduled";
    if (today < exam.application_start) return "upcoming";
    if (today <= exam.application_end) return "open";
    return "closed";
  }

  /** Whole calendar days from today to application_end (noon UTC both sides). */
  function applicationDaysLeft(endDate, today) {
    if (!endDate || !today) return null;
    const end = Date.parse(`${String(endDate).slice(0, 10)}T12:00:00Z`);
    const now = Date.parse(`${String(today).slice(0, 10)}T12:00:00Z`);
    if (!Number.isFinite(end) || !Number.isFinite(now)) return null;
    return Math.round((end - now) / 86400000);
  }

  function isInterestArea(value) {
    return INTEREST_AREAS.includes(String(value || ""));
  }

  function isContinuousExam(exam) {
    const mode = `${exam?.application_mode || ""} ${exam?.filing_method || ""} ${exam?.schedule_status || ""}`.toLowerCase();
    return /continuous|walk[- ]?in/.test(mode);
  }

  function salaryBandFor(salaryMin) {
    const n = Number(salaryMin);
    if (!Number.isFinite(n) || n <= 0) return "unknown";
    if (n < 45000) return "under_45k";
    if (n < 60000) return "45k_60k";
    if (n < 80000) return "60k_80k";
    return "80k_plus";
  }

  function feeLevelFor(fee) {
    if (fee == null || fee === "") return "unknown";
    const n = Number(fee);
    if (!Number.isFinite(n)) return "unknown";
    if (n === 0) return "none";
    if (n <= 40) return "low";
    if (n <= 70) return "mid";
    return "high";
  }

  /**
   * Differentiator facets for card leads / filters (precomputed on the exam row).
   * @param {object} exam
   */
  function examDifferentiatorView(exam) {
    if (!exam) {
      return {
        exam_format: null,
        salary_band: "unknown",
        fee_level: "unknown",
        no_experience_required: null,
        card_leads: [],
      };
    }
    return {
      exam_format: exam.exam_format || null,
      salary_band: exam.salary_band || salaryBandFor(exam.salary_min),
      fee_level: exam.fee_level || feeLevelFor(exam.fee),
      no_experience_required: exam.no_experience_required == null
        ? null
        : Boolean(exam.no_experience_required),
      residency_required: exam.residency_required == null
        ? null
        : Boolean(exam.residency_required),
      qualifications: exam.qualifications || null,
      test_method: exam.test_method || null,
      card_leads: Array.isArray(exam.card_leads) ? exam.card_leads : [],
      fee_waiver_is_boilerplate: Boolean(exam.fee_waiver_is_boilerplate),
    };
  }

  function examMatchesDifferentiatorFilters(exam, filters) {
    if (!exam) return false;
    const view = examDifferentiatorView(exam);
    if (filters.format && filters.format !== "all") {
      if (String(view.exam_format || "") !== String(filters.format)) return false;
    }
    if (filters.salary_band && filters.salary_band !== "all") {
      if (view.salary_band !== filters.salary_band) return false;
    }
    if (filters.fee_level && filters.fee_level !== "all") {
      if (view.fee_level !== filters.fee_level) return false;
    }
    if (filters.no_experience === "yes") {
      if (view.no_experience_required !== true) return false;
    } else if (filters.no_experience === "no") {
      if (view.no_experience_required !== false) return false;
    }
    return true;
  }

  function filterExams(exams, filters, today) {
    const q = String(filters.query || "").trim().toLowerCase();
    return exams.filter(exam => {
      const status = statusFor(exam, today);
      const continuous = isContinuousExam(exam);
      if (filters.eligibility && filters.eligibility !== "all" && exam.eligibility !== filters.eligibility) return false;
      if (filters.interest && filters.interest !== "all" && exam.interest_area !== filters.interest) return false;
      if (filters.window === "actionable" && !["open", "upcoming"].includes(status) && !continuous) return false;
      if (filters.window === "open" && status !== "open") return false;
      if (filters.window === "upcoming" && status !== "upcoming") return false;
      if (!examMatchesDifferentiatorFilters(exam, filters)) return false;
      if (q && !`${exam.title} ${exam.exam_number} ${exam.summary || ""} ${exam.qualifications || ""} ${exam.test_method || ""}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      // Intent-first: finite open deadlines, upcoming windows, then continuous/walk-in.
      const rank = { open: 0, upcoming: 1, postponed: 3, unscheduled: 4, closed: 5, canceled: 6 };
      const ar = isContinuousExam(a) ? 2 : (rank[statusFor(a, today)] ?? 9);
      const br = isContinuousExam(b) ? 2 : (rank[statusFor(b, today)] ?? 9);
      return ar - br
        || (a.application_end || "9999-12-31").localeCompare(b.application_end || "9999-12-31")
        || a.title.localeCompare(b.title)
        || a.exam_number.localeCompare(b.exam_number);
    });
  }

  function sourceAgeDays(source, today) {
    const stamp = source.verified_at || source.data_current_as_of || source.fetched_at;
    if (!stamp) return Infinity;
    const a = Date.parse(`${stamp.slice(0, 10)}T00:00:00Z`);
    const b = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
    return Math.max(0, Math.floor((b - a) / 86400000));
  }

  function sourceIsStale(source, today) {
    return sourceAgeDays(source, today) > Number(source.stale_after_days || 0);
  }

  function examUrl(examNumber, base) {
    return `${base || "https://cityscroll.org/"}#exam/${encodeURIComponent(examNumber)}`;
  }

  function featuredExams(exams, today, limit) {
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 4;
    return filterExams(exams, {
      query: "",
      interest: "all",
      eligibility: "open_competitive",
      window: "actionable",
    }, today).slice(0, count);
  }

  function normalizeTitle(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/&/g, " AND ")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ")
      .toUpperCase();
  }

  function titleKeys(value) {
    const full = normalizeTitle(value);
    const withoutQualifier = normalizeTitle(String(value || "").replace(/\s*\([^)]*\)\s*$/g, ""));
    return [...new Set([full, withoutQualifier].filter(Boolean))];
  }

  function examForTitle(exams, title, today) {
    const keys = new Set(titleKeys(title));
    if (!keys.size) return null;
    const actionable = featuredExams(exams, today, exams.length);
    return actionable.find(exam => titleKeys(exam.title).some(key => keys.has(key))) || null;
  }

  function personnelFields(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const read = pattern => {
      const match = text.match(pattern);
      return match ? match[1].trim() : "";
    };
    return {
      effective_date: read(/Effective Date:\s*([^;]+)/i),
      provisional: read(/Provisional Status:\s*([^;]+)/i),
      title_code: read(/Title Code:\s*([^;]+)/i),
      reason: read(/Reason For Change:\s*([^;]+)/i),
      salary: read(/Salary:\s*([^;]+)/i),
      person: read(/Employee Name:\s*(.+)$/i),
    };
  }

  function hireNotices(rows, crosswalk) {
    const titles = new Map((crosswalk || []).map(item => [
      String(item.title_code || "").toUpperCase(),
      item.official_title || item.payroll_title || "",
    ]));
    return (rows || []).map(row => {
      const fields = personnelFields(row.additional_description_1);
      return {
        kind: "hire",
        request_id: row.request_id || "",
        published_at: row.start_date || "",
        agency: row.agency_name || "",
        role: titles.get(fields.title_code.toUpperCase()) || "",
        ...fields,
      };
    }).filter(item => item.request_id && item.reason.toUpperCase() === "APPOINTED")
      .sort((a, b) =>
        b.published_at.localeCompare(a.published_at)
        || b.request_id.localeCompare(a.request_id)
      );
  }

  function filterHireNotices(notices, filters) {
    const query = String(filters.query || "").trim().toLowerCase();
    return (notices || []).filter(item => {
      if (filters.role && item.role !== filters.role) return false;
      if (filters.agency && item.agency !== filters.agency) return false;
      if (!query) return true;
      return [
        item.role, item.person, item.agency, item.title_code, item.reason,
      ].join(" ").toLowerCase().includes(query);
    });
  }

  function topValues(items, field, limit) {
    const counts = new Map();
    (items || []).forEach(item => {
      const value = item[field];
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit || 4)
      .map(([value]) => value);
  }

  /**
   * Fee/salary from the Notice of Examination path, or an honest gap class.
   * Schedule-only nulls are not_yet_ingested (NOE not in the precomputed extract),
   * never a false "city does not publish" when the open-competitive NOE path exists.
   */
  function examFeeSalaryView(exam) {
    const fee = exam && exam.fee != null ? exam.fee : null;
    const salaryMin = exam && exam.salary_min != null && exam.salary_min !== ""
      ? exam.salary_min
      : null;
    const salaryMax = exam && exam.salary_max != null && exam.salary_max !== ""
      ? exam.salary_max
      : null;
    if (fee != null && salaryMin != null) {
      return {
        kind: "joined",
        fee,
        salary_min: salaryMin,
        salary_max: salaryMax,
        fee_waiver: exam.fee_waiver || null,
        salary_note: exam.salary_note || null,
        notice_url: exam.notice_url || null,
      };
    }
    const gap = exam && exam.fee_salary_gap && typeof exam.fee_salary_gap === "object"
      ? exam.fee_salary_gap
      : null;
    const gapClass = gap && gap.class
      ? gap.class
      : (exam && exam.notice_url ? "not_published" : "not_yet_ingested");
    return {
      kind: gapClass === "not_published" ? "not_published" : "not_yet_ingested",
      class: gapClass,
      fee,
      salary_min: salaryMin,
      salary_max: salaryMax,
      missing: (gap && gap.missing) || [
        fee == null ? "fee" : null,
        salaryMin == null ? "salary_min" : null,
      ].filter(Boolean),
      notice_url: (exam && exam.notice_url) || null,
    };
  }

  /**
   * Build-time outcome join on exam_number. Prefer full annual DCAS aggregates;
   * else post-list Civil Service List counts (no PII); else class-(a) not-yet-ingested
   * (public sources exist — never a false class-(b) city-withhold for aggregates).
   */
  function examOutcomeView(exam) {
    if (exam && exam.outcome && typeof exam.outcome === "object") {
      return {
        kind: "joined",
        applicant_count: Number(exam.outcome.applicant_count || 0),
        list_establishment: Number(exam.outcome.list_establishment || 0),
        certification_count: Number(exam.outcome.certification_count || 0),
        appointment_count: Number(exam.outcome.appointment_count || 0),
        hire_count: Number(exam.outcome.hire_count || 0),
        published_on: exam.outcome.published_on || null,
        application_cycle: exam.outcome.application_cycle || null,
      };
    }
    const list = exam && exam.list_aggregate && typeof exam.list_aggregate === "object"
      ? exam.list_aggregate
      : null;
    if (list && Number(list.list_count) > 0) {
      return {
        kind: "list_joined",
        list_count: Number(list.list_count || 0),
        established_date: list.established_date || null,
        extension_date: list.extension_date || null,
        title_count: Number(list.title_count || 0),
      };
    }
    const gap = exam && exam.outcome_gap ? exam.outcome_gap : null;
    const gapClass = (gap && gap.class) || "not_yet_ingested";
    // Aggregate post-cycle depth has public sources; only individual scores are class-(b).
    // Accept legacy not_published stamps as not_yet_ingested so old artifacts do not blame the city.
    const kind = gapClass === "not_published" ? "not_yet_ingested" : (gapClass || "not_yet_ingested");
    return {
      kind: kind === "not_yet_ingested" ? "not_yet_ingested" : kind,
      class: kind === "not_yet_ingested" ? "not_yet_ingested" : gapClass,
      pending_stage: (gap && gap.pending_stage) || "list_establishment",
    };
  }

  return {
    OASY_APPLY_URL,
    DCAS_OPEN_COMPETITIVE_URL,
    INTEREST_AREAS,
    statusFor,
    applicationDaysLeft,
    isInterestArea,
    isContinuousExam,
    filterExams,
    sourceAgeDays,
    sourceIsStale,
    examUrl,
    featuredExams,
    normalizeTitle,
    examForTitle,
    personnelFields,
    hireNotices,
    filterHireNotices,
    topValues,
    examFeeSalaryView,
    examOutcomeView,
    salaryBandFor,
    feeLevelFor,
    examDifferentiatorView,
    examMatchesDifferentiatorFilters,
  };
});
