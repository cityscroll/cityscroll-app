const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const dollars = (value) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(value) || 0);

export function communityBoardPayrollContextForBoard(model, boardId) {
  const row = (model?.rows || []).find((candidate) => candidate?.board_id === boardId) || null;
  if (!row) return {
    board_id: boardId,
    state: "unknown",
    reason: "No exact Citywide Payroll board binding is available.",
    source: model?.source || null,
  };
  return {
    ...row,
    state: row.measure_state === "available" ? (row.active_row_count === 0 ? "zero_active" : "available") : "unknown",
    source: model.source,
    aggregate_semantics: model.aggregate_semantics,
  };
}

export function renderCommunityBoardPayrollContext(context) {
  if (!context) return "";
  if (context.state === "unknown") return `<section class="node-card civic-object-section" data-community-board-payroll="1" data-payroll-state="unknown"><h2>Citywide Payroll context</h2><p class="node-muted">${esc(context.reason || context.measure_unknown_reason || "Payroll context is unknown for this board.")}</p></section>`;
  const titles = context.title_context?.length
    ? `<ul class="node-record-list">${context.title_context.map((row) => `<li><strong>${esc(row.title_description)}</strong> · ${esc(row.published_row_count)} ACTIVE payroll ${row.published_row_count === 1 ? "row" : "rows"}</li>`).join("")}</ul>`
    : `<p class="node-muted">No ACTIVE title rows were published for this fiscal-year slice.</p>`;
  const pay = context.payroll_dollars || {};
  const status = context.state === "zero_active"
    ? `0 ACTIVE payroll rows; ${context.non_active_row_count} non-ACTIVE published rows.`
    : `${context.active_row_count} ACTIVE payroll rows; ${context.non_active_row_count} non-ACTIVE published rows.`;
  return `<section class="node-card civic-object-section" data-community-board-payroll="1" data-payroll-state="${esc(context.state)}"><h2>Citywide Payroll context</h2><p><strong>FY${esc(context.fiscal_year)} staffing:</strong> ${esc(status)}</p><p class="node-muted">Counts are published payroll rows, not unique people. ACTIVE means leave status as of June 30 was ACTIVE.</p><h3>ACTIVE title context</h3>${titles}<h3>Payroll dollars</h3><dl><div><dt>Regular gross paid</dt><dd>${dollars(pay.regular_gross_paid?.all_published_rows)}</dd></div><div><dt>Overtime paid</dt><dd>${dollars(pay.total_ot_paid?.all_published_rows)}</dd></div><div><dt>Other pay</dt><dd>${dollars(pay.total_other_pay?.all_published_rows)}</dd></div></dl><p class="node-muted">Board totals across all published FY${esc(context.fiscal_year)} rows, including non-ACTIVE rows. These Citywide Payroll pay fields are not an adopted budget, personnel budget, registered-contract value, posted payment total, or unique-person compensation total.</p><details class="inline-disclose"><summary>Source and field meanings</summary><div class="inline-disclose-body"><p>NYC Office of Payroll Administration · Citywide Payroll Data · source vintage ${esc(context.source?.source_vintage || "unknown")}.</p><p>Regular gross paid is the amount paid for base salary during the fiscal year. Overtime paid is total overtime pay. Other pay includes additional compensation such as differentials, lump sums, allowances, retroactive pay, settlements, and bonuses when applicable.</p><p><a href="${esc(context.source?.landing_page || "https://data.cityofnewyork.us/d/k397-673e")}">Open the official Citywide Payroll source</a></p></div></details></section>`;
}
