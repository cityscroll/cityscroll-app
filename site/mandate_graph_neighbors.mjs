/**
 * Mandate co-located graph neighbors (mand-graph-01).
 *
 * Before dense per-mandate → notice/contract edges land, every mandate row still
 * sits next to real graph entities for the same agency (source law / Legistar
 * matter, Rules, Meetings, Contracts). This module surfaces those as clickable
 * connections from mandate chrome — exact matter_id + agency:id scopes only.
 * Never fabricates a mandate→entity filing edge.
 */

import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";
import { legistarMatterUrl } from "./agency_obligations.mjs";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const escDefault = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

/** Exact matter edge from a mandate obligation row (no invent). */
export function mandateMatterEdgeFromRow(row = {}) {
  const matterId = clean(
    row.matter_id || row.source?.matter_id || row.matterId,
    40,
  ) || null;
  const sourceHref = clean(
    row.source_href
      || row.source?.legistar_url
      || row.legistar_url
      || row.href,
    400,
  ) || (matterId ? legistarMatterUrl(matterId) : null) || null;
  if (!matterId && !sourceHref) return null;
  return {
    relation: "source_law",
    matter_id: matterId,
    href: sourceHref,
    label: "Source law",
  };
}

/**
 * Compact graph-neighbor destinations already scoped to the agency.
 * Callers supply browse hrefs built with agencyCategoryBrowseHref — this
 * module does not invent scopes.
 */
export function normalizeMandateGraphNeighbors(raw = {}) {
  const out = {
    rules_browse_href: clean(raw.rules_browse_href || raw.rules, 400) || null,
    meetings_browse_href: clean(raw.meetings_browse_href || raw.meetings, 400) || null,
    contracts_browse_href: clean(raw.contracts_browse_href || raw.contracts, 400) || null,
  };
  if (!out.rules_browse_href && !out.meetings_browse_href && !out.contracts_browse_href) {
    return null;
  }
  return out;
}

/**
 * Honest H2 for rulemaking bridge: do not claim linked Rules activity when
 * observed_links is zero. Co-located Rules filings may still appear as a
 * parallel list under their own subhead.
 */
export function mandateRulesSectionTitle(counts = {}) {
  const observed = Number(counts.observed_links) || 0;
  if (observed > 0) return "Rulemaking mandates · Rules activity";
  return "Rulemaking mandates";
}

/** Honest nav / pivot label for the rules mandate section. */
export function mandateRulesNavLabel(counts = {}) {
  return mandateRulesSectionTitle(counts);
}

/**
 * Honest H2 for report mandates: "Filing receipts" only when at least one
 * standable receipt exists.
 */
export function mandateReportsSectionTitle(counts = {}) {
  const receipts = Number(counts.filing_receipts) || 0;
  if (receipts > 0) return "Report mandates · Filing receipts";
  return "Report mandates";
}

/** Honest nav / pivot label for the reports mandate section. */
export function mandateReportsNavLabel(counts = {}) {
  return mandateReportsSectionTitle(counts);
}

/**
 * Status-line fragments for rules (omit zero linked filings).
 * @returns {string[]}
 */
export function mandateRulesStatusParts(counts = {}) {
  const parts = [];
  if (counts.rulemaking_mandates) {
    parts.push(
      `${counts.rulemaking_mandates} rulemaking mandate${counts.rulemaking_mandates === 1 ? "" : "s"}`,
    );
  }
  if (counts.rules_filings) {
    parts.push(
      `${counts.rules_filings} Rules filing${counts.rules_filings === 1 ? "" : "s"}`,
    );
  }
  if (counts.observed_links) {
    parts.push(
      `${counts.observed_links} linked filing${counts.observed_links === 1 ? "" : "s"}`,
    );
  }
  return parts;
}

/**
 * Status-line fragments for reports (omit zero filing receipts).
 * @returns {string[]}
 */
