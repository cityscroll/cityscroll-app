import { buildBrowseView } from "./browse_view.mjs";
import {
  browseListState,
  PEOPLE_ORGANIZATIONS_BROWSE_CONFIG,
} from "./browse_list_contract.mjs";

export const EXAMS_ALIAS_BROWSE_VIEW = Object.freeze({
  tab: "people",
  label: "Exams",
  route: "/browse/exams/",
  countLabel: "civil-service exams",
  description: "Civil-service exam schedules, applications, eligible lists, and published outcomes.",
  sources: "DCAS exam schedules · published exam records",
  rowsKey: "rows",
});

export const PEOPLE_LIST_BROWSE_VIEW = Object.freeze({
  tab: "browse",
  label: "People and organizations",
  route: "/browse/people/",
  countLabel: "typed civic objects",
  description: "Officials, agencies, vendors, committees, community boards, and published appointments.",
  sources: "Person hub · committee graph · agency constellation",
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

export function peopleBrowseRows(model = {}) {
  const kindLabels = {
    official: "Official",
    "exact-person-appointment": "Exact-person appointment",
    "notice-only-hire": "Notice-only hire",
    agency: "Agency",
    vendor: "Vendor",
    committee: "Committee",
    "community-board": "Community board institution",
  };
  return (Array.isArray(model.rows) ? model.rows : []).flatMap((row) => {
    const id = String(row?.id || "").trim();
    const kind = String(row?.kind || "").trim();
    const label = String(row?.label || "").trim();
    if (!id || !kind || !label) return [];
    const rawKindLabel = kind.replaceAll("-", " ");
    const kindLabel = kindLabels[kind] || `${rawKindLabel[0].toUpperCase()}${rawKindLabel.slice(1)}`;
    const heading = kind === "official"
      ? `Official · ${label}`
      : `${label} · ${kindLabel} · ${id}`;
    return [{
      ...row,
      detail: kind === "official" && row.detail === "Official profile" ? "" : row.detail,
      show_civic_metadata: kind !== "official",
      civic_object: {
        kind,
        kind_label: kind === "official" ? "" : kindLabel,
        id,
        label: heading,
        href: row.href || null,
      },
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

export function buildPeopleListBrowseView(model = {}, params = new URLSearchParams(), options = {}) {
  const state = browseListState(model, params, PEOPLE_ORGANIZATIONS_BROWSE_CONFIG);
  const rows = peopleBrowseRows({ rows: state.rows });
  return buildBrowseView("people-list", { rows }, params, {
    config: PEOPLE_LIST_BROWSE_VIEW,
    rows,
    asOf: state.generatedAt,
    limit: options.limit ?? PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.initialPageSize,
    handledFilters: [PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetParam],
  });
}
