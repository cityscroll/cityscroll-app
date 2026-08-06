/** Exact-key City Council committee membership read model. */

const clean = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const COMMITTEE_MEMBERSHIP_SOURCE = "aabe-yfm9";

export function committeeMembershipsForId(lookup, personId) {
  const id = clean(personId).replace(/^official:/, "");
  const bag = lookup?.by_member_id?.[id];
  return bag && Array.isArray(bag.rows) ? bag.rows : [];
}

export function renderCommitteeMembershipsHTML(bag, { escapeHtml, translate } = {}) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
  const t = typeof translate === "function" ? translate : (key) => key;
  const rows = Array.isArray(bag?.rows) ? bag.rows : [];
  if (!rows.length) return `<aside class="official-committee-memberships" data-membership-status="gap" role="note"><div class="chain-h">${t("official_coverage_heading")}</div><p>${t("official_no_recent_html", { name: "this official" })}</p></aside>`;
  const coverage = bag.coverage || {};
  const rate = coverage.row_rate == null ? "—" : `${(Number(coverage.row_rate) * 100).toFixed(1)}%`;
  return `<section class="official-committee-memberships" data-membership-status="linked">
    <div class="chain-h">${t("official_coverage_heading")} · Committee memberships</div>
    <p class="aidprov">${t("official_coverage_basis", { retained: String(coverage.linked_rows ?? rows.length), eligible: String(coverage.eligible_rows ?? "—"), matters: rate })}</p>
    <ul>${rows.map((row) => `<li><strong>${esc(row.committee)}</strong><br><span>${esc(row.appointment_type || "Membership")}${row.start_date ? ` · ${esc(row.start_date)}${row.end_date ? `–${esc(row.end_date)}` : ""}` : ""}</span></li>`).join("")}</ul>
    <p class="aidprov">${t("official_provenance_html")} Source: ${esc(COMMITTEE_MEMBERSHIP_SOURCE)}; vintage ${esc(bag.vintage || "—")}.</p>
  </section>`;
}
