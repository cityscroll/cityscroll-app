/**
 * Resident presentation for registration timing and the buyer's contracting
 * history (the `#buyer-history` panel on the Contracts analytical surface).
 *
 * The measure and the panel are one subject: how many of a buyer's registered
 * contracts were registered after the contract's own start date, and what the
 * reader is allowed to conclude from that. Keeping the rendering here rather
 * than in the route module keeps the route thin and puts every honesty rule
 * for this measure in one file.
 *
 * Every entry point takes its DOM and copy helpers from the caller (`ui`), the
 * same injection the other shared resident renderers use, so this module never
 * reaches for a route-module global.
 */
import {
  BUYER_HISTORY_TIMING_STATES,
  buyerContractingHistory,
  buyerContractingHistoryFailure,
  buyerHistoryDismissInspectHref,
  buyerHistoryInspectHref,
  inspectBuyerHistoryCase,
  openedBuyerHistoryCases,
} from "./buyer_contracting_history.mjs";
import { formatRegisteredValue } from "./analytical_projection.mjs";

export function syncBuyerHistoryComparisonControls(rows, urlFilters, ui){
  for(const [selector, field, allKey] of [
    ["#analytics-industry", "industry", "buyer_history_all_industries"],
    ["#analytics-award-method", "award_method", "buyer_history_all_award_methods"],
  ]){
    const select=$(selector);
    if(!select) continue;
    const current=urlFilters?.[field] || select.value;
    const values=[...new Set((rows||[]).map(row=>row?.[field]).filter(value=>typeof value === "string" && value.trim()))].sort();
    select.innerHTML=`<option value="">${ui.esc(ui.t(allKey))}</option>`
      +values.map(value=>`<option value="${ui.esc(value)}">${ui.esc(value)}</option>`).join("");
    select.value=values.includes(current) ? current : "";
  }
}

function formatLagDays(value, ui){
  return value == null ? ui.t("analytics_not_available") : `${Number(value).toLocaleString("en-US")} ${ui.t("analytics_days")}`;
}

function timingMetricHTML(label, value, ui, className=""){
  return `<div class="contracts-analytics-timing-metric ${className}"><strong>${ui.esc(value)}</strong><span>${ui.esc(label)}</span></div>`;
}

export function renderRegistrationTimingMetrics(summary, populationInfo, ui){
  const eligible = summary.eligible_contract_count.toLocaleString("en-US");
  const retroactive = summary.retroactive_contract_count.toLocaleString("en-US");
  const rate = summary.retroactive_share == null ? ui.t("analytics_not_available") : `${(summary.retroactive_share * 100).toFixed(1)}%`;
  const headline = summary.retroactive_share == null
    ? ui.t("analytics_timing_no_rate", { eligible })
    : ui.t("analytics_timing_headline", { rate, retroactive, eligible });
  const populationElement = ui.$("#contracts-analytics-population");
  if(populationElement) populationElement.textContent = `${headline} · ${populationInfo.year_label}. ${ui.t("analytics_population_suffix")} ${ui.t("analytics_timing_missing", { missing: summary.missing_date_contract_count.toLocaleString("en-US"), total: summary.total_contract_count.toLocaleString("en-US"), share: summary.missing_date_share == null ? ui.t("analytics_not_available") : `${(summary.missing_date_share * 100).toFixed(1)}%` })}`;
  const metrics = ui.$("#contracts-analytics-timing");
  if(metrics) metrics.innerHTML = [
    timingMetricHTML(ui.t("analytics_metric_eligible"), eligible, ui),
    timingMetricHTML(ui.t("analytics_metric_missing"), summary.missing_date_contract_count.toLocaleString("en-US"), ui),
    timingMetricHTML(ui.t("analytics_metric_retroactive"), retroactive, ui),
    timingMetricHTML(ui.t("analytics_metric_median"), formatLagDays(summary.median_lag_days, ui), ui),
    timingMetricHTML(ui.t("analytics_metric_p75"), formatLagDays(summary.p75_lag_days, ui), ui),
    timingMetricHTML(ui.t("analytics_metric_p90"), formatLagDays(summary.p90_lag_days, ui), ui),
  ].join("");
  return headline;
}

