/**
 * Operator-facing HTML for the exact-matter refresh receipt.
 *
 * This is not a resident control. It reports attempted, retained, deferred,
 * and failed work plus last-complete refresh times. Copy stays source-honest.
 */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusLabel(status) {
  if (status === "complete") return "Complete refresh";
  if (status === "partial") return "Partial refresh — not current";
  if (status === "failed") return "Refresh failed — last-good history kept";
  if (status === "deferred") return "Deferred to a later run";
  if (status === "never") return "Not yet attempted";
  return "Acquisition status not stated";
}

function gateCopy(summary) {
  if (summary?.source_gate === "passed") {
    return "The documented Histories route is activated from a retained authenticated response.";
  }
  return "The documented Histories source gate has not passed. This run used the bounded EventItems-by-matter adapter. That is not a claim that NYC Histories was verified.";
}

export function renderMatterExactRefreshOperatorHtml(view, options = {}) {
  const title = options.title || "Exact matter refresh";
  const route = options.route || "/operator/matter-refresh/";
  const summary = view?.summary || {};
  const receipt = view?.receipt || {};
  const roster = Array.isArray(view?.roster) ? view.roster : [];
  const retryHref = options.retryHref || "#receipt";
  const matters = roster.map((row) => `
    <article class="matter" data-matter="${escapeHtml(row.matter_id)}" data-status="${escapeHtml(row.acquisition_status || "never")}">
      <h3>Matter ${escapeHtml(row.matter_id)}</h3>
      <p class="kicker">${escapeHtml(row.kind || "roster")}</p>
      <p>${escapeHtml(statusLabel(row.acquisition_status))}</p>
      <p>Last attempt ${escapeHtml(row.last_attempt_at || "not recorded")}. Last complete refresh ${escapeHtml(row.last_complete_refresh_at || "not yet complete")}.</p>
      <p>${row.last_error ? `Last error ${escapeHtml(row.last_error)}.` : "No error is recorded."}</p>
    </article>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; max-width: 100%; }
  body { padding: 16px; font: 18px/1.5 system-ui, sans-serif; color: #1b2430; background: #f4f1ea; }
  main { max-width: 960px; margin: 0 auto; overflow-wrap: anywhere; word-break: break-word; }
  h1 { font-size: 1.6rem; margin: 0 0 8px; }
  h2 { font-size: 1.25rem; margin: 24px 0 8px; }
  h3 { font-size: 1.05rem; margin: 16px 0 8px; }
  .skip { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .skip:focus { width: auto; height: auto; clip: auto; inset: 16px auto auto 16px; background: #fff; padding: 8px 12px; z-index: 2; }
  .summary, .receipt, .matter { background: #fff; border: 1px solid #d7d0c4; border-radius: 10px; padding: 16px; margin: 0 0 16px; }
  .kicker { font-size: 0.9rem; letter-spacing: 0.02em; color: #5b5044; text-transform: uppercase; }
  .counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 16px 0; }
  .counts div { background: #f4f1ea; border-radius: 8px; padding: 12px; }
  .node-action { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 10px 14px; border: 1px solid #144a8c; border-radius: 8px; color: #144a8c; text-decoration: none; }
  .node-action:focus-visible, summary:focus-visible, .skip:focus-visible {
    outline: 3px solid #b8471f; outline-offset: 2px;
  }
  details { margin: 16px 0; }
  summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
  @media (max-width: 420px) {
    body { padding: 12px; }
    h1 { font-size: 1.35rem; }
  }
</style>
</head>
<body>
<a class="skip" href="#receipt">Skip to refresh receipt</a>
<main id="receipt" data-route="${escapeHtml(route)}" data-status="${escapeHtml(summary.status || "never")}" data-current="${summary.current ? "true" : "false"}" data-attempted="${escapeHtml(summary.attempted || 0)}" data-retained="${escapeHtml(summary.retained || 0)}" data-deferred="${escapeHtml(summary.deferred || 0)}" data-failed="${escapeHtml(summary.failed || 0)}" data-source-gate="${escapeHtml(summary.source_gate || "not-passed")}">
  <h1>${escapeHtml(title)}</h1>
  <section class="summary">
    <p class="kicker">${escapeHtml(statusLabel(summary.status))}</p>
    <p>${escapeHtml(gateCopy(summary))}</p>
    <p>Budget exhaustion is reported as partial. It is never marked current.</p>
    <div class="counts">
      <div><strong data-count="attempted">${escapeHtml(summary.attempted || 0)}</strong><p>Attempted</p></div>
      <div><strong data-count="retained">${escapeHtml(summary.retained || 0)}</strong><p>Retained complete</p></div>
      <div><strong data-count="deferred">${escapeHtml(summary.deferred || 0)}</strong><p>Deferred</p></div>
      <div><strong data-count="failed">${escapeHtml(summary.failed || 0)}</strong><p>Failed</p></div>
    </div>
    <p><a class="node-action" href="${escapeHtml(retryHref)}">Retry recovery</a></p>
  </section>
  <section class="receipt">
    <h2>Last run</h2>
    <p>Adapter ${escapeHtml(summary.adapter || "event-items-by-matter")}. Run ${escapeHtml(receipt.run_id || "none")}.</p>
    <p>${receipt.reason ? `Reason ${escapeHtml(receipt.reason)}.` : "No failure reason is recorded on this run."}</p>
  </section>
  <section>
    <h2>Roster</h2>
    ${matters || "<p>No exact matters are on the refresh roster.</p>"}
  </section>
  <details>
    <summary>Source and acquisition details</summary>
    <p>This page reads retained D1 receipts. It does not contact a publisher. Exact-matter refresh is scheduled independently of City Record notices and the 180-day discovery lookback.</p>
    <p>Last-good journal rows remain when a page, token, or rate-limit failure stops a run.</p>
  </details>
  <p><a class="node-action" href="#receipt">Return to receipt summary</a></p>
</main>
</body>
</html>`;
}
