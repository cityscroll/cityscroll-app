/**
 * Operator-facing HTML for matter coverage and recovery receipts.
 *
 * This is not a resident control. Copy stays source-honest and never includes
 * subscriber addresses.
 */

import { ALERT_CLASS, RECOVERY_PLAYBOOK } from "../../../site/matter_coverage_recovery.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hours(ms) {
  if (ms == null) return "not recorded";
  return `${Math.round(Number(ms) / 36e5)} hours`;
}

function failureCopy(value) {
  if (value === ALERT_CLASS.STALE_REFRESH) return "An eligible active watch has gone 48 hours without a complete refresh.";
  if (value === ALERT_CLASS.PUBLICATION_LAG) return "Publication trails retained eligible changes by two scheduled cycles.";
  if (value === ALERT_CLASS.DELIVERY_LAG) return "Pending delivery has exceeded two scheduled cycles.";
  if (value === ALERT_CLASS.ACQUISITION_FAILED) return "Acquisition failed and last-good history was kept.";
  if (value === ALERT_CLASS.MIXED) return "More than one coverage fault is open.";
  return "No coverage alert is open.";
}

export function renderMatterCoverageRecoveryOperatorHtml(view, options = {}) {
  const title = options.title || "Matter coverage and recovery";
  const route = options.route || "/operator/matter-coverage/";
  const receipt = view?.receipt || view || {};
  const retryHref = options.retryHref || "#receipt";
  const alerts = Array.isArray(receipt.alerts) ? receipt.alerts : [];
  const playbook = receipt.playbook || RECOVERY_PLAYBOOK;
  const alertItems = alerts.map((alert) => `
    <article class="alert" data-alert="${escapeHtml(alert.id)}">
      <h3>${escapeHtml(alert.id)}</h3>
      <p>Owner ${escapeHtml(alert.owner)}. ${escapeHtml(alert.action)}</p>
    </article>`).join("");
  const playbookItems = Object.entries(playbook).map(([id, row]) => `
    <article class="playbook" data-recovery="${escapeHtml(id)}">
      <h3>${escapeHtml(id.replaceAll("_", " "))}</h3>
      <p>Owner ${escapeHtml(row.owner)}.</p>
      <p>${escapeHtml(row.action)}</p>
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
  .summary, .alert, .playbook { background: #fff; border: 1px solid #d7d0c4; border-radius: 10px; padding: 16px; margin: 0 0 16px; }
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
<a class="skip" href="#receipt">Skip to coverage receipt</a>
<main id="receipt" data-route="${escapeHtml(route)}" data-failure-class="${escapeHtml(receipt.failure_class || ALERT_CLASS.NONE)}" data-active-watches="${escapeHtml(receipt.active_watches || 0)}" data-due-matters="${escapeHtml(receipt.due_matters || 0)}" data-deferred="${escapeHtml(receipt.deferred_work || 0)}" data-pending-outbox="${escapeHtml(receipt.pending_outbox_items || 0)}" data-failed-outbox="${escapeHtml(receipt.failed_outbox_items || 0)}" data-publication-lag="${escapeHtml(receipt.publication_lag_ms || 0)}" data-refresh-age="${escapeHtml(receipt.last_complete_refresh_age_ms || 0)}">
  <h1>${escapeHtml(title)}</h1>
  <section class="summary">
    <p class="kicker">${escapeHtml(receipt.failure_class || ALERT_CLASS.NONE)}</p>
    <p>${escapeHtml(failureCopy(receipt.failure_class))}</p>
    <p>These counts describe retained CityScroll state. They are not live publisher coverage and they do not include resident email addresses.</p>
    <div class="counts">
      <div><strong data-count="active-watches">${escapeHtml(receipt.active_watches || 0)}</strong><p>Active watches</p></div>
      <div><strong data-count="due-matters">${escapeHtml(receipt.due_matters || 0)}</strong><p>Due matters</p></div>
      <div><strong data-count="refresh-age">${escapeHtml(hours(receipt.last_complete_refresh_age_ms))}</strong><p>Last complete refresh age</p></div>
      <div><strong data-count="deferred">${escapeHtml(receipt.deferred_work || 0)}</strong><p>Deferred work</p></div>
      <div><strong data-count="retained-matters">${escapeHtml(receipt.retained_counts?.matters || 0)}</strong><p>Retained matters</p></div>
      <div><strong data-count="retained-appearances">${escapeHtml(receipt.retained_counts?.appearances || 0)}</strong><p>Retained appearances</p></div>
      <div><strong data-count="publication-lag">${escapeHtml(hours(receipt.publication_lag_ms))}</strong><p>Publication lag</p></div>
      <div><strong data-count="pending-outbox">${escapeHtml(receipt.pending_outbox_items || 0)}</strong><p>Pending outbox items</p></div>
      <div><strong data-count="failed-outbox">${escapeHtml(receipt.failed_outbox_items || 0)}</strong><p>Failed outbox items</p></div>
    </div>
    <p><a class="node-action" href="${escapeHtml(retryHref)}">Retry recovery</a></p>
  </section>
  <section>
    <h2>Open alerts</h2>
    ${alertItems || "<p>No coverage alert is open.</p>"}
  </section>
  <section>
    <h2>Recovery playbook</h2>
    ${playbookItems}
  </section>
  <details>
    <summary>Source, publication, and delivery details</summary>
    <p>This page reads retained D1 and publication receipts. It does not contact a publisher and it does not print resident email addresses.</p>
    <p>Token recovery, budget backlog, cursor recovery, failed publication, replay-safe delivery, and feature rollback each name a site-owner action above.</p>
    <p>A successful demo does not close this workstream. Cards stay proposed until their own merged delivery and a strict-clean realization receipt exist.</p>
  </details>
  <p><a class="node-action" href="#receipt">Return to receipt summary</a></p>
</main>
</body>
</html>`;
}