function buyerHistoryMetricHTML(label, value, ui){
  return `<div class="buyer-history-metric"><strong>${ui.esc(value)}</strong><span>${ui.esc(label)}</span></div>`;
}

function formatInspectTiming(record, ui){
  if (record?.registration_lag_days == null) return ui.t("analytics_not_available");
  const days = Math.abs(Number(record.registration_lag_days)).toLocaleString("en-US");
  if (Number(record.registration_lag_days) > 0) return ui.t("buyer_history_inspect_after_start", { days });
  if (Number(record.registration_lag_days) < 0) return ui.t("buyer_history_inspect_before_start", { days });
  return ui.t("buyer_history_inspect_on_start");
}

function inspectFieldHTML(label, value, ui){
  return `<div class="buyer-history-inspect-field"><dt>${ui.esc(label)}</dt><dd>${ui.esc(value ?? ui.t("analytics_not_available"))}</dd></div>`;
}

function renderBuyerHistoryInspect(history, urlFilters, ui){
  const panel = ui.$("#buyer-history-inspect");
  if (!panel) return null;
  const requestedId = urlFilters.inspect;
  if (!requestedId) {
    panel.hidden = true;
    panel.innerHTML = "";
    return null;
  }
  const inspected = inspectBuyerHistoryCase(history, requestedId, {
    agency: urlFilters.agency,
    registration_fiscal_year: urlFilters.registration_fiscal_year,
    industry: urlFilters.industry,
    award_method: urlFilters.award_method,
    candidates: urlFilters.destination_candidates,
    source_conflicts: urlFilters.source_conflicts,
  });
  panel.hidden = false;
  const dismissHref = buyerHistoryDismissInspectHref(urlFilters.inspect_href || `${location.pathname}${location.search}`);
  if (inspected.state !== "available") {
    panel.innerHTML = [
      `<h4 id="buyer-history-inspect-heading">${ui.esc(ui.t("buyer_history_inspect_heading", { id: requestedId }))}</h4>`,
      `<p class="buyer-history-inspect-status" role="status">${ui.esc(ui.t("buyer_history_inspect_unavailable", { id: requestedId }))}</p>`,
      `<p class="buyer-history-inspect-actions">`,
      `<a href="${ui.esc(dismissHref)}">${ui.esc(ui.t("buyer_history_inspect_dismiss"))}</a>`,
      `<button type="button" class="act mini" id="buyer-history-inspect-retry" data-inspect-id="${ui.esc(requestedId)}">${ui.esc(ui.t("buyer_history_inspect_retry"))}</button>`,
      `</p>`,
    ].join("");
    return inspected;
  }
  const record = inspected.case;
  const amount = record.current_registered_amount == null
    ? ui.t("analytics_not_available")
    : formatRegisteredValue(record.current_registered_amount);
  const destinations = inspected.destinations.map((destination) => {
    const label = destination.kind === "notice"
      ? ui.t("buyer_history_inspect_notice")
      : ui.t("buyer_history_inspect_procurement");
    return `<li><a href="${ui.esc(destination.href)}" data-destination-kind="${ui.esc(destination.kind)}" data-destination-basis="${ui.esc(destination.basis)}">${ui.esc(label)}</a></li>`;
  }).join("");
  panel.innerHTML = [
    `<h4 id="buyer-history-inspect-heading">${ui.esc(ui.t("buyer_history_inspect_heading", { id: record.source_contract_id }))}</h4>`,
    `<dl class="buyer-history-inspect-fields">`,
    inspectFieldHTML(ui.t("buyer_history_inspect_buyer"), record.buyer, ui),
    inspectFieldHTML(ui.t("buyer_history_inspect_vendor"), record.vendor, ui),
    inspectFieldHTML(ui.t("buyer_history_inspect_contract_id"), record.source_contract_id, ui),
    inspectFieldHTML(ui.t("buyer_history_inspect_purpose"), record.purpose, ui),
    inspectFieldHTML(ui.t("buyer_history_inspect_amount"), amount, ui),
    inspectFieldHTML(ui.t("buyer_history_inspect_start"), record.contract_start_date, ui),
    inspectFieldHTML(ui.t("buyer_history_inspect_registered"), record.registration_date, ui),
    inspectFieldHTML(ui.t("buyer_history_inspect_timing"), formatInspectTiming(record, ui), ui),
    `</dl>`,
    destinations
      ? `<div class="buyer-history-inspect-destinations"><p>${ui.esc(ui.t("buyer_history_inspect_destinations"))}</p><ul>${destinations}</ul></div>`
      : "",
    `<p class="buyer-history-inspect-actions"><a href="${ui.esc(dismissHref)}">${ui.esc(ui.t("buyer_history_inspect_dismiss"))}</a></p>`,
  ].join("");
  return inspected;
}

