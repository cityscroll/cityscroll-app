// Public Data health page: materialize-first projection of GET /source-health.
// Renders only the committed public artifact. Does not evaluate clocks, query
// internals, or invent healthy/zero values for missing observations.

import {
  PUBLIC_SOURCE_HEALTH_SCHEMA,
  validatePublicSourceHealthProjection,
} from "./source_health_public_projection.mjs";
import {
  detectNodePageCruft,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
} from "./civic_document_chrome.mjs";

export const DATA_HEALTH_PATH = "/data-health/";
export const DATA_HEALTH_TITLE = "Data health";

const CLOCKS = Object.freeze([
  {
    id: "publisher_updated",
    label: "Publisher updated",
    basisLabels: { publisher_record: "from the publisher's record" },
  },
  {
    id: "cityscroll_checked_acquired",
    label: "CityScroll last checked",
    basisLabels: {
      cityscroll_check: "from CityScroll's last check",
      cityscroll_acquisition: "from CityScroll's last successful copy",
      cityscroll_observation: "from CityScroll's last check",
    },
  },
  {
    id: "cityscroll_serving",
    label: "CityScroll serving copy",
    basisLabels: {
      cityscroll_materialization: "from the copy CityScroll is serving",
      cityscroll_observation: "from the copy CityScroll is serving",
    },
  },
]);

const PRODUCT_AREAS = Object.freeze([
  { id: "notices", label: "Notices" },
  { id: "contracts", label: "Contracts" },
  { id: "zoning", label: "Zoning" },
  { id: "property", label: "Property" },
  { id: "rules", label: "Rules" },
  { id: "meetings", label: "Hearings and meetings" },
  { id: "people", label: "People and officials" },
  { id: "staffing", label: "Staffing and exams" },
  { id: "agencies", label: "Agencies" },
  { id: "places", label: "Places" },
  { id: "other", label: "Other public records" },
]);

const PRODUCT_AREA_BY_SOURCE = Object.freeze({
  "city-record": "notices",
  "abo-local-authorities": "contracts",
  "abo-local-development-corporations": "contracts",
  "abo-state-authorities": "contracts",
  "bid-tabulations-historical": "contracts",
  "capital-projects": "contracts",
  "capital-projects-dashboard": "contracts",
  "checkbook-contracts": "contracts",
  "checkbook-nycha-contracts": "contracts",
  "checkbook-spending": "contracts",
  "doing-business-entities": "contracts",
  "mocs-ll1-plans": "contracts",
  "mocs-ll63-plans": "contracts",
  "nycida-build-nyc-projects": "contracts",
  "ocp-current-solicitations": "contracts",
  "ocp-recent-contract-awards": "contracts",
  "passport-public-contracts": "contracts",
  "passport-public-rfx": "contracts",
  "city-council-district-boundaries": "zoning",
  "community-district-boundaries": "zoning",
  "mandatory-inclusionary-housing": "zoning",
  "mappluto": "zoning",
  "ulurp-recommendation-pdfs": "zoning",
  "ulurp-recommendations": "zoning",
  "zap-api-outcomes": "zoning",
  "zap-bbl": "zoning",
  "zap-projects": "zoning",
  "dcas-vehicle-auction-list": "property",
  "dob-certificate-of-occupancy": "property",
  "dob-now-job-filings": "property",
  "dof-tax-lien-sale-lists": "property",
  "legacy-dob-job-filings": "property",
  "nyc-property-address-directory": "property",
  "suitability-city-owned-leased-property-ll48": "property",
  "nyc-rules-rss": "rules",
  "city-council-meetings-open-data": "meetings",
  "non-council-board-minutes": "meetings",
  "nyc-council-legistar": "meetings",
  "cfb-campaign-contributions": "people",
  "city-clerk-elobbyist": "people",
  "city-council-committee-membership": "people",
  "nyc-council-members": "people",
  "active-civil-service-list": "staffing",
  "annual-examination-schedule": "staffing",
  "citywide-payroll": "staffing",
  "civil-service-list-certification": "staffing",
  "civil-service-titles": "staffing",
  "dcas-annual-exam-outcomes": "staffing",
  "dcas-eligible-list-utilization": "staffing",
  "dcas-exam-notices": "staffing",
  "nyc-jobs-postings": "staffing",
  "expense-budget": "agencies",
  "nyc-agencies": "agencies",
  "nyc-geosearch": "places",
});

