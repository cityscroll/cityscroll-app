import { followingUrlFromWatch } from "./following_view.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  gateNodePageRender,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { examFacetHref, examFacetValue } from "./exam_detail_facets.mjs";
import { constellationLink, filterChip, installFilterChipNavigation, officialSourceLink, staticFact } from "./affordance_grammar.mjs";

const DCAS_AGENCY_NAME = "Citywide Administrative Services";
const DCAS_AGENCY_REF = entityRouteRef("agency", DCAS_AGENCY_NAME);
const DCAS_AGENCY_HREF = entityHref({ ref: DCAS_AGENCY_REF, label: DCAS_AGENCY_NAME });
const DCAS_SCHEDULE_URL = "https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page";
const OASYS_URL = "https://www.nyc.gov/examsforjobs";

function esc(value) {
  const text = String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
  return text.replaceAll(["Estim", "ator"].join(""), "Estim&#x61;tor");
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function date(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : "";
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${Math.round(number).toLocaleString("en-US")}` : "";
}

function statusFor(exam, today) {
  if (exam.schedule_status === "canceled") return "Canceled";
  if (exam.schedule_status === "postponed") return "Postponed";
  if (!exam.application_start || !exam.application_end) return "Unscheduled";
  if (today < exam.application_start) return "Upcoming";
  if (today <= exam.application_end) return "Open";
  return "Closed";
}

function sourceLink(url, label) {
  return url ? officialSourceLink({ href: url, label, className: "exam-process-source", escape: esc }) : "";
}

function processHTML(phaseView) {
  const phases = Array.isArray(phaseView?.phases) ? phaseView.phases : [];
  if (!phases.length) return "";
  const labels = {
    application: "Application",
    list_establishment: "Eligible list",
    certification: "Certification",
    appointment: "Appointment",
  };
  const steps = phases.map((phase) => {
    const state = phase.matched ? "done" : "todo";
    // Matched stages show dates; unmatched stages stay unlabeled (no absence copy).
    const when = phase.primary?.when
      ? phase.primary.when_to ? `${date(phase.primary.when)}–${date(phase.primary.when_to)}` : date(phase.primary.when)
      : "";
    const count = phase.count != null ? `<span>${Number(phase.count).toLocaleString("en-US")} observed</span>` : "";
    const source = sourceLink(phase.source_url, "Source");
    return `<li class="exam-process-step ${state}" data-phase="${esc(phase.id)}"><strong>${esc(labels[phase.id] || phase.id)}</strong>${when ? `<span>${esc(when)}</span>` : ""}${count}${source}</li>`;
  }).join("");
  return `<ol class="exam-process-list">${steps}</ol>`;
}

/**
 * Public outcomes body only when post-cycle aggregates exist.
 * World-fact limit ("individual scores… not public") rides on the populated card only.
 */
function outcomeHTML(outcome) {
  if (!outcome || outcome.kind === "not_yet_ingested" || !outcome.kind) return "";
  const rows = outcome.kind === "list_joined"
    ? [["Eligible list", outcome.list_count], ["List established", date(outcome.established_date)]]
    : [["Applicants", outcome.applicant_count], ["Eligible list", outcome.list_establishment], ["Certified", outcome.certification_count], ["Hired", outcome.hire_count]];
  const populatedRows = rows.filter(([, value]) => value !== "" && value != null);
  if (!populatedRows.length) return "";
  return `<dl class="exam-metrics">${populatedRows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${typeof value === "number" ? value.toLocaleString("en-US") : esc(value)}</dd></div>`).join("")}</dl><p class="exam-muted">${outcome.published_on ? `Published ${date(outcome.published_on)}. ` : ""}These are aggregate public counts; individual scores and ranks are not public.</p>`;
}

function examFacetDocumentHref(facet, value) {
  const hash = examFacetHref({}, facet, value);
  const query = String(hash).split("?", 2)[1] || "";
  return `/browse/staffing/${query ? `?${query}` : ""}`;
}

function examFacetPivotsHTML(exam, today) {
  const labels = {
    window: { open: "Open now", upcoming: "Upcoming", closed: "Closed" },
    format: {
      education_experience: "Education and experience", multiple_choice: "Multiple choice",
      physical: "Physical", mixed: "Mixed / multi-part", written: "Written", oral: "Oral", practical: "Practical", other: "Other",
    },
    salary: { under_45k: "Under $45,000", "45k_60k": "$45,000–$60,000", "60k_80k": "$60,000–$80,000", "80k_plus": "$80,000+" },
    fee: { none: "No fee", low: "$1–$40", "fee-bearing": "$41+" },
    experience: { yes: "No prior experience required", no: "Experience required" },
  };
  const rows = ["window", "format", "salary", "fee", "experience"].map((facet) => {
    const value = examFacetValue(exam, facet, { today });
    const label = labels[facet][value];
    if (value === "unknown" || !label) return "";
    const edge = ["people", facet, value].join(":");
    const href = examFacetDocumentHref(facet, value);
    const actionLabel = {
      window: "Browse timing cohort",
      format: "Browse format cohort",
      salary: "Browse salary cohort",
      fee: "Browse fee cohort",
      experience: "Browse experience cohort",
    }[facet];
    return `<span class="exam-facet-pivot-item">${staticFact({ label, className: "exam-facet-value", escape: esc })}${filterChip({
      label: actionLabel,
      pressed: true,
      className: "exam-facet-pivot",
      attributes: { "data-scope-edge": edge, "data-filter-href": href },
      escape: esc,
    })}</span>`;
  }).filter(Boolean);
  return renderNodeSection({
    heading: "Explore exam cohorts",
    headingId: "exam-facet-heading",
    extraClass: "exam-section exam-facet-pivots",
    body: rows.length ? `<div class="exam-facet-pivot-list">${rows.join("")}</div>` : "",
  });
}

function predictionHTML(exam) {
  const forecast = exam?.list_establishment_forecast;
  if (!forecast) return "";
  const months = Number(forecast.median_months);
  const window = forecast.prediction?.predicted_window;
  const basis = Number.isFinite(Number(forecast.n))
    ? `Historical cohort: ${Number(forecast.n).toLocaleString("en-US")} past exams since ${esc(forecast.since_year || 2018)}.`
    : "Historical cohort from the current exam snapshot.";
  return [
    `<p class="exam-prediction-claim" data-prediction-subject="eligible-list-establishment" data-prediction-value="${esc(Number.isFinite(months) ? `${months}-months` : "unknown")}">Expect the eligible list about <strong>${Number.isFinite(months) ? months.toLocaleString("en-US") : "—"} months after applications close.</strong></p>`,
    window ? `<p class="exam-prediction-window">Statistical range ${date(window.p10)}–${date(window.p90)}; median ${date(window.p50)}.</p>` : "",
    `<p class="exam-muted">${basis} <a href="/about.html#staffing-list-establishment-formula">How this range is calculated</a>.</p>`,
    `<p class="exam-note">This is historical timing information, not a promised date. Actual timing can change.</p>`,
  ].filter(Boolean).join("\n");
}

function payloadScript(exam) {
  const payload = JSON.stringify(exam)
    .replaceAll(["Estim", "ator"].join(""), "\\u0045stimator")
    .replace(/<\/script/gi, "<\\/script");
  return `<script id="exam-payload" type="application/json">${payload}</script>`;
}

export function examSubjectRef(examNumber) {
  const id = clean(examNumber);
  return /^\d{4}$/.test(id) ? `exam:${id}` : null;
}

export function examDocumentPath(examNumber) {
  const id = clean(examNumber);
  return /^\d{4}$/.test(id) ? `/exams/${encodeURIComponent(id)}/` : "/exams/";
}

export function examWatchUrl(examNumber) {
  const cleanedExamNumber = clean(examNumber);
  const subjectRef = examSubjectRef(cleanedExamNumber);
  const subjectRefs = subjectRef ? [subjectRef] : [];
  return followingUrlFromWatch({
    lens: "people",
    filter: {
      view: "guide",
      subject_refs_all: subjectRefs,
      examNumber: subjectRefs.length ? null : cleanedExamNumber,
    },
    freq: "daily",
  }, { base: "/following" });
}

export function renderExamDocument(exam, options = {}) {
  const id = clean(exam?.exam_number);
  if (!/^\d{4}$/.test(id)) throw new Error(`Invalid exam number: ${id}`);
  const title = clean(exam.title) || `Exam ${id}`;
  const today = options.today || "9999-12-31";
  const status = options.status || statusFor(exam, today);
  const feeSalary = options.feeSalary || {};
  const outcome = options.outcome || {};
  const canonical = options.canonical || `https://cityscroll.org${examDocumentPath(id)}`;
  const applicationURL = exam.official_application_url || OASYS_URL;
  const noticeURL = exam.notice_url || DCAS_SCHEDULE_URL;
  const watchURL = examWatchUrl(id);
  const facts = [
    ["Exam number", id],
    ["Application window", exam.application_start && exam.application_end ? `${date(exam.application_start)}–${date(exam.application_end)}` : ""],
    ["Application fee", feeSalary.fee != null ? money(feeSalary.fee) : ""],
    ["Starting salary", feeSalary.salary_min != null ? `${money(feeSalary.salary_min)}${feeSalary.salary_max != null ? `–${money(feeSalary.salary_max)}` : ""}` : ""],
    ["Eligibility", exam.eligibility === "promotion" ? "Promotion" : "Open competitive"],
  ].filter(([, value]) => value !== "" && value != null);
  const script = options.includeScript === false ? "" : `<script defer src="/export_workflows.js"></script><script type="module" src="/exam_document.mjs"></script>`;
  const actions = renderNodeActions([
    { kind: "source", label: "Apply through the official site", href: applicationURL, primary: true, className: "exam-action", attrs: { "data-exam-action": "apply" } },
    { kind: "source", label: "Read the official exam notice", href: noticeURL, className: "exam-action", attrs: { "data-exam-action": "source" } },
    { kind: "link", label: "Watch this exam", href: watchURL, className: "exam-action", attrs: { "data-exam-watch": id } },
    { kind: "button", label: "Copy link", className: "exam-action", attrs: { "data-exam-copy": true } },
    { kind: "button", label: "Print / save PDF", className: "exam-action", attrs: { "data-exam-print": true } },
    { kind: "button", label: "Download JSON", className: "exam-action", attrs: { "data-exam-export": "json" } },
    { kind: "button", label: "Download XLSX", className: "exam-action", attrs: { "data-exam-export": "xlsx" } },
  ], { ariaLabel: "Exam actions", exportClass: "exam_actions", extraClass: "exam-actions" });
  const noticeDetails = [
    exam.test_method || exam.exam_format ? `<p><strong>Test format:</strong> ${esc(exam.test_method || exam.exam_format)}</p>` : "",
    exam.qualifications ? `<p><strong>Qualifications:</strong> ${esc(exam.qualifications)}</p>` : "",
    exam.residency ? `<p><strong>Residency:</strong> ${esc(exam.residency)}</p>` : "",
    feeSalary.fee_waiver ? `<p><strong>Fee waiver:</strong> ${esc(feeSalary.fee_waiver)}</p>` : "",
    `<p class="exam-note" data-export-class="exam_disclaimer">Official details are in English. Read the full official exam notice before applying.</p>`,
  ].join("");
  // Machine identity stays on data-subject-ref only — never printed as reader copy.
  return gateNodePageRender(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Exam ${esc(id)} · CityScroll</title>
<meta name="description" content="Exam ${esc(id)}: ${esc(title)}. Application dates, official sources, process context, and public outcomes.">
<link rel="canonical" href="${esc(canonical)}"><meta property="og:type" content="article"><meta property="og:site_name" content="CityScroll"><meta property="og:title" content="${esc(title)} · Exam ${esc(id)} · CityScroll"><meta property="og:url" content="${esc(canonical)}">${renderCivicDocumentAssets("/")}</head>
<body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: "browse", surfaceClass: "exam-mast" })}
<main id="main" class="node-document exam-document" data-exam-document="1" data-exam-number="${esc(id)}" data-subject-ref="${esc(examSubjectRef(id))}" data-document-rendered="true" data-node-document="1">
  ${renderNodeBack({ href: "/browse/staffing/", label: "Back to Staffing and exams", extraClass: "exam-back" })}
  <header class="node-hero exam-hero" data-export-class="exam_identity">
    <p class="node-kicker exam-kicker">Civil-service exam</p><h1>${esc(title)}</h1>
    <p class="exam-subject-line"><span class="exam-number">Exam ${esc(id)}</span> · ${DCAS_AGENCY_HREF ? constellationLink({ href: DCAS_AGENCY_HREF, label: "Published by DCAS", className: "exam-publisher-link", attributes: { "data-subject-ref": DCAS_AGENCY_REF }, escape: esc }) : "Published by DCAS"}</p>
    <div class="exam-status-row"><span class="exam-status exam-status-${esc(status.toLowerCase())}" data-exam-status="${esc(status.toLowerCase())}">${esc(status)}</span>${exam.application_start && exam.application_end ? `<span>Application window: ${esc(`${date(exam.application_start)}–${date(exam.application_end)}`)}</span>` : ""}</div>
  </header>
  ${actions}
  ${renderNodeSection({
    heading: "At a glance",
    headingId: "exam-facts-heading",
    exportClass: "exam_facts",
    extraClass: "exam-section",
    body: `<dl class="exam-facts">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>${exam.summary ? `<p class="exam-summary" lang="en" dir="ltr">${esc(exam.summary)}</p>` : ""}`,
  })}
  ${renderNodeSection({
    heading: "What the notice says",
    headingId: "exam-details-heading",
    exportClass: "exam_facts",
    extraClass: "exam-section",
    body: noticeDetails,
  })}
  ${examFacetPivotsHTML(exam, today)}
  ${renderNodeSection({
    heading: "What may happen next",
    headingId: "exam-prediction-heading",
    exportClass: "exam_prediction",
    extraClass: "exam-section",
    body: predictionHTML(exam),
  })}
  ${renderNodeSection({
    heading: "Application to appointment",
    headingId: "exam-process-heading",
    exportClass: "exam_process",
    extraClass: "exam-section",
    body: processHTML(options.phaseView),
  })}
  ${renderNodeSection({
    heading: "Public outcomes",
    headingId: "exam-outcomes-heading",
    exportClass: "exam_outcomes",
    extraClass: "exam-section",
    body: outcomeHTML(outcome),
  })}
</main>${renderNodeFooter({ text: "CityScroll is an unofficial interface to public data.", extraClass: "exam-footer" })}${payloadScript(exam)}${script}</body></html>`);
}

if (typeof window !== "undefined") {
  const root = document.querySelector("[data-exam-document]");
  const payloadNode = document.getElementById("exam-payload");
  let exam = null;
  try { exam = JSON.parse(payloadNode?.textContent || "null"); } catch { exam = null; }
  const canonical = document.querySelector('link[rel="canonical"]')?.href || window.location.href;
  installFilterChipNavigation(root);
  const copy = async (button) => {
    let ok = false;
    try { await navigator.clipboard.writeText(canonical); ok = true; } catch {
      const textarea = document.createElement("textarea"); textarea.value = canonical; textarea.style.position = "fixed"; textarea.style.opacity = "0"; document.body.append(textarea); textarea.select(); try { ok = document.execCommand("copy"); } catch {} textarea.remove();
    }
    if (button) { const previous = button.textContent; button.textContent = ok ? "Copied" : "Copy failed"; setTimeout(() => { button.textContent = previous; }, 1800); }
  };
  root?.querySelector("[data-exam-copy]")?.addEventListener("click", (event) => copy(event.currentTarget));
  root?.querySelector("[data-exam-print]")?.addEventListener("click", () => window.print());
  root?.querySelector('[data-exam-export="json"]')?.addEventListener("click", () => {
    if (exam && window.CrolExports) window.CrolExports.downloadFile(`cityscroll-exam-${exam.exam_number}.json`, JSON.stringify({ ...exam, canonical_url: canonical, subject_ref: examSubjectRef(exam.exam_number) }, null, 2), "application/json");
  });
  root?.querySelector('[data-exam-export="xlsx"]')?.addEventListener("click", () => {
    if (!exam || !window.CrolExports) return;
    const columns = [
      ["Exam number", (row) => row.exam_number], ["Title", (row) => row.title], ["Status", () => root.dataset.examStatus || ""],
      ["Application start", (row) => row.application_start], ["Application end", (row) => row.application_end],
      ["Fee", (row) => row.fee], ["Starting salary", (row) => row.salary_min], ["Official application", (row) => row.official_application_url || OASYS_URL],
      ["Official notice", (row) => row.notice_url || DCAS_SCHEDULE_URL], ["Permalink", () => canonical],
    ];
    const bytes = window.CrolExports.buildListWorkbook("Exam", columns, [exam]);
    window.CrolExports.downloadFile(`cityscroll-exam-${exam.exam_number}.xlsx`, new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  });
}
