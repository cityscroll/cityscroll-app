import { officialSourceLink } from "./affordance_grammar.mjs";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const SCORECARD_SCHEMA = "cityscroll.community_board_minutes_scorecard.v1";
export const DETECTOR_SCHEMA = "cityscroll.community_board_minutes_gap_detector.v1";
export const SOURCE_INVENTORY_SCHEMA = "cityscroll.community_board_source_inventory.v1";

const SOURCE_ROLES = ["upcoming_meetings", "minutes"];

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

function sourceOrigin(source = {}) {
  if (source.provenance_kind === "third_party_storage" || /airtable|vimeo|youtube/i.test(source.url || "")) {
    return { key: "third_party_storage", label: "Board-linked third-party storage" };
  }
  if (/nyc\.gov|cityofnewyork\.us/i.test(source.url || "")) {
    return { key: "official_nyc", label: "NYC-hosted official source" };
  }
  return { key: "board_owned", label: "Board-owned official source" };
}

function sourceState(source, role, registryRow, joinedBodyIds) {
  if (!source?.url) return "absent_in_pass";
  if (joinedBodyIds.has(registryRow.body_id) && role === "minutes") return "joined";
  if (role === "minutes" && registryRow.status === "collect") return "not_yet_ingested";
  return "observed";
}

function safeSourceUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function fallbackInventorySource(registryRow, role) {
  if (role === "minutes" && registryRow.source_url) {
    return {
      url: registryRow.source_url,
      format: registryRow.format,
      fetch_mode: "explicit registry URL",
      status: "verified",
    };
  }
  return { status: "absent_in_pass" };
}

/**
 * Join the explicit board inventory to the registry's authoritative identities.
 * The inventory may add a source URL, but never derives one from a board name.
 */
export function buildBoardSourceInventory({ registry, inventory = null, joinedLookup = null } = {}) {
  const rows = Array.isArray(inventory?.boards) ? inventory.boards : [];
  if (inventory && inventory.schema !== SOURCE_INVENTORY_SCHEMA) return [];
  const byId = new Map(rows.map((row) => [row.id || row.body_id, row]));
  const joinedBodyIds = new Set(Object.values(joinedLookup?.notices || {})
    .map((row) => row.body_id)
    .filter(Boolean));
  return (registry?.sources || [])
    .filter((row) => row.body_type === "community_board")
    .map((registryRow) => {
      const inventoryRow = byId.get(registryRow.body_id) || {};
      const sources = Object.fromEntries(SOURCE_ROLES.map((role) => {
        const raw = inventoryRow[role]
          || inventoryRow[role === "upcoming_meetings" ? "upcoming" : "minutes"]
          || fallbackInventorySource(registryRow, role);
        const url = safeSourceUrl(raw.url);
        if (registryRow.source_url && role === "minutes" && url && url !== registryRow.source_url) {
          throw new Error(`minutes source mismatch for ${registryRow.body_id}`);
        }
        const state = sourceState({ ...raw, url }, role, registryRow, joinedBodyIds);
        const origin = url ? sourceOrigin({ ...raw, url }) : null;
        return [role, {
          source_type: role,
          source_url: url,
          source_format: raw.format || null,
          fetch_mode: raw.fetch_mode || null,
          access_constraint: raw.access_constraint || null,
          collection_state: state,
          origin: origin?.key || null,
          origin_label: origin?.label || "Source not listed",
          observed_on: inventoryRow.observed || inventory?.observed_on || registryRow.observed_on || null,
        }];
      }));
      return {
        body_id: registryRow.body_id,
        name: registryRow.name,
        borough: registryRow.borough,
        district: registryRow.district,
        homepage_url: registryRow.homepage_url || inventoryRow.home || null,
        directory_url: registryRow.directory_url || null,
        observed_on: inventoryRow.observed || inventory?.observed_on || registryRow.observed_on || null,
        sources,
      };
    });
}

function stateLabel(state) {
  return {
    observed: "Source observed",
    not_yet_ingested: "Source available",
    joined: "Joined to a published notice",
    absent_in_pass: "Source not listed",
  }[state] || "Source status not measured";
}

