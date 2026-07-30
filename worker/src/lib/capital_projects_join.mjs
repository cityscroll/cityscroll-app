// Capital Projects (n7gv-k5yt) recon join — agency + project_name fuzzy only.
//
// Measured 2026-07-30 (see site/data/capital_project_sources/ and
// site/data/source_contracts.json join_measurement for capital-projects):
//
//   Dataset has NO PIN/EPIN column. Columns: pid, project_name, managing_agency,
//   client_agency, budget_forecast, current_phase, …
//   Modern Procurement sample (100 recent notices, start_date >= 2025-01-01):
//     unique project_name substring in short_title: 0%
//     unique token Jaccard >= 0.35 with margin: 1%
//
// Verdict: below usefulness threshold (~30%) → no edge materialization.
// Product: class-(b) pointer for procurement-planning-budget naming Capital Projects.

/** Lowercase alnum tokens of length >= 4 for fuzzy name overlap. */
export function nameTokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []);
}

/**
 * Build a latest-per-pid index from Capital Projects time-series rows.
 * @param {Array<{pid?: string, project_name?: string, managing_agency?: string, date_reported_as_of?: string}>} rows
 */
export function buildCapitalProjectIndex(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    const pid = String(row?.pid || "").trim();
    if (!pid) continue;
    const prev = latest.get(pid);
    const d = String(row?.date_reported_as_of || "");
    if (!prev || d > String(prev.date_reported_as_of || "")) {
      latest.set(pid, row);
    }
  }
  return { byPid: latest, projects: [...latest.values()] };
}

/**
 * Strict-ish unique name join: project_name (len>=12) is a unique substring of title.
 * @returns {{ method: string, pid: string, project_name: string } | null}
 */
export function joinTitleToCapitalProject(title, index) {
  const t = String(title || "").toLowerCase();
  if (!t || !index?.projects?.length) return null;
  const hits = [];
  for (const row of index.projects) {
    const name = String(row.project_name || "").trim();
    if (name.length < 12) continue;
    if (t.includes(name.toLowerCase())) {
      hits.push(row);
    }
  }
  if (hits.length !== 1) return null;
  return {
    method: "unique_project_name_substring",
    pid: String(hits[0].pid),
    project_name: String(hits[0].project_name || ""),
  };
}

/**
 * Fuzzy unique token Jaccard join. Margin required vs second-best.
 * @returns {{ method: string, pid: string, score: number } | null}
 */
export function joinTitleToCapitalProjectFuzzy(title, index, { minJaccard = 0.35, margin = 0.12 } = {}) {
  const nt = nameTokens(title);
  if (nt.size < 3 || !index?.projects?.length) return null;
  const scored = [];
  for (const row of index.projects) {
    const ct = nameTokens(row.project_name);
    if (ct.size < 2) continue;
    let inter = 0;
    for (const tok of nt) if (ct.has(tok)) inter += 1;
    const uni = nt.size + ct.size - inter;
    const j = uni ? inter / uni : 0;
    if (j >= minJaccard) scored.push({ j, row });
  }
  scored.sort((a, b) => b.j - a.j);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].j < scored[1].j + margin) return null;
  return {
    method: "unique_token_jaccard",
    pid: String(scored[0].row.pid),
    score: scored[0].j,
  };
}
