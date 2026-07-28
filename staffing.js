(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CrolStaffing = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function statusFor(exam, today) {
    if (exam.schedule_status === "canceled") return "canceled";
    if (exam.schedule_status === "postponed") return "postponed";
    if (!exam.application_start || !exam.application_end) return "unscheduled";
    if (today < exam.application_start) return "upcoming";
    if (today <= exam.application_end) return "open";
    return "closed";
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
    return `${base || "https://crol-list.org/"}#exam/${encodeURIComponent(examNumber)}`;
  }

  return { statusFor, filterExams, sourceAgeDays, sourceIsStale, examUrl };
});