function renderBuyerHistoryCases(history, urlFilters, ui){
  const list = ui.$("#buyer-history-cases");
  if (!list) return [];
  const show = urlFilters.cases || urlFilters.inspect;
  if (!show || !history || history.state !== "available" || !history.contract_count) {
    list.hidden = true;
    list.innerHTML = "";
    return [];
  }
  const opened = openedBuyerHistoryCases(history, { retroactive: urlFilters.retroactive });
  const cohortHref = urlFilters.retroactive ? history.after_start_cases_href : history.all_cases_href;
  list.hidden = false;
  list.innerHTML = [
    `<h4 id="buyer-history-cases-heading">${ui.esc(ui.t("buyer_history_cases_heading"))}</h4>`,
    `<p class="buyer-history-cases-count" role="status">${ui.esc(ui.t("buyer_history_cases_count", { count: opened.length.toLocaleString("en-US") }))}</p>`,
    `<ul class="buyer-history-case-list">${opened.map((entry) => {
      const href = buyerHistoryInspectHref(cohortHref, entry.source_contract_id);
      const selected = urlFilters.inspect === entry.source_contract_id ? " aria-current=\"true\"" : "";
      return `<li><a href="${ui.esc(href)}" data-contract-id="${ui.esc(entry.source_contract_id)}"${selected}>${ui.esc(ui.t("buyer_history_inspect_open", { id: entry.source_contract_id }))}</a><span>${ui.esc(entry.vendor || ui.t("analytics_not_available"))} · ${ui.esc(entry.purpose || ui.t("analytics_not_available"))}</span></li>`;
    }).join("")}</ul>`,
  ].join("");
  return opened;
}

/**
 * Render the buyer's scoped registered contracting history.
 *
 * The buyer, the fiscal year, and what the metric means stay visible in every
 * state, including the states where the metric itself cannot be shown. An
 * unavailable measurement and a measurement of zero are rendered differently
 * on purpose: reporting "0 registered after start" for a population whose
 * dates were never published would be a claim about the buyer that the source
 * does not support.
 */
