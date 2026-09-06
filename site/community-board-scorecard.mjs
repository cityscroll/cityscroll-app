import { officialSourceLink } from "./affordance_grammar.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";
import { communityDistrictIdForBoard } from "./community_board_geography.mjs";
import {
  bboxToViewBox,
  defaultViewBox,
  mapLabelText,
  polygonLabelPoint,
  polygonsToSvgPath,
} from "./map_exploration.mjs";
import {
  MONEY_COMPARISON_METRICS,
  METRIC_KEYS,
  moneyComparisonMapProjection,
} from "./community_board_money_comparison.mjs";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const SCORECARD_SCHEMA = "cityscroll.community_board_minutes_scorecard.v1";
export const DETECTOR_SCHEMA = "cityscroll.community_board_minutes_gap_detector.v1";
export const SOURCE_INVENTORY_SCHEMA = "cityscroll.community_board_source_inventory.v1";

const SOURCE_ROLES = ["upcoming_meetings", "minutes", "committees", "roster", "bylaws"];
const COVERAGE_ROLES = ["upcoming_meetings", "minutes"];

const SOURCE_ROLE_LABELS = Object.freeze({
  upcoming_meetings: "Upcoming meetings",
  minutes: "Minutes and records",
  committees: "Committee directory",
  roster: "Board roster",
  bylaws: "Bylaws",
});

export const SOURCE_COVERAGE = Object.freeze({
  both: Object.freeze({
    label: "Both sources identified",
    description: "Meeting/calendar and minutes or records sources are listed.",
  }),
  one: Object.freeze({
    label: "One source identified",
    description: "Only a meeting/calendar or minutes/records source is listed.",
  }),
  neither: Object.freeze({
    label: "Neither source identified",
    description: "Neither source is listed, or the source has not yet been checked.",
  }),
  unknown: Object.freeze({
    label: "Source check failed or unknown",
    description: "A source check could not establish the current source status.",
  }),
});

const SOURCE_CHECK_FAILURE_STATES = new Set([
  "unavailable", "stale", "unknown", "failed", "error",
]);

function sourceCheckFailed(source = {}) {
  return SOURCE_CHECK_FAILURE_STATES.has(String(source.collection_state || "").toLowerCase())
    || ["unknown", "unavailable", "failed", "error"].includes(String(source.verification?.status || "").toLowerCase());
}

/** Classify map color by source coverage while leaving role-level details intact. */
export function sourceCoverage(row = {}) {
  const sources = row.sources || {};
  if (COVERAGE_ROLES.some((role) => sourceCheckFailed(sources[role]))) return "unknown";
  const identified = COVERAGE_ROLES.filter((role) => Boolean(sources[role]?.source_url));
  if (identified.length === COVERAGE_ROLES.length) return "both";
  if (identified.length === 1) return "one";
  return "neither";
}