const HEALTH_LABELS = Object.freeze({
  Healthy: "Healthy",
  Delayed: "Delayed",
  Degraded: "Degraded",
  "Source-unavailable": "Not currently served",
  "Limited-coverage": "Limited coverage",
  Historical: "Historical",
  "Manual-refresh": "Manual refresh",
  UNKNOWN: "UNKNOWN",
});

const COVERAGE_LABELS = Object.freeze({
  complete_for_declared_scope: "Complete for this source's declared scope",
  limited_coverage: "Limited coverage",
  held_or_failed_join: "Held or failed relationship match",
  UNKNOWN: "UNKNOWN",
});

const HEALTH_REASON_COPY = Object.freeze({
  "acquisition-clock-stale": "The latest CityScroll check is older than this source's expected cadence.",
  "acquisition-failed": "The latest automated check did not succeed.",
  "acquisition-held": "The latest check is on hold.",
  "acquisition-partial": "The latest check only partly succeeded.",
  "publisher-clock-stale": "The publisher's last update is older than this source's expected cadence.",
  "serving-clock-stale": "The copy CityScroll is serving is older than this source's expected cadence.",
  "serving-fallback-unavailable": "No previously verified copy remains available.",
  "serving-unavailable": "CityScroll is not serving this source right now.",
  "serving-valid-fallback": "A previously verified copy is still being served.",
  "source-disabled": "This source is not currently in use.",
  "manual-refresh-due": "A manual refresh is due.",
  "manual-refresh-condition-unknown": "Whether a manual refresh is due is UNKNOWN.",
  "historical-source": "This source no longer receives new updates for its declared period.",
});

const COVERAGE_REASON_COPY = Object.freeze({
  "relationship-join-failed": "The published relationship did not complete.",
  "relationship-join-held": "The published relationship is held.",
});

const DEBUG_LEAK = /join_coverage|snapshot_sha|contract_fingerprint|row_count|auth_token|runbook|raw_error|max_stale|denominator|numerator|reason_codes|source_id|cityscroll_checked_acquired|publisher_updated|cityscroll_serving|generated_at|all operational|all systems operational/i;

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function publicCadence(value) {
  const text = clean(value).replace(/\s*\([^)]*_[^)]*\)/g, "").trim();
  return text.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, "").replace(/\s{2,}/g, " ").trim();
}

export function productAreaForSource(sourceId) {
  return PRODUCT_AREA_BY_SOURCE[clean(sourceId)] || "other";
}

export function mappedProductAreaIds() {
  return { ...PRODUCT_AREA_BY_SOURCE };
}

function publicInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const date = new Date(epoch);
  return date.getUTCFullYear() > 1970 ? date : null;
}

