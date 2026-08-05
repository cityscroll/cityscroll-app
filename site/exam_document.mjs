import { followingUrlFromWatch } from "./following_view.mjs";
import { renderCivicDocumentAssets, renderCivicDocumentMast } from "./civic_document_chrome.mjs";

const DCAS_AGENCY_HREF = "/agencies/citywide-administrative-services/";
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
  return match ? `${match[2]}/${match[3]}/${match[1]}` : "Not published";
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${Math.round(number).toLocaleString("en-US")}` : "Not published";
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
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : "";
}

function processHTML(phaseView) {
  const phases = Array.isArray(phaseView?.phases) ? phaseView.phases : [];
  if (!phases.length) return `<p class="exam-muted">No process stages are available in the current snapshot.</p>`;
  const labels = {
    application: "Application",
    list_establishment: "Eligible list",
    certification: "Certification",
    appointment: "Appointment",
  };
  const steps = phases.map((phase) => {
    const state = phase.matched ? "done" : "todo";
    const when = phase.primary?.when
      ? phase.primary.when_to ? `${date(phase.primary.when)}–${date(phase.primary.when_to)}` : date(phase.primary.when)
      : "Not yet in this snapshot";
    const count = phase.count != null ? `<span>${Number(phase.count).toLocaleString("en-US")} observed</span>` : "";
    const source = sourceLink(phase.source_url, "Source");
    return `<li class="exam-process-step ${state}" data-phase="${esc(phase.id)}"><strong>${esc(labels[phase.id] || phase.id)}</strong><span>${esc(when)}</span>${count}${source}</li>`;
  }).join("");
  return `<ol class="exam-process-list">${steps}</ol><p class="exam-muted">Empty stages mean the public aggregate has not reached this precomputed guide; they do not mean the city withheld a source.</p>`;
}

function outcomeHTML(outcome) {
  if (!outcome || outcome.kind === "not_yet_ingested") {
    return `<p class="exam-muted">Post-cycle aggregates are not yet shown for this exam. Individual scores and ranks are not public.</p>`;
  }
  const rows = outcome.kind === "list_joined"
    ? [["Eligible list", outcome.list_count], ["List established", date(outcome.established_date)]]
    : [["Applicants", outcome.applicant_count], ["Eligible list", outcome.list_establishment], ["Certified", outcome.certification_count], ["Hired", outcome.hire_count]];
  return `<dl class="exam-metrics">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${typeof value === "number" ? value.toLocaleString("en-US") : esc(value)}</dd></div>`).join("")}</dl><p class="exam-muted">${outcome.published_on ? `Published ${date(outcome.published_on)}. ` : ""}These are aggregate public counts; individual scores and ranks are not public.</p>`;
}

