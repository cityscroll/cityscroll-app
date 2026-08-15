import {
  BROWSE_OBJECTS,
  BROWSE_FACETS,
  buildBrowseLanding,
  buildBrowseView,
  renderBrowseLanding,
  renderBrowseView,
} from "./browse_view.mjs";
import { buildNowSurface } from "./now_surface.mjs";
import { migrateLegacyUrl } from "./route_migration.mjs";
import { BROWSE_CONCEPTS, buildBrowseConceptLanding, renderBrowseConceptLanding } from "./browse_concept_view.mjs";
import { renderStaffingExamCard, renderStaffingExamResultGroup } from "./staffing_exam_card.mjs";

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findElementRange(html, id) {
  const pattern = new RegExp(`<([a-z][a-z0-9-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i");
  const opening = pattern.exec(html);
  if (!opening) throw new Error(`Missing #${id} in document shell`);
  const tag = opening[1].toLowerCase();
  const tokens = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "ig");
  tokens.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let tagMatch;
  while ((tagMatch = tokens.exec(html))) {
    depth += tagMatch[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return {
        openingStart: opening.index,
        contentStart: opening.index + opening[0].length,
        contentEnd: tagMatch.index,
        closingEnd: tagMatch.index + tagMatch[0].length,
      };
    }
  }
  throw new Error(`Unclosed #${id} in document shell`);
}

export function replaceElementContent(html, id, content) {
  const range = findElementRange(html, id);
  return `${html.slice(0, range.contentStart)}${content}${html.slice(range.contentEnd)}`;
}

function activateTab(html, tab) {
  let out = html
    .replaceAll('class="tabbtn active"', 'class="tabbtn"')
    .replaceAll('class="tabpane active"', 'class="tabpane"');
  const groupPattern = new RegExp(`class="tabbtn"([^>]*\\bdata-route-facets="[^\"]*\\b${tab}\\b[^\"]*")`);
  const tabPattern = new RegExp(`class="tabbtn"([^>]*\\bdata-tab="${tab}")`);
  const grouped = out.replace(groupPattern, 'class="tabbtn active"$1');
  out = grouped.includes('class="tabbtn active"')
    ? grouped
    : out.replace(tabPattern, 'class="tabbtn active"$1');
  out = out.replace(`id="tab-${tab}" class="tabpane"`, `id="tab-${tab}" class="tabpane active"`);
  return out;
}