function formatPublicDate(value) {
  const date = publicInstant(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function healthLabel(status) {
  return HEALTH_LABELS[status] || "UNKNOWN";
}

function coverageLabel(status) {
  return COVERAGE_LABELS[status] || "UNKNOWN";
}

function uniqueSentences(codes, dictionary) {
  return [...new Set((Array.isArray(codes) ? codes : [])
    .map((code) => dictionary[code])
    .filter(Boolean))];
}

function compositeHealthLabel(row) {
  const status = HEALTH_LABELS[row?.health?.status] ? row.health.status : "UNKNOWN";
  const mode = row?.mode;
  if (status === "Historical") return "Historical";
  if (status === "Manual-refresh" || (mode === "manual-conditional" && status === "Healthy")) {
    return status === "Delayed" ? "Manual refresh · overdue" : "Manual refresh · on schedule";
  }
  if (mode === "manual-conditional" && status === "Delayed") return "Manual refresh · overdue";
  return healthLabel(status);
}

function healthNote(row) {
  const status = HEALTH_LABELS[row?.health?.status] ? row.health.status : "UNKNOWN";
  const reasons = uniqueSentences(row?.health?.reason_codes, HEALTH_REASON_COPY);
  if (status === "Historical") {
    return reasons.find((line) => line.includes("no longer receives"))
      || HEALTH_REASON_COPY["historical-source"];
  }
  if (status === "Degraded") {
    const failure = reasons.filter((line) => line !== HEALTH_REASON_COPY["serving-valid-fallback"]);
    const fallback = reasons.includes(HEALTH_REASON_COPY["serving-valid-fallback"])
      ? HEALTH_REASON_COPY["serving-valid-fallback"]
      : "";
    const parts = [...failure];
    if (fallback) parts.push(fallback);
    if (!parts.length) {
      return "This source is degraded. A previously verified copy is still being served.";
    }
    return parts.join(" ");
  }
  if (status === "UNKNOWN") return "";
  return reasons.join(" ");
}

function clockView(clockName, clock, meta) {
  const known = clock?.state === "KNOWN" && publicInstant(clock.at);
  return {
    id: clockName,
    label: meta.label,
    state: known ? "KNOWN" : "UNKNOWN",
    display: known ? formatPublicDate(clock.at) : "UNKNOWN",
    basis_label: known ? (meta.basisLabels[clock?.basis] || "") : "",
  };
}

function sourceCard(row) {
  const healthStatus = HEALTH_LABELS[row?.health?.status] ? row.health.status : "UNKNOWN";
  return {
    source_id: clean(row?.source_id),
    name: clean(row?.name) || "Unnamed source",
    publisher: clean(row?.publisher),
    official_url: clean(row?.official_url) || null,
    expected_cadence: publicCadence(row?.expected_cadence),
    mode: clean(row?.mode) || "UNKNOWN",
    area_id: productAreaForSource(row?.source_id),
    health_status: healthStatus,
    health_label: compositeHealthLabel(row),
    health_note: healthNote(row),
    clocks: CLOCKS.map((meta) => clockView(meta.id, row?.health?.clocks?.[meta.id], meta)),
    coverage_status: COVERAGE_LABELS[row?.relationship_coverage?.status]
      ? row.relationship_coverage.status
      : "UNKNOWN",
    coverage_label: coverageLabel(row?.relationship_coverage?.status),
    coverage_note: uniqueSentences(row?.relationship_coverage?.reason_codes, COVERAGE_REASON_COPY).join(" "),
    coverage_measured: formatPublicDate(row?.relationship_coverage?.measured_at),
  };
}

export function buildDataHealthView(projection) {
  const unavailable = !projection
    || projection.available !== true
    || projection.schema !== PUBLIC_SOURCE_HEALTH_SCHEMA
    || !Array.isArray(projection.sources)
    || (projection.available === true && validatePublicSourceHealthProjection(projection).length);
  if (unavailable) {
    return {
      available: false,
      generated_at: formatPublicDate(projection?.generated_at),
      groups: [],
      source_count: null,
    };
  }
  const cards = projection.sources.map(sourceCard);
  const grouped = new Map(PRODUCT_AREAS.map((area) => [area.id, []]));
  for (const card of cards) {
    const areaId = grouped.has(card.area_id) ? card.area_id : "other";
    grouped.get(areaId).push(card);
  }
  return {
    available: true,
    generated_at: formatPublicDate(projection.generated_at),
    source_count: cards.length,
    groups: PRODUCT_AREAS
      .map((area) => ({ ...area, sources: grouped.get(area.id) || [] }))
      .filter((area) => area.sources.length),
  };
}

function renderClock(clock) {
  const basis = clock.basis_label
    ? `<span class="data-health-clock-basis">${esc(clock.basis_label)}</span>`
    : "";
  return `<div class="data-health-clock" data-clock-state="${esc(clock.state)}">
    <dt>${esc(clock.label)}</dt>
    <dd><span class="data-health-clock-value">${esc(clock.display)}</span>${basis}</dd>
  </div>`;
}

function renderSourceCard(card) {
  const official = card.official_url
    ? `<a class="data-health-official" href="${esc(card.official_url)}" target="_blank" rel="noopener noreferrer">Official page ↗</a>`
    : "";
  const cadence = card.expected_cadence
    ? `<p class="data-health-meta">${esc([card.publisher, card.expected_cadence].filter(Boolean).join(" · "))}</p>`
    : card.publisher
      ? `<p class="data-health-meta">${esc(card.publisher)}</p>`
      : "";
  const note = card.health_note ? `<p class="data-health-note">${esc(card.health_note)}</p>` : "";
  const coverageNote = card.coverage_note
    ? `<p class="data-health-note">${esc(card.coverage_note)}</p>`
    : "";
  const coverageWhen = card.coverage_measured
    ? `<p class="data-health-coverage-when">Measured ${esc(card.coverage_measured)}</p>`
    : "";
  return `<article class="data-health-card" data-health-status="${esc(card.health_status)}" data-mode="${esc(card.mode)}">
    <header class="data-health-card-head">
      <h3>${esc(card.name)}</h3>
      ${cadence}
      ${official}
    </header>
    <section class="data-health-condition" aria-label="Freshness">
      <p class="data-health-status">${esc(card.health_label)}</p>
      ${note}
      <dl class="data-health-clocks">${card.clocks.map(renderClock).join("")}</dl>
    </section>
    <section class="data-health-coverage" aria-label="Coverage">
      <h4>Coverage</h4>
      <p class="data-health-coverage-status">${esc(card.coverage_label)}</p>
      ${coverageNote}
      ${coverageWhen}
    </section>
  </article>`;
}

function renderGroup(group) {
  return `<section class="data-health-group" aria-labelledby="data-health-${esc(group.id)}">
    <h2 id="data-health-${esc(group.id)}">${esc(group.label)}</h2>
    <div class="data-health-cards">${group.sources.map(renderSourceCard).join("")}</div>
  </section>`;
}

export function renderDataHealthBody(view) {
  if (!view?.available) {
    return `<main id="main" class="data-health-page" data-data-health="unavailable" tabindex="-1">
      <header class="data-health-hero">
        <h1>${DATA_HEALTH_TITLE}</h1>
        <p class="data-health-lede">Source freshness is unavailable right now.</p>
        <p class="data-health-crosslink">For how many records CityScroll holds, see <a href="/stats.html">Stats</a>.</p>
      </header>
    </main>`;
  }
  const asOf = view.generated_at
    ? `<p class="data-health-asof">Source list as of ${esc(view.generated_at)}.</p>`
    : "";
  return `<main id="main" class="data-health-page" data-data-health="ready" tabindex="-1">
    <header class="data-health-hero">
      <h1>${DATA_HEALTH_TITLE}</h1>
      <p class="data-health-lede">Where CityScroll's public records come from, when each source last changed, and where coverage is limited.</p>
      <p class="data-health-crosslink">For how many records CityScroll holds, see <a href="/stats.html">Stats</a>.</p>
      ${asOf}
    </header>
    ${view.groups.map(renderGroup).join("")}
  </main>`;
}

export function renderDataHealthDocument(view, options = {}) {
  const assetPrefix = options.assetPrefix || "/";
  const siteBase = String(options.siteBase || "").replace(/\/$/, "");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${DATA_HEALTH_TITLE} · CityScroll</title>
<meta name="description" content="Freshness, coverage, and the three labeled clocks for CityScroll's public data sources.">
<link rel="canonical" href="https://cityscroll.org${DATA_HEALTH_PATH}">
<link rel="icon" href="${esc(assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`)}assets/brand/favicon.svg" type="image/svg+xml">
${renderCivicDocumentAssets(assetPrefix)}</head>
<body class="data-health-body"><a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ siteBase, surfaceClass: "data-health-mast" })}
${renderDataHealthBody(view)}
<footer class="data-health-footer">Check each source at its official page. <a href="/stats.html">Stats</a> · <a href="/about.html">About</a>.</footer>
<script defer src="${esc((assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`))}analytics.js?v=1.3.0"></script>
</body></html>`.replace(/[ \t]+$/gm, "");
  const cruft = detectNodePageCruft(html);
  if (cruft.length) throw new Error(`Data health page contains reader-facing cruft: ${cruft.join(", ")}`);
  if (DEBUG_LEAK.test(html)) throw new Error("Data health page leaked debug internals or roll-up copy");
  return html;
}

export function renderDataHealthPage(projection, options = {}) {
  return renderDataHealthDocument(buildDataHealthView(projection), options);
}