function formatObservedOn(value) {
  const date = asDate(value);
  return date ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}` : "Date not recorded";
}

function sourceRoleLabel(role) {
  return role === "upcoming_meetings" ? "Upcoming meetings" : "Minutes and records";
}

function sourceCard(source, role) {
  const link = source.source_url
    ? officialSourceLink({ href: source.source_url, label: role === "upcoming_meetings" ? "Open official calendar" : "Open minutes or records", className: "meeting-source-link", escape: esc })
    : `<span class="scorecard-muted">Source not listed</span>`;
  const access = source.access_constraint === "browser_required"
    ? `<span class="scorecard-source-note">Browser access may be required.</span>`
    : "";
  return `<div class="scorecard-source" data-source-type="${esc(role)}" data-collection-state="${esc(source.collection_state)}"><strong>${esc(sourceRoleLabel(role))}</strong>${link}<span class="scorecard-source-state">${esc(stateLabel(source.collection_state))}</span><span class="scorecard-source-meta">Observed ${esc(formatObservedOn(source.observed_on))} · ${esc(source.origin_label)}</span>${access}</div>`;
}

export function buildScorecard({ registry, detector = null, observedOn = null, sourceInventory = null, joinedLookup = null } = {}) {
  const asOf = detector?.as_of || observedOn || sourceInventory?.observed_on || registry?.observed_on;
  const detectorRows = new Map((detector?.rows || []).map((row) => [row.body_id, row]));
  const boards = (registry?.sources || []).filter((row) => row.body_type === "community_board");
  const inventoryRows = new Map(buildBoardSourceInventory({ registry, inventory: sourceInventory, joinedLookup })
    .map((row) => [row.body_id, row]));
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
      sources: inventoryRows.get(source.body_id)?.sources || {},
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
      inventory: "site/data/non_council_outcome_sources/board_source_inventory.json",
      rule: "Only explicit registry or inventory URLs and detector receipts may supply a source or dated observation; no URL is inferred.",
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
    const sources = row.sources && Object.keys(row.sources).length
      ? SOURCE_ROLES.map((role) => sourceCard(row.sources[role], role)).join("")
      : sourceCard({ source_url: row.minutes_url, collection_state: row.minutes_url ? "not_yet_ingested" : "absent_in_pass", observed_on: row.receipts?.[0]?.observed_on, origin_label: row.minutes_url ? "NYC-hosted official source" : "Source not listed" }, "minutes");
    const completeness = [
      row.notice_completeness == null ? "Notice: not measured" : `Notice: ${row.notice_completeness}% observed`,
      row.media_completeness == null ? "Media: not measured" : `Media: ${row.media_completeness}% observed`,
    ].join(" · ");
    return `<tr><th scope="row"><a href="${esc(row.homepage_url)}">${esc(row.name)}</a><span>${esc(row.borough)} · District ${row.district}</span></th><td>${esc(freshness)}${row.rank ? `<small>Rank ${row.rank} of ${measured}</small>` : ""}</td><td><div class="scorecard-sources">${sources}</div><span class="scorecard-muted">${esc(completeness)}</span></td></tr>`;
  }).join("");
  const legalText = "The City Comptroller ";
  const legalLink = `<a href="${esc(scorecard.legal_basis.citation_url)}">has recommended</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Community board minutes · CityScroll</title><meta name="description" content="A public, receipt-backed view of community board minutes freshness."><link rel="canonical" href="https://cityscroll.org/community-boards/"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css"><link rel="stylesheet" href="/community-board-scorecard.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="document-mast"><div class="document-mast-inner"><a class="document-brand brand-lockup home" href="/"><span aria-hidden="true">▣</span><span>CityScroll</span></a><nav class="document-nav" aria-label="Primary"><a href="/now/">Now</a><a href="/near-you/">Near you</a><a href="/following/">Following</a><a href="/browse/">Browse</a></nav></div></header><main id="main" class="scorecard"><section class="scorecard-hero"><h1>Community board sources</h1><p class="scorecard-dek">See each of New York City’s 59 community boards with its explicit calendar, homepage, and minutes sources.</p><p class="scorecard-asof">Sources checked through ${esc(scorecard.as_of)} · ${scorecard.coverage.boards} boards listed</p></section><p class="scorecard-legal">${legalText}${legalLink} that community boards post minutes from the past 12 months.</p><section aria-labelledby="scorecard-table-heading"><div class="scorecard-heading"><div><p class="scorecard-kicker">All boards</p><h2 id="scorecard-table-heading">Official source inventory</h2></div><a class="scorecard-json" href="/data/community_board_minutes_scorecard.json">Machine-readable JSON</a></div><div class="scorecard-table-wrap"><table><thead><tr><th scope="col">Board</th><th scope="col">Minutes freshness</th><th scope="col">Official sources</th></tr></thead><tbody>${rows}</tbody></table></div></section></main></body></html>`;
}

export { esc };
