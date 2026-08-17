import { buildBrowseView } from "./browse_view.mjs";
import { EXAMS_SURFACE } from "./browse_surface_contracts.mjs";

export const EXAMS_BROWSE_ROW_KIND = "civil_service_exam";

export const EXAMS_ALIAS_BROWSE_VIEW = Object.freeze({
  tab: EXAMS_SURFACE.compatibility.runtimeTab,
  label: EXAMS_SURFACE.label,
  route: EXAMS_SURFACE.route,
  countLabel: "civil-service exams",
  description: EXAMS_SURFACE.description,
  sources: "DCAS exam schedules · published exam records",
  rowsKey: "rows",
});

function day(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function examWindow(exam, asOf) {
  if (exam?.schedule_status === "canceled" || exam?.schedule_status === "postponed") {
    return exam.schedule_status;
  }
  const start = day(exam?.application_start);
  const end = day(exam?.application_end);
  if (!start || !end || !asOf) return "unscheduled";
  if (asOf < start) return "upcoming";
  if (asOf <= end) return "open";
  return "closed";
}

function examDetail(exam, status) {
  const eligibility = exam?.eligibility === "promotion" ? "Promotion" : "Open competitive";
  const start = day(exam?.application_start);
  const end = day(exam?.application_end);
  const dates = start && end ? ` · Applications ${start}–${end}` : "";
  return `${eligibility} · ${status[0].toUpperCase()}${status.slice(1)}${dates}`;
}

export function examBrowseRows(artifact = {}) {
  const asOf = day(artifact.data_current_as_of || artifact.generated_at);
  return (Array.isArray(artifact.exams) ? artifact.exams : []).flatMap((exam) => {
    const id = String(exam?.exam_number || "").trim();
    if (!/^\d{4}$/.test(id)) return [];
    const status = examWindow(exam, asOf);
    return [{
      kind: EXAMS_BROWSE_ROW_KIND,
      civic_object: {
        kind: "exam",
        kind_label: "Civil-service exam",
        id,
        label: String(exam.title || `Exam ${id}`),
        href: `/exams/${encodeURIComponent(id)}/`,
      },
      date: day(exam.application_end) || day(exam.application_start),
      detail: examDetail(exam, status),
      status,
      interest_area: String(exam.interest_area || ""),
      search_text: [exam.title, id, exam.title_code, exam.interest_area, exam.eligibility, status].filter(Boolean).join(" "),
    }];
  });
}

export function buildExamsAliasBrowseView(artifact = {}, params = new URLSearchParams(), options = {}) {
  const search = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const interest = String(search.get("interest") || "").trim();
  const window = String(search.get("window") || "").trim();
  const rows = examBrowseRows(artifact).filter((row) => {
    if (interest && interest !== "all" && row.interest_area !== interest) return false;
    if (window && window !== "all" && window !== "actionable" && row.status !== window) return false;
    if (window === "actionable" && !["open", "upcoming"].includes(row.status)) return false;
    return true;
  });
  return buildBrowseView("exams-alias", { rows }, search, {
    config: EXAMS_ALIAS_BROWSE_VIEW,
    rows,
    asOf: artifact.data_current_as_of || artifact.generated_at,
    limit: options.limit ?? 24,
    handledFilters: ["interest", "window"],
  });
}