export function renderBuyerHistoryPanel(projectionRows, registeredProjection, urlFilters, controls, ui){
  const panel=ui.$("#buyer-history");
  if(!panel) return null;
  const buyer=urlFilters.agency;
  // The section belongs to a chosen buyer. Without one there is no history to
  // scope, so it stays out of the page rather than showing a citywide total
  // under a buyer heading.
  panel.hidden=!buyer;
  if(!buyer) return null;
  const fiscalYear=controls.registration_fiscal_year || urlFilters.registration_fiscal_year || null;
  const history=projectionRows
    ? buyerContractingHistory(projectionRows, {
      agency: buyer,
      registration_fiscal_year: fiscalYear,
      industry: controls.industry || urlFilters.industry,
      award_method: controls.award_method || urlFilters.award_method,
      contract_amount_band: urlFilters.contract_amount_band,
      min_amount: controls.min_amount || urlFilters.min_amount,
      max_amount: controls.max_amount || urlFilters.max_amount,
      snapshot_date: registeredProjection?.snapshot_date,
      generated_at: registeredProjection?.generated_at,
      population_definition: registeredProjection?.population_definition,
    })
    : buyerContractingHistoryFailure({
      agency: buyer,
      registration_fiscal_year: fiscalYear,
      industry: controls.industry || urlFilters.industry,
      award_method: controls.award_method || urlFilters.award_method,
      reason: "source-request-failed",
    });
  const unavailable=history.state !== "available";
  const count=unavailable ? null : history.contract_count.toLocaleString("en-US");
  const scope=ui.$("#buyer-history-scope");
  if(scope){
    scope.textContent=unavailable
      ? ui.t("buyer_history_unavailable")
      : history.registration_fiscal_year == null
        ? ui.t("buyer_history_scope_all_years", { buyer, count })
        : ui.t("buyer_history_scope", { buyer, year: history.registration_fiscal_year, count });
  }
  const metrics=ui.$("#buyer-history-metrics");
  if(metrics){
    const notMeasured=ui.t("buyer_history_not_measured");
    metrics.innerHTML=[
      buyerHistoryMetricHTML(ui.t("buyer_history_metric_contracts"), unavailable ? ui.t("analytics_not_available") : count, ui),
      buyerHistoryMetricHTML(ui.t("buyer_history_metric_after_start"), history.timing.measurable
        ? history.timing.after_start_count.toLocaleString("en-US") : notMeasured, ui),
      buyerHistoryMetricHTML(ui.t("buyer_history_metric_before_on_start"), history.timing.measurable
        ? history.timing.early_on_time_count.toLocaleString("en-US") : notMeasured, ui),
    ].join("");
  }
  const meaning=ui.$("#buyer-history-meaning");
  if(meaning){
    meaning.textContent=history.timing.state === BUYER_HISTORY_TIMING_STATES.NOT_MATERIALIZED && !unavailable
      ? `${ui.t("buyer_history_meaning")} ${ui.t("buyer_history_timing_unavailable")}`
      : ui.t("buyer_history_meaning");
  }
  const actions=ui.$("#buyer-history-actions");
  if(actions){
    if(unavailable){
      actions.innerHTML="";
    } else if(history.contract_count === 0){
      actions.textContent=ui.t("buyer_history_no_contracts");
    } else {
      // Both actions are ordinary links: they survive a modified click, a
      // no-JS load, and browser Back with the comparison still selected.
      actions.innerHTML=[
        `<a href="${ui.esc(history.all_cases_href)}">${ui.esc(ui.t("buyer_history_all_cases", { count }))}</a>`,
        history.after_start_cases_href
          ? `<a href="${ui.esc(history.after_start_cases_href)}">${ui.esc(ui.t("buyer_history_after_start_cases", { count: history.timing.after_start_count.toLocaleString("en-US") }))}</a>`
          : "",
      ].filter(Boolean).join("");
    }
  }
  const retry=ui.$("#buyer-history-retry");
  if(retry) retry.hidden=!unavailable;
  const source=ui.$("#buyer-history-source");
  if(source){
    source.textContent=unavailable ? "" : ui.t("buyer_history_source", {
      observed: history.source_observation.snapshot_date || ui.t("analytics_not_available"),
    });
  }
  const inspectHref = urlFilters.inspect_href
    || (typeof location !== "undefined" ? `${location.pathname}${location.search}` : history.all_cases_href);
  renderBuyerHistoryCases(history, urlFilters, ui);
  renderBuyerHistoryInspect(history, { ...urlFilters, inspect_href: inspectHref }, ui);
  return history;
}
