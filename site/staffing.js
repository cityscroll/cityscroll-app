(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CrolStaffing = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Stable public OASys handoff. The City redirects this URL into the OASys host.
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

  function filterExams(exams, filters, today) {
    const q = String(filters.query || "").trim().toLowerCase();
    return exams.filter(exam => {
      const status = statusFor(exam, today);
      if (filters.eligibility && filters.eligibility !== "all" && exam.eligibility !== filters.eligibility) return false;
      if (filters.interest && filters.interest !== "all" && exam.interest_area !== filters.interest) return false;
      if (filters.window === "actionable" && !["open", "upcoming"].includes(status)) return false;
      if (filters.window === "open" && status !== "open") return false;
      if (filters.window === "upcoming" && status !== "upcoming") return false;
      if (q && !`${exam.title} ${exam.exam_number} ${exam.summary || ""}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      // Deadline-first: open windows first, then soonest application_end.
      const rank = { open: 0, upcoming: 1, postponed: 2, unscheduled: 3, closed: 4, canceled: 5 };
      const ar = rank[statusFor(a, today)] ?? 9;
      const br = rank[statusFor(b, today)] ?? 9;
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

  return {
    OASY_APPLY_URL,
    DCAS_OPEN_COMPETITIVE_URL,
    INTEREST_AREAS,
    statusFor,
    applicationDaysLeft,
    isInterestArea,
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
  };
});
