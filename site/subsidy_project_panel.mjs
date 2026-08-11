// Receipt-backed NYCEDC/NYCIDA/Build NYC project identity panel.
// Pure renderer: no fetch, DOM, or i18n globals. It reuses the shared notice-fact
// panel classes established by the prime-award snapshot.

export const SUBSIDY_PROJECT_PANEL_SCHEMA = "cityscroll.subsidy_project_panel.v1";

export function buildSubsidyProjectPanelView(payload) {
  const projects = [];
  for (const row of payload?.project_identity || []) {
    if (row?.receipt_backed !== true || Number(row.join_confidence) < 1) continue;
    if (!clean(row.project_name) || !clean(row.company)) continue;
    const official_documents_url = safeOfficialUrl(row.official_documents_url);
    if (!official_documents_url) continue;
    const lifecycle_dates = (row.lifecycle_dates || [])
      .filter((item) => item?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date)))
      .map((item) => ({
        stage: clean(item.stage),
        date: String(item.date),
        ...(clean(item.outcome) ? { outcome: clean(item.outcome) } : {}),
        ...(clean(item.status) ? { status: clean(item.status) } : {}),
      }));
    projects.push({
      project_name: clean(row.project_name),
      company: clean(row.company),
      address: clean(row.address),
      requested_benefit: finiteOrNull(row.requested_benefit),
      estimated_public_cost: finiteOrNull(row.estimated_public_cost),
      project_cost: finiteOrNull(row.project_cost),
      lifecycle_dates,
      official_documents_url,
    });
  }
  return {
    schema: SUBSIDY_PROJECT_PANEL_SCHEMA,
    show: projects.length > 0,
    count: projects.length,
    projects,
  };
}

export function subsidyProjectPanelHTML(payloadOrView, opts = {}) {
  const view = payloadOrView?.schema === SUBSIDY_PROJECT_PANEL_SCHEMA
    ? payloadOrView
    : buildSubsidyProjectPanelView(payloadOrView);
  if (!view.show || view.count !== view.projects.length) return "";

  const t = typeof opts.t === "function" ? opts.t : defaultT;
  const esc = typeof opts.esc === "function" ? opts.esc : defaultEsc;
  const money = typeof opts.money === "function" ? opts.money : defaultMoney;
  const date = typeof opts.date === "function" ? opts.date : defaultDate;
  const externalSuffixHTML = typeof opts.externalSuffixHTML === "function"
    ? opts.externalSuffixHTML()
    : "";

  const projects = view.projects.map((project) => {
    const facts = [];
    facts.push(factRow(t("subsidy_project_company_lbl"), project.company, esc));
    if (project.address) facts.push(factRow(t("subsidy_project_address_lbl"), project.address, esc));
    if (project.project_cost != null) {
      facts.push(factRow(t("subsidy_money_total_project_cost_lbl"), money(project.project_cost), esc));
    }
    if (project.requested_benefit != null) {
      facts.push(factRow(t("subsidy_money_requested_lbl"), money(project.requested_benefit), esc));
    }
    if (project.estimated_public_cost != null) {
      facts.push(factRow(t("subsidy_money_estimated_lbl"), money(project.estimated_public_cost), esc));
    }
    const dates = project.lifecycle_dates.length
      ? `<div class="notice-fact-row sub-outreach-row" data-field="lifecycle-dates">
          <div class="stage-name">${esc(t("subsidy_project_lifecycle_dates_lbl"))}</div>
          <div class="notice-fact-chips sub-outreach-chips">${project.lifecycle_dates.map((item) => {
            const label = t(`subsidy_stage_${item.stage}`);
            return `<time class="tag" datetime="${esc(item.date)}" data-date-chip="1">${esc(label)} · ${esc(date(item.date))}</time>`;
          }).join(" ")}</div>
        </div>`
      : "";
    return `<article class="notice-fact-item" data-subsidy-project="1">
      <h3 lang="en" dir="ltr">${esc(project.project_name)}</h3>
      ${facts.join("\n")}
      ${dates}
      <a class="view" href="${esc(project.official_documents_url)}" target="_blank" rel="noopener noreferrer">${esc(t("subsidy_project_documents_link"))}${externalSuffixHTML}</a>
    </article>`;
  }).join("\n");

  return `<section class="notice-fact-detail sub-outreach-detail" data-subsidy-project-panel="1" data-project-count="${view.count}" aria-label="${esc(t("subsidy_project_heading"))}">
    <div class="chain-h">${esc(t("subsidy_project_heading"))} <span class="count">${view.count}</span></div>
    <div class="notice-fact-list">${projects}</div>
  </section>`;
}

function factRow(label, value, esc) {
  return `<div class="notice-fact-row sub-outreach-row">
    <div class="stage-name">${esc(label)}</div>
    <div lang="en" dir="ltr">${esc(value)}</div>
  </div>`;
}

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function finiteOrNull(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function safeOfficialUrl(value) {
  const text = clean(value);
  if (!text || !/^https:\/\/edc\.nyc\//.test(text)) return null;
  return text;
}

function defaultEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function defaultMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function defaultDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function defaultT(key) {
  const values = {
    subsidy_project_heading: "Official project records",
    subsidy_project_company_lbl: "Company",
    subsidy_project_address_lbl: "Project address",
    subsidy_money_total_project_cost_lbl: "Total project cost",
    subsidy_money_requested_lbl: "Requested benefit",
    subsidy_money_estimated_lbl: "Estimated public cost",
    subsidy_project_lifecycle_dates_lbl: "Lifecycle dates",
    subsidy_stage_application: "Application",
    subsidy_stage_board_decision: "Board decision",
    subsidy_stage_closing: "Closing",
    subsidy_stage_compliance: "Compliance",
    subsidy_project_documents_link: "Official project documents",
  };
  return values[key] || key;
}
