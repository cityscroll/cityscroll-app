import { officialSourceLink } from "./affordance_grammar.mjs";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const SCORECARD_SCHEMA = "cityscroll.community_board_minutes_scorecard.v1";
export const DETECTOR_SCHEMA = "cityscroll.community_board_minutes_gap_detector.v1";

function asDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function daysBetween(asOf, date) {
  const left = asDate(asOf);
  const right = asDate(date);
  if (!left || !right || right > left) return null;
  return Math.floor((left - right) / 86400000);
}

export function formatLastMinutes(date, days) {
  if (!date) return "Last published minutes: not measured yet";
  const parsed = asDate(date);
  const label = parsed ? `${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}` : date;
  if (days === 0) return `Last published minutes: ${label} — today`;
  if (days === 1) return `Last published minutes: ${label} — 1 day ago`;
  if (days != null && days < 60) return `Last published minutes: ${label} — ${days} days ago`;
  if (days != null) return `Last published minutes: ${label} — ${Math.round(days / 30.4375)} months ago`;
  return `Last published minutes: ${label}`;
}

function stableRank(rows) {
  return [...rows]
    .filter((row) => Number.isInteger(row.days_since_last_minutes))
    .sort((a, b) => a.days_since_last_minutes - b.days_since_last_minutes || a.body_id.localeCompare(b.body_id))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export function buildScorecard({ registry, detector = null, observedOn = null } = {}) {
  const asOf = detector?.as_of || observedOn || registry?.observed_on;
  const detectorRows = new Map((detector?.rows || []).map((row) => [row.body_id, row]));
  const boards = (registry?.sources || []).filter((row) => row.body_type === "community_board");
  const baseRows = boards.map((source) => {
    const detected = detectorRows.get(source.body_id) || {};
    const lastDate = detected.last_minutes_date || null;
    const days = Number.isInteger(detected.days_since_last_minutes)
      ? detected.days_since_last_minutes
      : daysBetween(asOf, lastDate);
    const minutesUrl = detected.minutes_url || source.source_url || null;
    const receipts = [
      { kind: "registry", path: "site/data/non_council_outcome_sources/source_registry.json", observed_on: source.observed_on },
      ...(detected.receipts || []),
    ];
    return {
      body_id: source.body_id,
      name: source.name,
      borough: source.borough,
      district: source.district,
      homepage_url: source.homepage_url,
      directory_url: source.directory_url,
      minutes_url: minutesUrl,
      last_minutes_date: lastDate,
      days_since_last_minutes: days,
      notice_completeness: detected.notice_completeness ?? null,
      media_completeness: detected.media_completeness ?? null,
      freshness_status: days == null ? "not_measured" : "measured",
      receipts,
    };
  });
  const ranked = stableRank(baseRows);
  const ranks = new Map(ranked.map((row) => [row.body_id, row.rank]));
  const rows = baseRows
    .map((row) => ({ ...row, rank: ranks.get(row.body_id) ?? null }))
    .sort((a, b) => a.borough.localeCompare(b.borough) || a.district - b.district);
  return {
    schema: SCORECARD_SCHEMA,
    version: 1,
    as_of: asOf,
    source_contract: {
      detector_schema: DETECTOR_SCHEMA,
      detector_artifact: "site/data/community_board_minutes_gap.json",
      registry: "site/data/non_council_outcome_sources/source_registry.json",
      rule: "Only explicit minutes URLs and detector receipts may supply a dated observation; no URL is inferred.",
    },
    legal_basis: {
      label: "Public records expectation",
      text: "The City Comptroller has recommended that community boards post minutes from the past 12 months.",
      citation_url: "https://comptroller.nyc.gov/reports/audit-report-on-the-twelve-manhattan-community-boards-compliance-with-new-york-city-charter-and-new-york-city-administrative-code-requirements-for-public-meetings-and-hearings-and-for-web/",
    },
    coverage: { boards: rows.length, measured: rows.filter((row) => row.freshness_status === "measured").length },
    rankings: {
      leaders: ranked.slice(0, 5).map(({ body_id, rank }) => ({ body_id, rank })),
      laggards: ranked.slice(-5).reverse().map(({ body_id, rank }) => ({ body_id, rank })),
    },
    rows,
  };
}

export function renderScorecardPage(scorecard) {
  const measured = scorecard.coverage.measured;
  const rows = scorecard.rows.map((row) => {
    const freshness = formatLastMinutes(row.last_minutes_date, row.days_since_last_minutes);
    const minutes = row.minutes_url
      ? officialSourceLink({ href: row.minutes_url, label: "Minutes page", className: "meeting-source-link", escape: esc })
      : `<span class="scorecard-muted">Minutes page not verified</span>`;
    const completeness = [
      row.notice_completeness == null ? "Notice: not measured" : `Notice: ${row.notice_completeness}% observed`,
      row.media_completeness == null ? "Media: not measured" : `Media: ${row.media_completeness}% observed`,
    ].join(" · ");
    return `<tr><th scope="row"><a href="${esc(row.homepage_url)}">${esc(row.name)}</a><span>${esc(row.borough)} · District ${row.district}</span></th><td>${esc(freshness)}${row.rank ? `<small>Rank ${row.rank} of ${measured}</small>` : ""}</td><td>${minutes}<br><span class="scorecard-muted">${esc(completeness)}</span></td></tr>`;
  }).join("");
  const rankingNote = measured
    ? `The ranking uses ${measured} dated observation${measured === 1 ? "" : "s"}; ties break by board ID so a rebuild produces the same order.`
    : "No dated checks are available yet, so no board is ranked yet.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Community board minutes · CityScroll</title><meta name="description" content="A public, receipt-backed view of community board minutes freshness."><link rel="canonical" href="https://cityscroll.org/community-boards/"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css"><link rel="stylesheet" href="/community-board-scorecard.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="document-mast"><div class="document-mast-inner"><a class="document-brand brand-lockup home" href="/"><span aria-hidden="true">▣</span><span>CityScroll</span></a><nav class="document-nav" aria-label="Primary"><a href="/now/">Now</a><a href="/near-you/">Near you</a><a href="/following/">Following</a><a href="/browse/">Browse</a></nav></div></header><main id="main" class="scorecard"><section class="scorecard-hero"><p class="scorecard-kicker">Public accountability</p><h1>Community board minutes</h1><p class="scorecard-dek">See which of New York City’s 59 community boards has a dated minutes publication on record, and visit each board’s page to check the source.</p><p class="scorecard-asof">Checked through ${esc(scorecard.as_of)} · ${scorecard.coverage.boards} boards listed · ${measured} with dated freshness receipts</p></section><section class="scorecard-legal" aria-labelledby="scorecard-legal-heading"><h2 id="scorecard-legal-heading">What the public record expects</h2><p>${esc(scorecard.legal_basis.text)} <a href="${esc(scorecard.legal_basis.citation_url)}">Read the Comptroller audit</a>.</p></section><section class="scorecard-method" aria-labelledby="scorecard-method-heading"><h2 id="scorecard-method-heading">How to read this page</h2><p>“Not measured yet” means the board is listed in the city’s official directory, but this build has no dated minutes probe receipt for it. It does not mean minutes do not exist. ${esc(rankingNote)}</p></section><section aria-labelledby="scorecard-table-heading"><div class="scorecard-heading"><div><p class="scorecard-kicker">All boards</p><h2 id="scorecard-table-heading">Minutes freshness by board</h2></div><a class="scorecard-json" href="/data/community_board_minutes_scorecard.json">Machine-readable JSON</a></div><div class="scorecard-table-wrap"><table><thead><tr><th scope="col">Board</th><th scope="col">Freshness</th><th scope="col">Check the source</th></tr></thead><tbody>${rows}</tbody></table></div></section></main></body></html>`;
}

export { esc };
