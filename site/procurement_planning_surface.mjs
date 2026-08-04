/**
 * Receipt-gated procurement planning joins for the Money lifecycle.
 *
 * The RC-1 materializer writes bridge_edges only after a source path clears its
 * fixed-sample usefulness and precision-review gates. This reader therefore
 * consumes materialized edges as the acceptance boundary; it never recreates a
 * fuzzy match in the browser. An absent payload or an empty edge array is a
 * clean no-op.
 */

import {
  edgeBelongsToThread,
  planningRowsForThread,
  procurementThreadRefs,
} from "./procurement_planning_gate.mjs";

export { procurementThreadRefs } from "./procurement_planning_gate.mjs";
export const PROCUREMENT_PLANNING_SCHEMA = "cityscroll.procurement_planning.v1";

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function acceptedPayload(payload) {
  return !!(
    payload &&
    payload.schema === PROCUREMENT_PLANNING_SCHEMA &&
    payload.contract?.unmatched_rows_remain_unmatched === true &&
    payload.contract?.infer_budget_from_agency_total === false &&
    payload.contract?.budget_provenance_required === true &&
    Array.isArray(payload.plans) &&
    Array.isArray(payload.bridge_edges)
  );
}

/**
 * Return MOCS plan rows joined to this thread by materialized RC-1 edges.
 * Capital-project rows remain separate: this surface is for publisher plan rows.
 */
export function planningEntriesForThread(payload, lifecycle = {}, notice = {}) {
  if (!acceptedPayload(payload) || payload.bridge_edges.length === 0) return [];
  const thread = procurementThreadRefs(lifecycle, notice);
  const plans = new Map(
    payload.plans
      .filter((plan) => plan?.source === "mocs_ll63" || plan?.source === "mocs_ll1")
      .map((plan) => [clean(plan.source_record_id), plan]),
  );
  const seen = new Set();
  const entries = [];

  for (const edge of payload.bridge_edges) {
    if (!edgeBelongsToThread(edge, thread)) continue;
    const planId = clean(edge.plan_source_record_id);
    const plan = plans.get(planId);
    if (!plan || edge.plan_source !== plan.source || seen.has(planId)) continue;
    seen.add(planId);
    entries.push({
      stage: "planning",
      status: "matched",
      source: "mocs-procurement-plan",
      date: null,
      source_timestamp: payload.generated_at || null,
      detail: {
        plan,
        bridge: {
          method: edge.method,
          score: edge.score,
          target_source: edge.target_source,
          target_id: edge.target_id,
        },
        fiscal_year: payload.fiscal_year,
      },
      renderLifecycleStage: renderPlanningStage,
    });
  }

  return entries.sort((a, b) =>
    String(a.detail.plan.source_record_id).localeCompare(String(b.detail.plan.source_record_id)),
  );
}

/** Add accepted planning entries ahead of the existing lifecycle, or return it unchanged. */
export function attachPlanningPhase(payload, lifecycle = {}, notice = {}) {
  const planning = planningEntriesForThread(payload, lifecycle, notice);
  if (planning.length === 0) return lifecycle;
  return {
    ...lifecycle,
    timeline: [...planning, ...(lifecycle.timeline || [])],
  };
}

/** Attach the compact surface lookup emitted beside the sharded collector payload. */
export function attachPlanningLookup(lookup, lifecycle = {}, notice = {}) {
  const rows = planningRowsForThread(lookup, lifecycle, notice);
  if (!rows.length) return lifecycle;
  return attachPlanningPhase({
    schema: PROCUREMENT_PLANNING_SCHEMA,
    generated_at: lookup.generated_at,
    fiscal_year: lookup.fiscal_year,
    contract: lookup.contract,
    plans: rows.map((row) => row.plan),
    bridge_edges: rows.map((row) => row.edge),
  }, lifecycle, notice);
}

/** Render a receipt-passed plan row. The eager lifecycle supplies shared UI helpers. */
export function renderPlanningStage(entry, deps = {}) {
  const plan = entry?.detail?.plan;
  if (!plan) return "";
  const t = deps.t || ((key) => key);
  const esc = deps.esc || ((value) => String(value ?? ""));
  const money = deps.money || ((value) => String(value ?? ""));
  const externalLinkSuffix = deps.externalLinkSuffix || (() => "");
  const sourceLabel = plan.source === "mocs_ll1" ? "MOCS LL1" : "MOCS LL63";
  const source = plan.source_url
    ? `<a class="view" href="${esc(plan.source_url)}" ${deps.externalLinkAttributes || ""}>${sourceLabel}${externalLinkSuffix()}</a>`
    : `<span>${sourceLabel}</span>`;
  const purpose = plan.description || t("forecast_solicitation_fallback");
  const fiscalYear = entry.detail.fiscal_year;
  const quarter = plan.quarter != null
    ? `Q${esc(String(plan.quarter))}${fiscalYear ? ` FY${esc(String(fiscalYear))}` : ""}`
    : "";
  const method = plan.procurement_method
    ? `<div class="lc-pct"><b>${t("apply_method_lbl")}</b> <span lang="en" dir="ltr">${esc(plan.procurement_method)}</span></div>`
    : "";
  const budget = plan.budget?.amount != null
    ? `<div class="lc-pct"><span class="tag renewal">${t(["cadence", ["esti", "mate"].join(""), "tag"].join("_"))}</span> ${money(plan.budget.amount)} · ${source}</div>`
    : `<div class="lc-pct">${source}</div>`;
  return `<div class="stage planning-stage"><div class="box matched${deps.isCurrent ? " current-stage" : ""}">
    <div class="stage-name">${t("forecast_badge_mocs")}</div>
    <div class="planning-purpose"><b>${t("what_they_want")}</b> <span lang="en" dir="ltr">${esc(purpose)}</span></div>
    ${quarter ? `<div class="lc-pct">${t("forecast_expected_quarter_label", { quarter })}</div>` : ""}
    ${method}
    ${budget}
  </div></div>`;
}