/** Build all 59 board-linked boundaries using the shared district geometry. */
export function buildCommunityBoardMap(scorecard = {}, boundaries = {}, { moneyComparisons = null } = {}) {
  const regular = (boundaries.community_districts || [])
    .filter((feature) => /^\D\d{2}$/.test(String(feature?.id || "")))
    .filter((feature) => Number(String(feature.id).slice(1)) <= 18);
  const rowsByDistrict = new Map((scorecard.rows || [])
    .map((row) => [communityDistrictIdForBoard(row), row])
    .filter(([districtId]) => districtId));
  const comparisons = moneyComparisons?.comparisons || {};
  const moneyProjections = Object.fromEntries(Object.entries(comparisons).map(([key, comparison]) => [
    key,
    Object.fromEntries(METRIC_KEYS.map((metric) => [metric, moneyComparisonMapProjection(comparison, metric)])),
  ]));
  const features = regular.map((feature) => {
    const row = rowsByDistrict.get(feature.id) || null;
    const boardId = row?.body_id || null;
    const money = Object.fromEntries(Object.entries(comparisons).map(([key, comparison]) => {
      const comparisonRow = (comparison.rows || []).find((candidate) => candidate.board_id === boardId) || null;
      return [key, {
        values: comparisonRow?.values || {},
        states: comparisonRow?.states || {},
        levels: Object.fromEntries(METRIC_KEYS.map((metric) => [metric, moneyProjections[key]?.[metric]?.[boardId]?.level ?? null])),
      }];
    }));
    return {
      id: feature.id,
      row,
      boardId,
      label: row?.name || feature.label || feature.id,
      coverage: sourceCoverage(row || {}),
      money,
      path: polygonsToSvgPath(feature.polygons),
      labelPoint: polygonLabelPoint(feature.polygons),
      bbox: feature.bbox,
    };
  });
  const bbox = features.reduce((bounds, feature) => {
    if (!Array.isArray(feature.bbox) || feature.bbox.length !== 4) return bounds;
    return [
      Math.min(bounds[0], feature.bbox[0]),
      Math.min(bounds[1], feature.bbox[1]),
      Math.max(bounds[2], feature.bbox[2]),
      Math.max(bounds[3], feature.bbox[3]),
    ];
  }, [Infinity, Infinity, -Infinity, -Infinity]);
  return {
    vintage: boundaries.boundary_vintage || null,
    viewBox: bbox.every(Number.isFinite) ? bboxToViewBox(bbox, 0.04) : null,
    features,
  };
}

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
  if (source.publisher_kind === "city_record" || /cityrecord\.nyc\.gov|a856-cityrecord\.nyc.gov/i.test(source.url || "")) {
    return { key: "city_record", label: "City Record notice source" };
  }
  if (source.publisher_kind === "third_party_storage" || /airtable|vimeo|youtube/i.test(source.url || "")) {
    return { key: "third_party_storage", label: "Board-linked third-party storage" };
  }
  if (source.publisher_kind === "nyc_official" || /nyc\.gov/i.test(source.url || "")) {
    return { key: "official_nyc", label: "NYC-hosted official source" };
  }
  if (source.publisher_kind === "board_owned_official" || /cityofnewyork\.us/i.test(source.url || "")) {
    return { key: "board_owned", label: "Board-owned official source" };
  }
  return { key: null, label: "Source not listed" };
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
  if (registryRow.source_roles?.[role]) return registryRow.source_roles[role];
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
export function buildBoardSourceInventory({ registry, inventory = null, joinedLookup = null, meetingIndex = null } = {}) {
  const rows = Array.isArray(inventory?.boards) ? inventory.boards : [];
  if (inventory && inventory.schema !== SOURCE_INVENTORY_SCHEMA) return [];
  const byId = new Map(rows.map((row) => [row.id || row.body_id, row]));
  const joinedBodyIds = new Set(Object.values(joinedLookup?.notices || {})
    .map((row) => row.body_id)
    .filter(Boolean));
  const meetingReceipts = new Map((meetingIndex?.receipts || [])
    .map((row) => [`${row.board_id}:${row.role}`, row]));
  return (registry?.sources || [])
    .filter((row) => row.body_type === "community_board")
    .map((registryRow) => {
      const inventoryRow = byId.get(registryRow.body_id) || {};
      const sources = Object.fromEntries(SOURCE_ROLES.map((role) => {
        const inventorySource = inventoryRow[role]
          || inventoryRow[role === "upcoming_meetings" ? "upcoming" : "minutes"]
          || fallbackInventorySource(registryRow, role);
        const authoritative = fallbackInventorySource(registryRow, role);
        const inventoryUrl = safeSourceUrl(inventorySource.url);
        const url = safeSourceUrl(authoritative.url);
        if (inventoryUrl && inventoryUrl !== url) {
          throw new Error(`${role} source mismatch for ${registryRow.body_id}`);
        }
        if (registryRow.source_url && role === "minutes" && url && url !== registryRow.source_url) {
          throw new Error(`minutes source mismatch for ${registryRow.body_id}`);
        }
        const state = sourceState({ ...authoritative, url }, role, registryRow, joinedBodyIds);
        const coverage = meetingReceipts.get(`${registryRow.body_id}:${role}`);
        const origin = url ? sourceOrigin({ ...authoritative, url }) : null;
        return [role, {
          source_type: role,
          source_url: url,
          publisher: authoritative.publisher || null,
          publisher_kind: authoritative.publisher_kind || origin?.key || null,
          source_format: authoritative.format || null,
          fetch_mode: authoritative.fetch_mode || null,
          access_constraint: authoritative.access_constraint || null,
          archive_depth: authoritative.archive_depth || { status: "unknown", earliest_year: null, latest_year: null },
          stable_key: authoritative.stable_key || null,
          verification: authoritative.verification || null,
          collection_state: coverage?.state || state,
          governance_state: state,
          coverage_receipt: coverage || null,
          origin: origin?.key || null,
          origin_label: origin?.label || "Source not listed",
          observed_on: authoritative.seen_on || inventorySource.seen_on || inventoryRow.observed || inventory?.observed_on || registryRow.observed_on || null,
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
    indexed: "Meetings found",
    "checked-empty": "No published records found",
    "unsupported-format": "Not ingested — source format not supported",
    unavailable: "Not ingested — source could not be checked",
    stale: "Source check is out of date",
    "not-yet-checked": "Not ingested",
  }[state] || "Source status not measured";
}

function formatObservedOn(value) {
  const date = asDate(value);
  return date ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}` : "";
}

function sourceRoleLabel(role) {
  return SOURCE_ROLE_LABELS[role] || role;
}

function sourceCard(source = {}, role) {
  const link = source.source_url
    ? officialSourceLink({ href: source.source_url, label: role === "upcoming_meetings" ? "Open official calendar" : `Open ${sourceRoleLabel(role).toLowerCase()}`, className: "meeting-source-link", escape: esc })
    : `<span class="scorecard-muted">Source not listed</span>`;
  const access = source.access_constraint === "browser_required"
    ? `<span class="scorecard-source-note">Browser access may be required.</span>`
    : "";
  const observed = formatObservedOn(source.observed_on);
  const meta = [observed ? `Observed ${observed}` : "", source.origin_label || ""].filter(Boolean).join(" · ");
  return `<div class="scorecard-source" data-source-type="${esc(role)}" data-collection-state="${esc(source.collection_state)}"><strong>${esc(sourceRoleLabel(role))}</strong>${link}<span class="scorecard-source-state">${esc(stateLabel(source.collection_state))}</span>${meta ? `<span class="scorecard-source-meta">${esc(meta)}</span>` : ""}${access}</div>`;
}

export function buildScorecard({ registry, detector = null, observedOn = null, sourceInventory = null, joinedLookup = null, meetingIndex = null, moneyComparison = null } = {}) {
  const asOf = detector?.as_of || observedOn || sourceInventory?.observed_on || registry?.observed_on;
  const detectorRows = new Map((detector?.rows || []).map((row) => [row.body_id, row]));
  const boards = (registry?.sources || []).filter((row) => row.body_type === "community_board");
  const inventoryRows = new Map(buildBoardSourceInventory({ registry, inventory: sourceInventory, joinedLookup, meetingIndex })
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
    money_comparison: moneyComparison?.comparisons?.[moneyComparison.default_key || "latest"] || null,
    money_comparisons: moneyComparison?.comparisons || null,
    rows,
  };
}

function fallbackSource(row, role) {
  return {
    source_url: role === "minutes" ? row.minutes_url : null,
    collection_state: role === "minutes" && row.minutes_url ? "not_yet_ingested" : "not-yet-checked",
    observed_on: row.receipts?.[0]?.observed_on || null,
    origin_label: role === "minutes" && row.minutes_url ? "NYC-hosted official source" : "Source not listed",
  };
}

function boardSource(row, role) {
  return row.sources?.[role] || fallbackSource(row, role);
}

function renderBoardDetail(row, selected, scorecard) {
  const freshness = formatLastMinutes(row.last_minutes_date, row.days_since_last_minutes);
  const completeness = [
    row.notice_completeness == null ? "Notice: not measured" : `Notice: ${row.notice_completeness}% observed`,
    row.media_completeness == null ? "Media: not measured" : `Media: ${row.media_completeness}% observed`,
  ].join(" · ");
  const boardHref = communityBoardPageHref(row.body_id);
  const homepage = row.homepage_url
    ? `<a class="scorecard-homepage-link" href="${esc(row.homepage_url)}" target="_blank" rel="noopener noreferrer">Official homepage<span aria-hidden="true">↗</span></a>`
    : `<span class="scorecard-muted">Official homepage: not listed</span>`;
  return `<article class="scorecard-detail-card" data-board-detail="${esc(row.body_id)}"${selected ? "" : " hidden"} aria-labelledby="scorecard-detail-${esc(row.body_id)}">
    <p class="scorecard-kicker">Selected board</p>
    <h3 id="scorecard-detail-${esc(row.body_id)}">${esc(row.name)}</h3>
    <p class="scorecard-board-meta">${esc(row.borough)} · Community District ${esc(row.district)}</p>
    <p class="scorecard-detail-links">${boardHref ? `<a href="${esc(boardHref)}">Open board profile</a>` : ""}${homepage}</p>
    <dl class="scorecard-metadata">
      <div><dt>Minutes freshness</dt><dd>${esc(freshness)}${row.rank ? ` · Rank ${row.rank} of ${scorecard.coverage.measured}` : ""}</dd></div>
      <div><dt>Scorecard as of</dt><dd>${esc(scorecard.as_of || "Not measured")}</dd></div>
      <div><dt>Observed completeness</dt><dd>${esc(completeness)}</dd></div>
    </dl>
    <div class="scorecard-detail-sources">
      ${SOURCE_ROLES.map((role) => sourceCard(boardSource(row, role), role)).join("")}
    </div>
  </article>`;
}

function renderCoverageLegend(map) {
  const counts = Object.fromEntries(Object.keys(SOURCE_COVERAGE).map((key) => [key, 0]));
  for (const feature of map.features) counts[feature.coverage] += 1;
  return `<div class="scorecard-coverage-legend" aria-labelledby="scorecard-legend-heading">
    <h3 id="scorecard-legend-heading">Source coverage</h3>
    <p>Map colors show whether each board has explicit meeting/calendar and minutes/records sources. Details keep the underlying observed status.</p>
    <ul>${Object.entries(SOURCE_COVERAGE).map(([key, value]) => `<li><span class="scorecard-legend-swatch scorecard-coverage-${key}" aria-hidden="true"></span><span><strong>${esc(value.label)}</strong><small>${esc(value.description)} ${counts[key]} board${counts[key] === 1 ? "" : "s"}.</small></span></li>`).join("")}</ul>
  </div>`;
}

function moneyCurrency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function moneyCount(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function moneyDate(value) {
  const raw = String(value || "");
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  return raw;
}

function moneyVintage(value) {
  if (!value) return "not provided";
  if (typeof value === "string") return value;
  if (value.payment_issue_date_through) return `posted through ${moneyDate(value.payment_issue_date_through)}`;
  return Object.entries(value).map(([key, item]) => `${key}: ${item}`).join("; ");
}

function moneyYearLabel(years, fallback = "year unavailable") {
  const values = (years || []).filter((year) => Number.isInteger(year));
  return values.length ? values.map((year) => `FY${year}`).join(" / ") : fallback;
}

function moneyMetricHeader(metric, comparison) {
  const definition = MONEY_COMPARISON_METRICS[metric];
  const years = comparison?.source_years?.[definition.source] || [];
  return `${definition.label} · ${moneyYearLabel(years)}`;
}

function moneyMetricCell(row, metric) {
  const definition = MONEY_COMPARISON_METRICS[metric];
  const fact = row?.[definition.source] || {};
  const value = row?.values?.[metric];
  const formatted = value == null ? "Unavailable" : definition.format === "currency" ? moneyCurrency(value) : moneyCount(value);
  const state = fact.state_label || "Unavailable";
  return `<td data-money-cell="${esc(metric)}" data-sort-value="${value == null ? "" : esc(value)}" data-sort-missing="${value == null ? "true" : "false"}"><span>${esc(formatted)}</span>${value == null ? `<small>${esc(state)}</small>` : ""}</td>`;
}

function moneyComparisonBoundaryCopy(comparison) {
  const budgetYears = moneyYearLabel(comparison?.source_years?.budget);
  const spendingYears = moneyYearLabel(comparison?.source_years?.spending);
  if (comparison?.year_alignment === "separate_source_years") {
    return `Adopted budget ${budgetYears}; payments ${spendingYears}. These source years are labeled separately and are not combined.`;
  }
  return `Both source facts are labeled ${budgetYears}. No combined ratio is calculated.`;
}

function renderMoneyComparisonTable(comparison) {
  const rows = (comparison?.rows || []).map((row) => `<tr data-money-row="${esc(row.board_id)}">
    <th scope="row"><a href="${esc(row.dossier_href)}">${esc(row.name || row.board_id)}</a><span>${esc(row.borough)} · District ${esc(row.district)}</span><small>${esc(row.source_year_label)}</small></th>
    ${METRIC_KEYS.map((metric) => moneyMetricCell(row, metric)).join("")}
  </tr>`).join("");
  return `<div class="scorecard-table-wrap scorecard-money-table-wrap"><table class="scorecard-money-table" data-money-table><thead><tr><th scope="col">Board</th>${METRIC_KEYS.map((metric) => `<th scope="col" data-sort-heading="${esc(metric)}" aria-sort="none"><button type="button" data-money-sort="${esc(metric)}" aria-label="Sort by ${esc(MONEY_COMPARISON_METRICS[metric].label)}">${esc(moneyMetricHeader(metric, comparison))}<span aria-hidden="true">↕</span></button></th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderMoneyComparisonPanel(key, comparison, selected) {
  const sourceLinks = [
    ["budget", "NYC Expense Budget"],
    ["spending", "Checkbook NYC"],
  ].map(([source, label]) => {
    const boundary = comparison?.boundaries?.[source] || {};
    const link = boundary.source_url ? `<a href="${esc(boundary.source_url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
    const vintages = boundary.source_vintages?.length ? boundary.source_vintages.map(moneyVintage).join(" / ") : moneyVintage(boundary.source_vintage);
    return `<li>${link} · ${esc(vintages)} · observed ${esc(boundary.observed_at || "not provided")}</li>`;
  }).join("");
  return `<div class="scorecard-money-panel" data-money-comparison-panel="${esc(key)}"${selected ? "" : " hidden"}>
    <p class="scorecard-money-boundary">${esc(moneyComparisonBoundaryCopy(comparison))}</p>
    <details class="scorecard-money-provenance"><summary>Source dates and coverage</summary><ul>${sourceLinks}</ul><p>${comparison.coverage.rows_with_budget} boards have an adopted-budget fact; ${comparison.coverage.rows_with_payments} have an accepted posted-payment fact. Missing or unestablished facts remain unavailable.</p></details>
    ${renderMoneyComparisonTable(comparison)}
  </div>`;
}

function renderMoneyComparisonSection(scorecard) {
  const comparisons = scorecard.money_comparisons || (scorecard.money_comparison ? { latest: scorecard.money_comparison } : null);
  if (!comparisons || !Object.keys(comparisons).length) return "";
  const defaultKey = scorecard.money_comparison ? Object.entries(comparisons).find(([, value]) => value === scorecard.money_comparison)?.[0] || "latest" : "latest";
  const keys = Object.keys(comparisons);
  const optionLabel = (key, comparison) => key === "latest"
    ? `Latest retained facts (${moneyYearLabel(comparison.source_years?.budget)} budget · ${moneyYearLabel(comparison.source_years?.spending)} payments)`
    : `FY${comparison.fiscal_year}`;
  return `<section id="scorecard-money-comparison" class="scorecard-money-comparison" aria-labelledby="scorecard-money-heading" data-money-comparison-root>
    <div class="scorecard-heading"><div><p class="scorecard-kicker">Financial comparison</p><h2 id="scorecard-money-heading">59-board money comparison</h2></div><a class="scorecard-json" href="/data/community_board_money_comparison.json">Machine-readable JSON</a></div>
    <p class="scorecard-money-dek">Compare adopted budgets with posted payments, payment counts, and payee counts from the same Community Board money read model.</p>
    <label class="scorecard-money-select">Fiscal-year view<select data-money-fiscal-select>${keys.map((key) => `<option value="${esc(key)}"${key === defaultKey ? " selected" : ""}>${esc(optionLabel(key, comparisons[key]))}</option>`).join("")}</select></label>
    ${keys.map((key) => renderMoneyComparisonPanel(key, comparisons[key], key === defaultKey)).join("")}
  </section>`;
}

function renderMoneyMapControls(scorecard) {
  const comparisons = scorecard.money_comparisons || (scorecard.money_comparison ? { latest: scorecard.money_comparison } : null);
  if (!comparisons || !Object.keys(comparisons).length) return "";
  const defaultKey = scorecard.money_comparison ? Object.entries(comparisons).find(([, value]) => value === scorecard.money_comparison)?.[0] || "latest" : "latest";
  const keys = Object.keys(comparisons);
  return `<div class="scorecard-map-controls" data-money-map-controls><div class="scorecard-map-control-group" role="group" aria-label="Map layer"><span class="scorecard-map-control-label">Map layer</span><button type="button" data-scorecard-map-layer="sources" aria-pressed="true">Source coverage</button><button type="button" data-scorecard-map-layer="money" aria-pressed="false">Money</button></div><div class="scorecard-map-control-group scorecard-map-money-controls" data-money-map-only hidden><label>Fiscal-year view<select data-money-map-fiscal-select>${keys.map((key) => `<option value="${esc(key)}"${key === defaultKey ? " selected" : ""}>${esc(key === "latest" ? "Latest retained facts" : `FY${comparisons[key].fiscal_year}`)}</option>`).join("")}</select></label><span class="scorecard-map-control-label">Metric</span>${METRIC_KEYS.map((metric, index) => `<button type="button" data-money-map-metric="${esc(metric)}" aria-pressed="${index === 0 ? "true" : "false"}">${esc(MONEY_COMPARISON_METRICS[metric].shortLabel)}</button>`).join("")}<span data-money-map-label>Adopted budget</span></div></div>`;
}

export function renderScorecardPage(scorecard, { boundaries = {} } = {}) {
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
    const boardHref = communityBoardPageHref(row.body_id);
    const boardName = boardHref ? `<a href="${esc(boardHref)}">${esc(row.name)}</a>` : esc(row.name);
    return `<tr id="board-${esc(row.body_id)}"><th scope="row">${boardName}<span>${esc(row.borough)} · District ${row.district}</span><a class="scorecard-homepage-link" href="${esc(row.homepage_url)}" target="_blank" rel="noopener noreferrer">Official homepage<span aria-hidden="true">↗</span></a></th><td>${esc(freshness)}${row.rank ? `<small>Rank ${row.rank} of ${measured}</small>` : ""}</td><td><div class="scorecard-sources">${sources}</div><span class="scorecard-muted">${esc(completeness)}</span></td></tr>`;
  }).join("");
  const moneyComparisons = scorecard.money_comparisons
    ? { default_key: Object.entries(scorecard.money_comparisons).find(([, value]) => value === scorecard.money_comparison)?.[0] || "latest", comparisons: scorecard.money_comparisons }
    : scorecard.money_comparison ? { default_key: "latest", comparisons: { latest: scorecard.money_comparison } } : null;
  const map = buildCommunityBoardMap(scorecard, boundaries, { moneyComparisons });
  const defaultBoardId = scorecard.rows[0]?.body_id || "";
  const mapPaths = map.features.filter((feature) => feature.boardId).map((feature) => {
    const row = feature.row;
    const coverage = SOURCE_COVERAGE[feature.coverage];
    const selected = feature.boardId === defaultBoardId;
    return `<path class="community-board-boundary scorecard-coverage-${esc(feature.coverage)}${selected ? " is-selected" : ""}" data-board-id="${esc(feature.boardId)}" data-community-district="${esc(feature.id)}" data-coverage="${esc(feature.coverage)}" data-money-projection="${esc(JSON.stringify(feature.money || {}))}" d="${esc(feature.path)}" tabindex="0" role="button" aria-pressed="${selected ? "true" : "false"}" aria-label="${esc(row.name)}; ${esc(row.borough)}, District ${esc(row.district)}; ${esc(coverage.label)}"></path>`;
  }).join("");
  const mapLabels = map.features.filter((feature) => feature.boardId && feature.labelPoint).map((feature) => `<text class="community-board-map-label" data-board-label="${esc(feature.boardId)}" x="${esc(feature.labelPoint.x)}" y="${esc(feature.labelPoint.y)}" text-anchor="middle" dominant-baseline="central" aria-hidden="true">${esc(mapLabelText("community_district", feature.id, feature.label))}</text>`).join("");
  const details = scorecard.rows.map((row) => renderBoardDetail(row, row.body_id === defaultBoardId, scorecard)).join("");
  const legalText = "The City Comptroller ";
  const legalLink = `<a href="${esc(scorecard.legal_basis.citation_url)}">has recommended</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Community board sources and money · CityScroll</title><meta name="description" content="A public, receipt-backed view of community board sources, minutes freshness, and money facts."><link rel="canonical" href="https://cityscroll.org/community-boards/"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css"><link rel="stylesheet" href="/community-board-scorecard.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="document-mast"><div class="document-mast-inner"><a class="document-brand brand-lockup home" href="/" aria-label="CityScroll home"><span aria-hidden="true">▣</span><span>CityScroll</span></a><nav class="document-nav" aria-label="Primary"><a href="/now/">Now</a><a href="/near-you/">Near you</a><a href="/following/">Following</a><a href="/browse/">Browse</a><a href="/guide/">Guide</a></nav></div></header><main id="main" class="scorecard" data-community-board-root data-selected-board="${esc(defaultBoardId)}"><section class="scorecard-hero"><h1>Community board sources</h1><p class="scorecard-dek">See each of New York City’s 59 community boards with its explicit calendar, homepage, minutes sources, and financial facts.</p><p class="scorecard-asof">Sources checked through ${esc(scorecard.as_of)} · ${scorecard.coverage.boards} boards listed</p></section><p class="scorecard-legal">${legalText}${legalLink} that community boards post minutes from the past 12 months.</p><nav class="scorecard-view-switch" aria-label="Community board view"><a class="is-active" href="#scorecard-map" data-scorecard-view="map" aria-current="page">Map</a><a href="#scorecard-table" data-scorecard-view="table">Table</a></nav><section class="scorecard-map-view" id="scorecard-map" data-view-panel="map" aria-labelledby="scorecard-map-heading"><div class="scorecard-heading"><div><p class="scorecard-kicker">All boards</p><h2 id="scorecard-map-heading">Community districts by source coverage</h2></div><span class="scorecard-map-count">${map.features.length} boundaries</span></div>${renderMoneyMapControls(scorecard)}<div class="scorecard-map-grid"><div class="scorecard-map-wrap"><svg class="community-board-map" role="group" aria-labelledby="scorecard-map-title scorecard-map-desc" viewBox="${esc(map.viewBox || defaultViewBox())}" preserveAspectRatio="xMidYMid meet"><title id="scorecard-map-title">New York City community district boundaries</title><desc id="scorecard-map-desc">All ${map.features.length} community district boundaries are selectable. Use Tab to focus a district, then Enter or Space to select it.</desc><g fill-rule="evenodd">${mapPaths}</g><g>${mapLabels}</g></svg><p class="scorecard-map-boundary-note">Boundaries: ${esc(map.vintage || "not published")}. Select a district to see its source details.</p></div><aside class="scorecard-detail-panel" aria-label="Selected community board details">${details}</aside></div>${renderCoverageLegend(map)}</section><section id="scorecard-table" data-view-panel="table" aria-labelledby="scorecard-table-heading">${renderMoneyComparisonSection(scorecard)}<div class="scorecard-heading"><div><p class="scorecard-kicker">All boards</p><h2 id="scorecard-table-heading">Official source inventory</h2></div><a class="scorecard-json" href="/data/community_board_minutes_scorecard.json">Machine-readable JSON</a></div><div class="scorecard-table-wrap"><table><thead><tr><th scope="col">Board</th><th scope="col">Minutes freshness</th><th scope="col">Official sources</th></tr></thead><tbody>${rows}</tbody></table></div></section></main><script type="module" src="/app/community-board-scorecard.mjs"></script></body></html>`;
}

export { esc };
