export const E_DESIGNATION_DIGEST_URL = "data/e_designation_project_digest.json";
let lookup = {};
export function rememberEDesignationDigests(payload) { lookup = payload?.digests || {}; return lookup; }
export function attachEDesignationDigests(target, payload) { if (payload) rememberEDesignationDigests(payload); for (const row of target?.projects || target || []) if (lookup[row.project_id]) row.e_designation_digest = lookup[row.project_id]; return target; }
export function loadEDesignations() { return fetch(E_DESIGNATION_DIGEST_URL, { cache: "force-cache", credentials: "omit" }).then((r) => r.ok ? r.json() : null).then(rememberEDesignationDigests).catch(() => rememberEDesignationDigests(null)); }
export function eDesignationDigestHTML(digest, { escape = (v) => String(v ?? "") } = {}) {
  if (!digest?.conditions?.length) return "";
  const esc = escape;
  const byLot = new Map();
  for (const row of digest.conditions) { if (!byLot.has(row.bbl)) byLot.set(row.bbl, []); byLot.get(row.bbl).push(row); }
  const lots = [...byLot].map(([lot, rows]) => `<li data-e-designation-lot="${esc(lot)}"><a href="#property?bbl=${esc(lot)}">BBL ${esc(lot)}</a>: ${rows.map((r) => `<span data-e-designation-condition="${esc(r.condition_category)}">${esc(r.condition_value)}</span>`).join(", ")} · <a href="${esc(rows[0].source_url)}" target="_blank" rel="noopener noreferrer">${esc(rows[0].designation_number)} source record</a></li>`).join("");
  const partial = digest.coverage === "partial" ? `<p class="note" data-e-designation-partial="1">${esc(`${digest.matched_lot_count} of ${digest.eligible_lot_count} exact project lots have a matching retained record. Unmatched lots are not assigned a condition.`)}</p>` : "";
  return `<section class="land-e-designations" data-e-designation-digest="1"><h3>Environmental requirements on affected project lots</h3><p class="note">These source records identify requirements attached to exact lots; they do not establish that this project caused a designation.</p><ul>${lots}</ul>${partial}<p class="note">Source vintage ${esc(digest.conditions[0].source_vintage)} · Join basis ${esc(digest.conditions[0].join_method.replaceAll("_", " "))}</p></section>`;
}
