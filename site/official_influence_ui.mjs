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

/**
 * In-page walk chrome: lobby / campaign finance / published roll-call votes.
 * Only links sections that actually render — never invents missing evidence.
 * Labels stay module-local (same register as lobby/CFB section titles) so the
 * home.cold i18n payload does not grow.
 *
 * @param {{ hasLobby?: boolean, hasCfb?: boolean, hasVotes?: boolean }} opts
 */
export function renderOfficialWalkHTML(opts = {}) {
  const parts = [];
  if (opts.hasLobby) parts.push(["#official-lobby", "Lobbying clients"]);
  if (opts.hasCfb) parts.push(["#official-cfb", "Campaign finance"]);
  // Votes live on the existing official panel root (no eager entities id stamp).
  if (opts.hasVotes) parts.push(["#official-skim", "Published roll-call votes"]);
  if (parts.length < 2) return "";
  const links = parts
    .map(([href, label], i) =>
      `${i ? '<span class="official-walk-sep" aria-hidden="true"> → </span>' : ""}`
      + `<a class="official-walk-link" href="${href}">${label}</a>`)
    .join("");
  return `<nav class="official-walk" data-official-walk="1" aria-label="On this page">`
    + `<div class="chain-h" id="official-walk-heading">On this page</div>`
    + `<p class="official-walk-line">${links}</p></nav>`;
}

/**
 * Walk strip + lobby + CFB panels (test/helper path; product path is
 * renderLobbyInfluenceHTML → renderCfbInfluenceHTML staging).
 */
export function renderOfficialInfluenceChrome({
  lobbyBag = null,
  cfbBag = null,
  hasVotes = false,
  escapeHtml,
  translate,
} = {}) {
  const hasLobby = Array.isArray(lobbyBag?.edges) && lobbyBag.edges.length > 0;
  const hasCfb = Array.isArray(cfbBag?.donors) && cfbBag.donors.length > 0
    || Number(cfbBag?.contribution_count) > 0;
  return (
    renderOfficialWalkHTML({ hasLobby, hasCfb, hasVotes })
    + lobbySectionHTML(lobbyBag, { escapeHtml, translate })
    + cfbSectionHTML(cfbBag, { escapeHtml })
  );
}

/** Lobby body only (no walk). */
function lobbySectionHTML(bag, { escapeHtml } = {}) {
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
  return `<section class="official-lobby-influence" id="official-lobby" data-lobby-status="linked" aria-label="Lobbying clients">
    <div class="chain-h" id="official-lobby-heading">Lobbying clients (City Clerk eLobbyist)</div>
    <ul aria-labelledby="official-lobby-heading">${items}</ul>
    ${more}
  </section>`;
}

/** CFB body only (no walk). */
function cfbSectionHTML(bag, { escapeHtml } = {}) {
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
  return `<section class="official-cfb-influence" id="official-cfb" data-cfb-status="linked" aria-label="Campaign contributions">
    <div class="chain-h" id="official-cfb-heading">Campaign contributions (CFB sample)</div>
    ${lead}
    ${items ? `<ul aria-labelledby="official-cfb-heading">${items}</ul>` : ""}
  </section>`;
}

// Eager entities.mjs calls lobby then CFB with fixed call sites (home.cold wire).
// Stage lobby so CFB can emit walk+lobby+cfb without growing the cold island.
let _lobbyStage = null;

/** Lobby client list — stages for CFB flush (returns empty; CFB emits both). */
export function renderLobbyInfluenceHTML(bag, opts = {}) {
  _lobbyStage = { bag, opts };
  return "";
}

/**
 * Campaign finance + flush staged lobby + optional walk strip.
 * Official pages always call lobby then CFB, so this is the single emit point.
 */
export function renderCfbInfluenceHTML(bag, opts = {}) {
  const staged = _lobbyStage;
  _lobbyStage = null;
  const lobbyBag = staged?.bag;
  const escapeHtml = opts.escapeHtml || staged?.opts?.escapeHtml;
  const translate = opts.translate || staged?.opts?.translate;
  const hasLobby = Array.isArray(lobbyBag?.edges) && lobbyBag.edges.length > 0;
  const hasCfb = Array.isArray(bag?.donors) && bag.donors.length > 0
    || Number(bag?.contribution_count) > 0;
  // Votes panel root id is already on the official card (#official-skim).
  const walk = renderOfficialWalkHTML({
    hasLobby,
    hasCfb,
    hasVotes: hasLobby || hasCfb,
  });
  return walk
    + lobbySectionHTML(lobbyBag, { escapeHtml, translate })
    + cfbSectionHTML(bag, { escapeHtml });
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
