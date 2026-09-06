/**
 * Resident presentation for the City Record match-coverage disclosure on the
 * Contracts analytical surface.
 *
 * It reports whether an exact City Record award notice was found for each
 * registered contract, and keeps "no exact notice found" and "cannot be
 * evaluated because no PIN is published" as separate states rather than
 * collapsing either into the other.
 *
 * This block lives beside the route module rather than inside it: `app/money-list.mjs`
 * sits against the per-module size gate, and a self-contained panel is what
 * moves out. DOM and copy helpers arrive from the caller (`ui`), the same
 * injection the other shared resident renderers use.
 */
import {
  CITY_RECORD_COVERAGE_DEFAULT_THRESHOLD,
  analyticalDrillThroughHref,
  cityRecordCoverage,
  formatRegisteredValue,
  groupCityRecordCoverage,
} from "./analytical_projection.mjs";

function analyticalCoverageControls(ui) {
  return {
    threshold: Number(ui.$("#analytics-coverage-threshold")?.value || CITY_RECORD_COVERAGE_DEFAULT_THRESHOLD),
    contract_amount_band: ui.$("#analytics-coverage-band")?.value || null,
  };
}

function coveragePercent(value) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function coverageBucketLabel(bucket, ui) {
  return bucket === "exact" ? ui.t("analytics_coverage_exact")
    : bucket === "none" ? ui.t("analytics_coverage_none")
      : ui.t("analytics_coverage_missing_pin");
}

function coverageCell(stat, valueKey) {
  const count = stat?.contract_count || 0;
  const value = stat?.registered_value || 0;
  return `${count.toLocaleString("en-US")} · ${formatRegisteredValue(value)}`;
}

export function openCoverageDestination(panel) {
  if (!panel || panel.tagName !== "DETAILS") return;
  if (location.hash === "#contracts-analytics-coverage") panel.open = true;
}

export function renderCityRecordCoverage(projectionRows, filters, ui) {
  const panel = ui.$("#contracts-analytics-coverage");
  openCoverageDestination(panel);
  const controls = analyticalCoverageControls(ui);
  const coverageFilters = {
    min_amount: controls.threshold,
    registration_fiscal_year: filters.registration_fiscal_year,
    contract_amount_band: controls.contract_amount_band,
    agency: filters.agency,
  };
  const coverage = cityRecordCoverage(projectionRows, coverageFilters);
  const grouped = groupCityRecordCoverage(projectionRows, { groupBy: "agency", ...coverageFilters });
  const summary = ui.$("#contracts-analytics-coverage-summary");
  const statement = ui.$("#contracts-analytics-coverage-statement");
  const table = ui.$("#contracts-analytics-coverage-groups");
  const tableWrap = table?.closest(".table-scroll");
  const note = ui.$("#contracts-analytics-coverage-note");
  if (!coverage.eligible_contract_count) {
    if (summary) summary.innerHTML = "";
    if (statement) statement.textContent = ui.t("analytics_coverage_empty");
    if (table) table.innerHTML = "";
    if (tableWrap) tableWrap.hidden = true;
    if (note) note.textContent = "";
    return;
  }
  if (tableWrap) tableWrap.hidden = false;
  if (summary) {
    summary.innerHTML = [
      ["analytics_coverage_eligible", coverage.eligible_contract_count, coverage.eligible_registered_value],
      ["analytics_coverage_exact", coverage.matched_contract_count, coverage.matched_registered_value],
      ["analytics_coverage_none", coverage.unmatched_contract_count, coverage.unmatched_registered_value],
      ["analytics_coverage_missing_pin", coverage.missing_pin_contract_count, coverage.missing_pin_registered_value],
    ].map(([key, count, value]) => `<div class="contracts-analytics-coverage-stat"><dt>${ui.esc(ui.t(key))}</dt><dd>${Number(count).toLocaleString("en-US")}</dd><small>${ui.esc(formatRegisteredValue(value))}</small></div>`).join("");
  }
  if (statement) {
    statement.textContent = `${ui.t("analytics_coverage_statement", {
      matched: coverage.matched_contract_count.toLocaleString("en-US"),
      eligible: coverage.eligible_contract_count.toLocaleString("en-US"),
      rate: coveragePercent(coverage.match_rate),
      value: formatRegisteredValue(coverage.matched_registered_value),
      total: formatRegisteredValue(coverage.eligible_registered_value),
    })} ${ui.t("analytics_coverage_missing_sentence", {
      count: coverage.missing_pin_contract_count.toLocaleString("en-US"),
      value: formatRegisteredValue(coverage.missing_pin_registered_value),
    })}`;
  }
  if (!table) return;
  table.innerHTML = grouped.groups.map((group) => {
    const link = (bucket) => analyticalDrillThroughHref({
      agency: group.label,
      registration_fiscal_year: filters.registration_fiscal_year,
      contract_amount_band: controls.contract_amount_band,
      min_amount: controls.threshold,
      city_record_match: bucket,
    });
    const exact = group.buckets.exact;
    const none = group.buckets.none;
    const missing = group.buckets.cannot_evaluate_missing_pin;
    return `<tr><th scope="row"><a href="${ui.esc(analyticalDrillThroughHref({ agency: group.label, registration_fiscal_year: filters.registration_fiscal_year, contract_amount_band: controls.contract_amount_band, min_amount: controls.threshold }))}">${ui.esc(group.label)}</a></th><td>${group.eligible_contract_count.toLocaleString("en-US")} · ${ui.esc(formatRegisteredValue(group.eligible_registered_value))}</td><td><a href="${ui.esc(link("exact"))}" aria-label="${ui.esc(`${group.label}: ${coverageBucketLabel("exact", ui)}`)}">${ui.esc(coverageCell(exact))}</a></td><td><a href="${ui.esc(link("none"))}" aria-label="${ui.esc(`${group.label}: ${coverageBucketLabel("none", ui)}`)}">${ui.esc(coverageCell(none))}</a></td><td><a href="${ui.esc(link("cannot_evaluate_missing_pin"))}" aria-label="${ui.esc(`${group.label}: ${coverageBucketLabel("cannot_evaluate_missing_pin", ui)}`)}">${ui.esc(coverageCell(missing))}</a></td></tr>`;
  }).join("");
  if (note) note.textContent = ui.t("analytics_coverage_note", {
    evaluable: coverage.evaluable_match_rate == null ? "—" : coveragePercent(coverage.evaluable_match_rate),
  });
}