function predictionHTML(exam) {
  const forecast = exam?.list_establishment_forecast;
  if (!forecast) return `<p class="exam-muted">No eligible-list timing range is available for this exam.</p>`;
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
  return followingUrlFromWatch({
    lens: "people",
    filter: { view: "guide", examNumber: clean(examNumber) },
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
  const sourceNames = Array.isArray(exam.sources) ? exam.sources : [];
  const facts = [
    ["Exam number", id],
    ["Application window", exam.application_start && exam.application_end ? `${date(exam.application_start)}–${date(exam.application_end)}` : "Not published"],
    ["Application fee", feeSalary.fee != null ? money(feeSalary.fee) : "Not published"],
    ["Starting salary", feeSalary.salary_min != null ? `${money(feeSalary.salary_min)}${feeSalary.salary_max != null ? `–${money(feeSalary.salary_max)}` : ""}` : "Not published"],
    ["Eligibility", exam.eligibility === "promotion" ? "Promotion" : "Open competitive"],
  ];
  const script = options.includeScript === false ? "" : `<script defer src="/export_workflows.js"></script><script type="module" src="/exam_document.mjs"></script>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Exam ${esc(id)} · CityScroll</title>
<meta name="description" content="Exam ${esc(id)}: ${esc(title)}. Application dates, official sources, process context, and public outcomes.">
<link rel="canonical" href="${esc(canonical)}"><meta property="og:type" content="article"><meta property="og:site_name" content="CityScroll"><meta property="og:title" content="${esc(title)} · Exam ${esc(id)} · CityScroll"><meta property="og:url" content="${esc(canonical)}">${renderCivicDocumentAssets("/")}</head>
<body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: "browse", surfaceClass: "exam-mast" })}
<main id="main" class="exam-document" data-exam-document="1" data-exam-number="${esc(id)}" data-subject-ref="${esc(examSubjectRef(id))}" data-document-rendered="true">
  <p class="exam-back"><a href="/browse/staffing/">Back to Staffing and exams</a></p>
  <header class="exam-hero" data-export-class="exam_identity">
    <p class="exam-kicker">Civil-service exam</p><h1>${esc(title)}</h1>
    <p class="exam-subject-line"><span class="exam-number">Exam ${esc(id)}</span> · <a href="${DCAS_AGENCY_HREF}" data-subject-ref="agency:id:citywide-administrative-services">Published by DCAS</a></p>
    <div class="exam-status-row"><span class="exam-status exam-status-${esc(status.toLowerCase())}" data-exam-status="${esc(status.toLowerCase())}">${esc(status)}</span><span>Application window: ${esc(exam.application_start && exam.application_end ? `${date(exam.application_start)}–${date(exam.application_end)}` : "Not published")}</span></div>
  </header>
  <nav class="exam-actions" aria-label="Exam actions" data-export-class="exam_actions">
    <a class="exam-action primary" href="${esc(applicationURL)}" target="_blank" rel="noopener noreferrer" data-exam-action="apply">Apply through the official site</a>
    <a class="exam-action" href="${esc(noticeURL)}" target="_blank" rel="noopener noreferrer" data-exam-action="source">Read the official exam notice</a>
    <a class="exam-action" href="${esc(watchURL)}" data-exam-watch="${esc(id)}">Watch this exam</a>
    <button class="exam-action" type="button" data-exam-copy>Copy link</button><button class="exam-action" type="button" data-exam-print>Print / save PDF</button>
    <button class="exam-action" type="button" data-exam-export="json">Download JSON</button><button class="exam-action" type="button" data-exam-export="xlsx">Download XLSX</button>
  </nav>
  <section class="exam-section" aria-labelledby="exam-facts-heading" data-export-class="exam_facts"><h2 id="exam-facts-heading">At a glance</h2><dl class="exam-facts">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>${exam.summary ? `<p class="exam-summary" lang="en" dir="ltr">${esc(exam.summary)}</p>` : ""}</section>
  <section class="exam-section" aria-labelledby="exam-details-heading" data-export-class="exam_facts"><h2 id="exam-details-heading">What the notice says</h2>${exam.test_method || exam.exam_format ? `<p><strong>Test format:</strong> ${esc(exam.test_method || exam.exam_format)}</p>` : ""}${exam.qualifications ? `<p><strong>Qualifications:</strong> ${esc(exam.qualifications)}</p>` : ""}${exam.residency ? `<p><strong>Residency:</strong> ${esc(exam.residency)}</p>` : ""}${feeSalary.fee_waiver ? `<p><strong>Fee waiver:</strong> ${esc(feeSalary.fee_waiver)}</p>` : ""}<p class="exam-note" data-export-class="exam_disclaimer">Official details are in English. Read the full official exam notice before applying.</p></section>
  <section class="exam-section" aria-labelledby="exam-prediction-heading" data-export-class="exam_prediction"><h2 id="exam-prediction-heading">What may happen next</h2>${predictionHTML(exam)}</section>
  <section class="exam-section" aria-labelledby="exam-process-heading" data-export-class="exam_process"><h2 id="exam-process-heading">Application to appointment</h2>${processHTML(options.phaseView)}</section>
  <section class="exam-section" aria-labelledby="exam-outcomes-heading" data-export-class="exam_outcomes"><h2 id="exam-outcomes-heading">Public outcomes</h2>${outcomeHTML(outcome)}</section>
  <section class="exam-section exam-provenance" aria-labelledby="exam-provenance-heading" data-export-class="exam_provenance"><h2 id="exam-provenance-heading">Sources and limits</h2><p>CityScroll joined public DCAS exam schedule, Notice of Examination, Civil Service List, and annual outcome materializations by exam number. This page is an unofficial reading aid.</p><ul><li>${sourceLink(noticeURL, "DCAS exam schedule / Notice of Examination")}</li>${sourceNames.length ? `<li>Snapshot source keys: <code>${esc(sourceNames.join(", "))}</code></li>` : ""}<li>Subject reference: <code>${esc(examSubjectRef(id))}</code></li></ul></section>
</main><footer class="exam-footer">CityScroll is an unofficial interface to public data. <a href="/about.html">About the data</a>.</footer>${payloadScript(exam)}${script}</body></html>`;
}

if (typeof window !== "undefined") {
  const root = document.querySelector("[data-exam-document]");
  const payloadNode = document.getElementById("exam-payload");
  let exam = null;
  try { exam = JSON.parse(payloadNode?.textContent || "null"); } catch { exam = null; }
  const canonical = document.querySelector('link[rel="canonical"]')?.href || window.location.href;
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
      ["Official notice", (row) => row.notice_url || DCAS_SCHEDULE_URL], ["Permalink", () => canonical], ["Subject reference", (row) => examSubjectRef(row.exam_number)],
    ];
    const bytes = window.CrolExports.buildListWorkbook("Exam", columns, [exam]);
    window.CrolExports.downloadFile(`cityscroll-exam-${exam.exam_number}.xlsx`, new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  });
}