export function mandateReportsStatusParts(counts = {}) {
  const parts = [];
  if (counts.report_mandates) {
    parts.push(
      `${counts.report_mandates} report mandate${counts.report_mandates === 1 ? "" : "s"}`,
    );
  }
  if (counts.filing_receipts) {
    parts.push(
      `${counts.filing_receipts} filing receipt${counts.filing_receipts === 1 ? "" : "s"}`,
    );
  }
  return parts;
}

/**
 * Per-row primary actions: Source law (Legistar matter) + Open in Rules /
 * Meetings / Contracts when the view carries agency-scoped browse hrefs.
 *
 * @param {{
 *   source_href?: string|null,
 *   matter_id?: string|null,
 *   graph_neighbors?: object|null,
 *   prefer?: "rules"|"meetings"|"contracts"|null,
 *   escape?: (s: string) => string,
 * }} opts
 * @returns {string} HTML fragment (leading " · " pieces) or empty string
 */
export function renderMandateRowGraphActions(opts = {}) {
  const escape = typeof opts.escape === "function" ? opts.escape : escDefault;
  const matter = mandateMatterEdgeFromRow({
    matter_id: opts.matter_id,
    source_href: opts.source_href,
  });
  const neighbors = normalizeMandateGraphNeighbors(opts.graph_neighbors || {});
  const prefer = opts.prefer || null;
  const pieces = [];

  if (matter?.href) {
    pieces.push(officialSourceLink({
      href: matter.href,
      label: "Source law",
      className: "agency-source-link",
      attributes: {
        "data-mandate-edge": "source_law",
        ...(matter.matter_id ? { "data-matter-id": matter.matter_id } : {}),
      },
      escape,
    }));
  }

  const openLinks = [];
  if (neighbors?.rules_browse_href) {
    openLinks.push({
      key: "rules",
      href: neighbors.rules_browse_href,
      label: "Open in Rules",
    });
  }
  if (neighbors?.meetings_browse_href) {
    openLinks.push({
      key: "meetings",
      href: neighbors.meetings_browse_href,
      label: "Open in Meetings",
    });
  }
  if (neighbors?.contracts_browse_href) {
    openLinks.push({
      key: "contracts",
      href: neighbors.contracts_browse_href,
      label: "Open in Contracts",
    });
  }

  // Prefer the section's home lens first, then the remaining co-located scopes.
  openLinks.sort((left, right) => {
    if (prefer && left.key === prefer) return -1;
    if (prefer && right.key === prefer) return 1;
    return 0;
  });

  for (const link of openLinks) {
    pieces.push(constellationLink({
      href: link.href,
      label: link.label,
      className: "agency-edge-link",
      attributes: {
        "data-mandate-graph-neighbor": link.key,
      },
      escape,
    }));
  }

  if (!pieces.length) return "";
  return pieces.map((html) => ` · ${html}`).join("");
}

/**
 * Section-level chrome: Contracts + Meetings (and Rules when not already the
 * primary section action). Used when the H2 leads with co-located neighbors
 * rather than claiming per-mandate filing edges.
 */
export function renderMandateSectionNeighborActions(opts = {}) {
  const escape = typeof opts.escape === "function" ? opts.escape : escDefault;
  const neighbors = normalizeMandateGraphNeighbors(opts.graph_neighbors || {});
  if (!neighbors) return "";
  const omit = new Set(Array.isArray(opts.omit) ? opts.omit : []);
  const links = [];
  if (neighbors.rules_browse_href && !omit.has("rules")) {
    links.push(`<a class="node-action civic-object-action" href="${escape(neighbors.rules_browse_href)}" data-mandate-graph-neighbor="rules">Open in Rules</a>`);
  }
  if (neighbors.meetings_browse_href && !omit.has("meetings")) {
    links.push(`<a class="node-action civic-object-action" href="${escape(neighbors.meetings_browse_href)}" data-mandate-graph-neighbor="meetings">Open in Meetings</a>`);
  }
  if (neighbors.contracts_browse_href && !omit.has("contracts")) {
    links.push(`<a class="node-action civic-object-action" href="${escape(neighbors.contracts_browse_href)}" data-mandate-graph-neighbor="contracts">Open in Contracts</a>`);
  }
  return links.join("");
}