function pageMetadata(html, { title, description, canonical, primaryHref, primaryContext }) {
  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${esc(canonical)}">`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
    .replace("<main id=\"main\"", '<main id="main" data-document-rendered="true"');
  if (primaryContext) {
    if (/<body\b[^>]*\bdata-primary-context=/i.test(out)) {
      out = out.replace(/(<body\b[^>]*\bdata-primary-context=")[^"]*(")/i, `$1${esc(primaryContext)}$2`);
    } else {
      out = out.replace(/<body\b/i, `<body data-primary-context="${esc(primaryContext)}"`);
    }
  }
  if (!/<base\b/i.test(out)) out = out.replace("<head>", '<head>\n<base href="/">');
  if (primaryHref) {
    out = out.replace(`href="${primaryHref}"`, `href="${primaryHref}" aria-current="page"`);
  }
  return out;
}

function addRouteStyles(html, paths) {
  const links = paths
    .filter((path) => !html.includes(`href="${path}"`))
    .map((path) => `<link rel="stylesheet" href="${path}" data-route-style="${path}">`)
    .join("\n");
  return links ? html.replace("</head>", `${links}\n</head>`) : html;
}

function canonicalRoute(route) {
  return `https://cityscroll.org${route}`;
}

function routeHref(route) {
  if (/^#notice\//.test(route || "")) return migrateLegacyUrl(`/${route}`).target;
  if (/^#/.test(route || "")) return `/${route}`;
  return route || "/browse/";
}

function staticAction(matter) {
  if (matter?.kind === "exam" && matter.official_application_url) {
    return [{
      type: "official_application",
      delivery: "official_handoff",
      destination: matter.official_application_url,
    }];
  }
  return [{ type: "bid_checklist", delivery: "local" }];
}

function nowCard(item) {
  const href = routeHref(item.route);
  const action = item.action?.destination && item.action.destination !== item.route
    ? `<a class="act primary" href="${esc(item.action.destination)}" rel="noopener noreferrer">Take action</a>`
    : `<a class="act primary" href="${esc(href)}">Open details</a>`;
  return `<article class="now-card" data-now-item="${esc(item.id)}" data-now-lane="${esc(item.lane)}">
    <div class="now-card-tags"><span class="tag ${item.lane === "act_by" ? "urgency" : "open"}">${esc(item.kind.replaceAll("_", " "))}</span><span class="tag asset">${esc(item.source.label)}</span></div>
    ${item.time?.value ? `<p class="now-card-when"><time datetime="${esc(item.time.value)}"><b>${esc(item.time.day || item.time.value)}</b></time></p>` : ""}
    <h3><a href="${esc(href)}" lang="en" dir="ltr">${esc(item.title)}</a></h3>
    ${item.agency ? `<p class="now-card-agency" lang="en" dir="ltr">${esc(item.agency)}</p>` : ""}
    <div class="actions">${action}</div>
  </article>`;
}

function nowLane(id, title, deck, items) {
  return `<section class="now-lane" aria-labelledby="${id}-title">
    <header class="now-lane-head"><div><h3 id="${id}-title">${esc(title)}</h3><p>${esc(deck)}</p></div><span class="now-count">${items.length} ${items.length === 1 ? "item" : "items"}</span></header>
    <div class="now-list" data-now-list="${id}" data-now-count="${items.length}">${items.length ? items.map(nowCard).join("") : '<div class="empty">No dated items in the bounded snapshot.</div>'}</div>
  </section>`;
}

export function renderNowBuildView(sources, today) {
  const surface = buildNowSurface(sources, { today, compileActionRail: staticAction });
  const actions = [...surface.act_by.dated, ...surface.act_by.open_without_date];
  const unavailable = surface.coverage.unavailable_sources;
  return `<div class="now-surface" data-build-rendered="now" data-generated-for="${esc(surface.generated_for)}">
    <p class="now-back"><a href="/browse/">Browse city topics</a></p>
    <header class="now-head"><p class="now-kicker">Time + action</p><h2>Now</h2><p>Deadlines that require action and public events happening soon.</p><p class="now-bounded-note">Build-rendered from bounded public snapshots; live sources refresh when JavaScript is available.</p></header>
    ${unavailable.length ? `<div class="note warn" role="status">Live refresh adds: ${esc(unavailable.join(", "))}.</div>` : ""}
    <div class="now-lanes">${nowLane("act-by", "Act by", "Applications, responses, comments, and objections with a published date.", actions)}${nowLane("happening-soon", "Happening soon", "Hearings, meetings, auctions, effective dates, and decisions.", surface.happening_soon.items)}</div>
  </div>`;
}

export function buildNowDocument(shell, sources, options = {}) {
  const today = options.today || sources.money?.open_as_of || sources.money?.generated_at;
  let html = pageMetadata(shell, {
    title: "Now · CityScroll",
    description: "NYC public deadlines that require action and public events happening soon.",
    canonical: canonicalRoute("/now/"),
    primaryHref: "/now/",
    primaryContext: "now",
  });
  html = activateTab(html, "now");
  html = html.replace('id="nowview" hidden', 'id="nowview"');
  html = replaceElementContent(html, "browse-child-nav", "");
  return replaceElementContent(html, "nowview", renderNowBuildView(sources, today));
}

export function buildBrowseLandingDocument(shell, payloads, options = {}) {
  let html = pageMetadata(shell, {
    title: "Browse NYC’s public record · CityScroll",
    description: "Browse NYC contracts, people and organizations, land, rules, meetings, and exams from linked public sources.",
    canonical: canonicalRoute("/browse/"),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  html = activateTab(html, "browse");
  html = addRouteStyles(html, ["browse.css", "walk-entry.css"]);
  const landing = buildBrowseLanding(payloads, options);
  return replaceElementContent(html, "browseview", renderBrowseLanding(landing));
}

function examDate(value) {
  const day = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

function examExternalHref(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" ? url.href : "";
  } catch (_error) {
    return "";
  }
}

function examStatus(exam, today) {
  if (exam?.schedule_status === "canceled") return "canceled";
  if (exam?.schedule_status === "postponed") return "postponed";
  if (!exam?.application_start || !exam?.application_end) return "unscheduled";
  if (today < exam.application_start) return "upcoming";
  if (today <= exam.application_end) return "open";
  return "closed";
}

function examStatusLabel(status) {
  return {
    open: "Open",
    upcoming: "Upcoming",
    closed: "Closed",
    canceled: "Canceled",
    postponed: "Postponed",
    unscheduled: "Unscheduled",
  }[status] || "Unscheduled";
}

function examStatusClass(status) {
  return status === "open" ? "open" : status === "closed" || status === "canceled" ? "closed" : "soon";
}

function examWindow(exam, status) {
  if (status === "open") return `Open through ${examDate(exam.application_end) || "date unavailable"}`;
  if (status === "upcoming") return `Opens ${examDate(exam.application_start) || "date unavailable"}`;
  if (status === "closed") return `Closed ${examDate(exam.application_end) || "date unavailable"}`;
  return examStatusLabel(status);
}

function examOpenBand(exam, status, today) {
  const boundary = status === "open" ? exam.application_end : status === "upcoming" ? exam.application_start : null;
  if (!boundary) return "";
  const days = Math.round((Date.parse(`${boundary}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return "";
  return days <= 14 ? "imminent" : days <= 90 ? "approaching" : "far";
}

function examEdgeState(exam, kind) {
  const href = kind === "eligible-list"
    ? examExternalHref(exam?.eligible_list_url)
    : examExternalHref(exam?.appointment_url);
  if (href) return { state: "published", href };
  if (kind === "eligible-list") {
    const rawCount = exam?.list_aggregate?.list_count;
    const count = Number(rawCount);
    if (rawCount != null && Number.isFinite(count)) return { state: count > 0 ? "published" : "empty", count };
    if (exam?.eligible_list_utilization?.status === "linked") {
      const rawRowCount = exam.eligible_list_utilization.row_count;
      const rowCount = Number(rawRowCount);
      if (rawRowCount != null && Number.isFinite(rowCount)) {
        return { state: rowCount > 0 ? "published" : "empty", count: rowCount };
      }
    }
  } else if (exam?.outcome && typeof exam.outcome === "object") {
    const count = Number(exam.outcome.appointment_count);
    return { state: Number.isFinite(count) && count > 0 ? "published" : "empty", count: Number.isFinite(count) ? count : null };
  }
  return { state: "unknown", count: null };
}

function examEdgeMarkup(exam, kind, label) {
  const edge = examEdgeState(exam, kind);
  const stateLabel = edge.state[0].toUpperCase() + edge.state.slice(1);
  const count = edge.count == null ? "" : ` · ${edge.count.toLocaleString("en-US")}`;
  const body = edge.href
    ? `<a class="act" href="${esc(edge.href)}" rel="noopener noreferrer">${esc(label)}</a>`
    : `<span>${esc(label)} · ${stateLabel}${count}</span>`;
  return `<li data-edge-kind="${esc(kind)}" data-edge-state="${esc(edge.state)}">${body}</li>`;
}

function examEdgesMarkup(exam) {
  return `<section class="career-outcomes exam-family-edges" data-exam-family-edges="1" aria-label="Exam connections">
    <h3 class="career-outcomes-heading">Exam connections</h3>
    <ul class="exam-family-edge-list">${examEdgeMarkup(exam, "eligible-list", "Eligible list")}${examEdgeMarkup(exam, "appointments", "Appointments")}</ul>
  </section>`;
}

function renderExamCard(exam, today) {
  const id = String(exam?.exam_number || "").trim();
  if (!/^\d{4}$/.test(id)) return "";
  const status = examStatus(exam, today);
  const openBand = examOpenBand(exam, status, today);
  const application = examExternalHref(exam.official_application_url);
  const notice = examExternalHref(exam.notice_url);
  const fee = exam.fee != null ? `$${Number(exam.fee).toLocaleString("en-US")}` : "";
  const salary = exam.salary_min != null ? `$${Number(exam.salary_min).toLocaleString("en-US")}` : "";
  const facts = [
    fee ? `<div class="career-action-fact"><b>${esc(fee)}</b><span>Application fee</span></div>` : "",
    salary ? `<div class="career-action-fact"><b>${esc(salary)}</b><span>Starting salary</span></div>` : "",
  ].filter(Boolean).join("");
  const titleCode = String(exam.title_code || "").trim();
  const titleFamily = titleCode
    ? `<p class="career-title-code-family" data-title-code-confidence="publisher" lang="en" dir="ltr"><span>Publisher-issued title code</span>: <code>${esc(titleCode)}</code></p>`
    : "";
  const qualifiers = exam.qualifications
    ? `<p class="career-diff-quals" lang="en" dir="ltr"><b>Qualifications:</b> ${esc(exam.qualifications)}</p>`
    : "";
  const actionFacts = `${facts ? `<div class="career-action-facts">${facts}</div>` : ""}${qualifiers}${exam.list_establishment_forecast ? `<div class="note" data-staffing-list-prediction="1">List establishment forecast: cohort median ${esc(exam.list_establishment_forecast.median_months)} months.</div>` : ""}`;
  const actions = `${status === "open" && application ? `<a class="act primary" href="${esc(application)}" rel="noopener noreferrer">Apply</a>` : ""}${notice ? `<a class="act" href="${esc(notice)}" rel="noopener noreferrer">Official exam notice</a>` : ""}`;
  return renderStaffingExamCard({
    examNumber: id,
    examFormat: esc(exam.exam_format || ""),
    salaryBand: esc(exam.salary_band || ""),
    feeLevel: esc(exam.fee_level || ""),
    status,
    statusMarkup: `<span class="career-status-fact ${examStatusClass(status)}">${examStatusLabel(status)}</span>`,
    openBandMarkup: openBand ? `<span class="tag" data-open-window-band="${esc(openBand)}" lang="en" dir="ltr">${esc(openBand)}</span>` : "",
    noeMarkup: notice ? `<span class="tag" data-noe-state="posted" lang="en" dir="ltr">NOE posted</span>` : "",
    promotionMarkup: exam.eligibility === "promotion" ? `<span class="tag soon">Promotion</span>` : "",
    deadlineMarkup: esc(examWindow(exam, status)),
    titleMarkup: `<a href="/exams/${esc(id)}/" lang="en" dir="ltr">${esc(exam.title || `Exam ${id}`)}</a>`,
    examNumberMarkup: `Exam ${esc(id)}`,
    titleFamilyMarkup: titleFamily,
    actionFactsMarkup: actionFacts,
    outcomesMarkup: examEdgesMarkup(exam),
    actionsMarkup: actions,
  });
}

export function renderBrowseExams(artifact = {}) {
  const exams = Array.isArray(artifact.exams) ? artifact.exams : [];
  const today = examDate(artifact.data_current_as_of || artifact.generated_at) || "9999-12-31";
  const asOf = examDate(artifact.data_current_as_of || artifact.generated_at);
  const groups = [
    ["open", "Open now"],
    ["upcoming", "Upcoming"],
    ["closed", "Closed or completed"],
    ["other", "Other exam records"],
  ].map(([id, label]) => {
    const rows = exams.filter((exam) => {
      const status = examStatus(exam, today);
      return id === "other" ? !["open", "upcoming", "closed"].includes(status) : status === id;
    });
    return renderStaffingExamResultGroup({ id, label, cards: rows.map((exam) => renderExamCard(exam, today)).filter(Boolean).join("") });
  }).join("");
  return `<div class="browse-concept-landing exams-directory" data-build-rendered="browse-exams" data-browse-object-family="exams">
    <p class="now-kicker"><a href="/browse/">Browse</a> · Exams</p>
    <div class="career-guide" data-build-rendered="browse-exams" data-browse-object-family="exams">
      <section class="career-browser" aria-labelledby="exam-directory-heading">
        <div class="career-browser-head"><div><p class="career-kicker">Exams</p><h1 id="exam-directory-heading">Civil-service exams</h1></div><p>${exams.length.toLocaleString("en-US")} exam records${asOf ? ` · snapshot updated ${esc(asOf)}` : ""}. Open an exam for its application window, official notice, and public outcomes.</p></div>
        <div class="career-source" role="status"><span>Build-rendered from the DCAS exam snapshot; related records appear only when the publisher supplies an exact key.</span><a href="/browse/staffing/">Browse Staffing</a></div>
        <div class="career-results" id="career-results">${groups}</div>
      </section>
    </div>
  </div>`;
}

export function buildBrowseExamsDocument(shell, artifact) {
  const config = BROWSE_OBJECTS.exams;
  let html = pageMetadata(shell, {
    title: `${config.title} · Browse · CityScroll`,
    description: config.description,
    canonical: canonicalRoute(config.route),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  html = activateTab(html, config.tab);
  html = html.replace(`class="tabbtn" href="${config.route}"`, `class="tabbtn active" href="${config.route}"`);
  html = addRouteStyles(html, ["browse.css"]);
  return replaceElementContent(html, "examsview", renderBrowseExams(artifact));
}

export function buildBrowseDocument(shell, facet, payload, params = new URLSearchParams(), options = {}) {
  const config = BROWSE_FACETS[facet];
  if (!config) throw new Error(`Unknown Browse facet: ${facet}`);
  const route = options.route || (facet === "contracts" ? "/browse/" : `/browse/${facet}/`);
  const view = buildBrowseView(facet, payload, params);
  let html = pageMetadata(shell, {
    title: `${config.label} · Browse · CityScroll`,
    description: `Browse NYC ${config.label.toLowerCase()} public records by agency, place, status, date, or keyword.`,
    canonical: canonicalRoute(route),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  html = activateTab(html, config.tab);
  html = html.replace(`href="${config.route}"`, `href="${config.route}" aria-current="page"`);
  html = addRouteStyles(html, ["browse.css"]);
  if (facet === "property") html = addRouteStyles(html, ["property.css"]);
  return replaceElementContent(html, config.container, renderBrowseView(view));
}

export function buildBrowseConceptDocument(shell, kind, sources) {
  const config = BROWSE_CONCEPTS[kind];
  if (!config) throw new Error(`Unknown Browse concept: ${kind}`);
  let html = pageMetadata(shell, {
    title: `${config.title} · Browse · CityScroll`,
    description: config.description,
    canonical: canonicalRoute(config.route),
    primaryHref: "/browse/",
    primaryContext: "browse",
  });
  // Concept landings live in the Browse document pane; unlike lens routes they do
  // not have an SPA pane named after the concept. Keep the concept link selected
  // while making the actual static Browse pane visible.
  html = activateTab(html, "browse");
  html = html.replace(`class="tabbtn" href="${config.route}"`, `class="tabbtn active" href="${config.route}"`);
  html = addRouteStyles(html, ["browse.css", "local_constellation.css"]);
  return replaceElementContent(html, "browseview", renderBrowseConceptLanding(buildBrowseConceptLanding(kind, sources)));
}
