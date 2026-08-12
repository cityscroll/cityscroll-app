/**
 * Follow-the-Dollars check-level payment rows (route-only island).
 * Dynamic-import from loadLifecycle so home.cold wireBytes stay neutral.
 * Labels are module-local English (same register as other Checkbook chrome).
 */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

/**
 * @param {object|null|undefined} payDetail
 * @param {{ money?: Function, fdate?: Function, clean?: Function }} [deps]
 */
export function lifecyclePaymentRowsHTML(payDetail, deps = {}) {
  if (!payDetail || !Array.isArray(payDetail.payment_rows) || !payDetail.payment_rows.length) {
    return "";
  }
  const money = typeof deps.money === "function" ? deps.money : (n) => String(n ?? "—");
  const fdate = typeof deps.fdate === "function" ? deps.fdate : (d) => (d ? String(d) : "—");
  const clean = typeof deps.clean === "function" ? deps.clean : (s) => String(s ?? "");
  const rows = payDetail.payment_rows
    .map((row) => {
      if (!row || typeof row !== "object") return "";
      const when = row.date ? fdate(row.date) : "—";
      const amount = row.amount != null ? money(row.amount) : "—";
      const payee = row.payee ? esc(clean(row.payee)) : "—";
      const doc = row.document_id
        ? ` <code class="lc-pay-doc">${esc(String(row.document_id))}</code>`
        : "";
      return `<tr><td>${esc(when)}</td><td><b>${amount}</b></td><td>${payee}${doc}</td></tr>`;
    })
    .filter(Boolean)
    .join("");
  if (!rows) return "";
  const more = payDetail.payment_rows_capped
    ? `<div class="note" style="margin-top:6px">Showing ${
      Number(payDetail.payment_rows_shown || payDetail.payment_rows.length)
    } of ${
      Number(payDetail.total_payments || payDetail.payment_rows.length)
    } payments on this contract.</div>`
    : "";
  return `<div class="lc-payment-rows" data-payment-rows="1" style="margin-top:12px">
    <h4 class="lc-payment-rows-h">Recent payments</h4>
    <table class="lc-payment-table">
      <thead><tr>
        <th scope="col">Date</th>
        <th scope="col">Amount</th>
        <th scope="col">Payee</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${more}
  </div>`;
}

/** Install SPA bridge used by lifecycleDollarsHTML after dynamic import. */
export function installPaymentRowsBridge() {
  if (typeof globalThis === "undefined") return;
  globalThis.__lcPaymentRowsHTML = (detail) => lifecyclePaymentRowsHTML(detail, {
    money: globalThis.lifecycleMoney || globalThis.money,
    fdate: globalThis.fdate,
    clean: globalThis.cleanText,
  });
  globalThis.lifecyclePaymentRowsHTML = globalThis.__lcPaymentRowsHTML;
}

installPaymentRowsBridge();
