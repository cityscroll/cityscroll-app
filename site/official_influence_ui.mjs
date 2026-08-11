/**
 * Browser-safe official influence panels (no entity_resolution imports).
 *
 * Build/measure logic lives in official_influence.mjs (Node/host only).
 * The SPA imports this module so public Pages artifacts never resolve
 * outside the site/ document root.
 */

const clean = (value, max = 400) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Compact district/term line for official profiles. */
export function renderPersonHubFactsHTML(hubBag, { escapeHtml } = {}) {
  if (!hubBag?.person_id) return "";
  const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
  const parts = [];
  if (hubBag.district) parts.push(`District ${esc(hubBag.district)}`);
  const term = hubBag.current_term;
  if (term?.term_start) {
    const end = term.term_end ? `–${esc(term.term_end)}` : "";
    parts.push(`Term ${esc(term.term_start)}${end}`);
  }
  if (!parts.length) return "";
  return `<p class="official-hub-facts" data-person-hub="linked" lang="en" dir="ltr">${parts.join(" · ")}</p>`;
}

/** Lobby client list for one official — omit empty. */
export function renderLobbyInfluenceHTML(bag, { escapeHtml } = {}) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
  const edges = Array.isArray(bag?.edges) ? bag.edges : [];
  if (!edges.length) return "";
  const items = edges.slice(0, 12).map((e) => {
    const org = esc(e.from_org_display || e.from_org_key || "—");
    const lob = e.lobbyist_name ? ` · ${esc(e.lobbyist_name)}` : "";
    const yr = e.report_year ? ` · ${esc(e.report_year)}` : "";
    return `<li><strong>${org}</strong>${lob}${yr}</li>`;
  }).join("");
  const more = edges.length > 12
    ? `<p class="note">${edges.length - 12} more recorded filings</p>`
    : "";
  return `<section class="official-lobby-influence" data-lobby-status="linked" aria-label="Lobbying clients">
    <div class="chain-h" id="official-lobby-heading">Lobbying clients (City Clerk eLobbyist)</div>
    <ul aria-labelledby="official-lobby-heading">${items}</ul>
    ${more}
  </section>`;
}

/** Campaign finance donor summary — omit empty. */
export function renderCfbInfluenceHTML(bag, { escapeHtml } = {}) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (v) => String(v ?? "");
  const donors = Array.isArray(bag?.donors) ? bag.donors : [];
  if (!donors.length && !(bag?.contribution_count > 0)) return "";
  const total = bag.contribution_total != null
    ? `$${Number(bag.contribution_total).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : null;
  const lead = total
    ? `<p class="ei-lead">${esc(String(bag.contribution_count))} contributions · ${esc(total)} total in sample</p>`
    : "";
  const items = donors.slice(0, 10).map((d) => {
    const amt = d.amount_total != null
      ? `$${Number(d.amount_total).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : "—";
    return `<li><strong>${esc(d.donor_display)}</strong> · ${esc(amt)}</li>`;
  }).join("");
  return `<section class="official-cfb-influence" data-cfb-status="linked" aria-label="Campaign contributions">
    <div class="chain-h" id="official-cfb-heading">Campaign contributions (CFB sample)</div>
    ${lead}
    ${items ? `<ul aria-labelledby="official-cfb-heading">${items}</ul>` : ""}
  </section>`;
}

export function lobbyEdgesForId(lookup, personId) {
  const id = clean(personId).replace(/^official:/, "");
  const bag = lookup?.by_person_id?.[id];
  return bag && Array.isArray(bag.edges) ? bag.edges : [];
}

export function cfbForId(lookup, personId) {
  const id = clean(personId).replace(/^official:/, "");
  return lookup?.by_person_id?.[id] || null;
}
