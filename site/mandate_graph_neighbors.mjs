/**
 * Mandate graph neighbors (mand-graph-01, specificity fix).
 *
 * Per-mandate row actions must be mandate-specific:
 *   - Source law (exact Legistar matter_id) always when present
 *   - Linked entity chips only when a real mandate→entity edge exists
 *
 * Agency-wide Rules / Meetings / Contracts browse scopes are section chrome
 * only (`renderMandateSectionNeighborActions`), labeled as agency-wide so they
 * never look like a per-mandate connection. Never invent a mandate→entity edge.
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
 * Compact agency-wide graph-neighbor destinations.
 * Callers supply browse hrefs built with agencyCategoryBrowseHref — this
 * module does not invent scopes. These are section chrome only.
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
 * Real per-mandate entity links only. Each entry needs an href; no agency
 * browse fallback. Empty / missing fields are dropped (source-null stays null).
 *
 * @param {Array<{ key?: string, href?: string, label?: string, relation?: string }>|object|null} raw
 * @returns {Array<{ key: string|null, href: string, label: string, relation: string|null }>}
 */
export function normalizeMandateScopedLinks(raw = []) {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === "object" ? Object.values(raw) : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const href = clean(item.href, 400);
    if (!href) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const key = clean(item.key || item.lens || item.category, 40) || null;
    const relation = clean(item.relation || item.signal_kind || key, 60) || null;
    const label = clean(item.label, 80)
      || (key === "rules" ? "Linked Rules filing"
        : key === "meetings" ? "Linked meeting"
          : key === "contracts" ? "Linked contract"
            : key === "report" || key === "reports" ? "Filing receipt"
              : "Linked record");
    out.push({ key, href, label, relation });
  }
  return out;
}

/**
 * Build mandate-scoped link entries from an observed filing / edge record.
 * Returns [] when the record has no href — never invents.
 *
 * @param {{ href?: string, request_id?: string, label?: string, signal_kind?: string }|null} record
 * @param {{ kind?: string, label?: string }} opts
 */
export function mandateScopedLinksFromRecord(record, opts = {}) {
  if (!record) return [];
  const href = clean(record.href, 400);
  if (!href) return [];
  const kind = clean(opts.kind || record.signal_kind || "record", 40) || "record";
  const key = kind === "rule_filing" || kind === "rules" ? "rules"
    : kind === "report_or_study" || kind === "report" || kind === "reports" ? "report"
      : kind === "public_hearing" || kind === "meetings" ? "meetings"
        : kind === "contract" || kind === "contracts" || kind === "implemented_by_contract"
          ? "contracts"
          : kind;
  return normalizeMandateScopedLinks([{
    key,
    href,
    label: opts.label || null,
    relation: clean(record.signal_kind || key, 60) || key,
  }]);
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
 * Per-row primary actions: Source law (Legistar matter) + only real
 * mandate-scoped entity links.
 *
 * Agency-wide `graph_neighbors` browse hrefs are intentionally ignored here —
 * they are section chrome (`renderMandateSectionNeighborActions`). A mandate
 * card must never imply a specific connection it does not have.
 *
 * @param {{
 *   source_href?: string|null,
 *   matter_id?: string|null,
 *   mandate_links?: Array<object>|null,
 *   scoped_links?: Array<object>|null,
 *   graph_neighbors?: object|null,
 *   prefer?: "rules"|"meetings"|"contracts"|"report"|null,
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

  // Real per-mandate edges only. graph_neighbors (agency browse) is not used.
  const openLinks = normalizeMandateScopedLinks(
    opts.mandate_links || opts.scoped_links || [],
  );

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
        "data-mandate-scoped": "1",
        ...(link.relation ? { "data-mandate-edge": link.relation } : {}),
        ...(link.key ? { "data-mandate-graph-neighbor": link.key } : {}),
      },
      escape,
    }));
  }

  if (!pieces.length) return "";
  return pieces.map((html) => ` · ${html}`).join("");
}

/**
 * Section-level agency-wide browse chrome. Labeled honestly as agency scope so
 * it is never mistaken for a per-mandate edge. Used once under the section H2,
 * not on every mandate card.
 */
export function renderMandateSectionNeighborActions(opts = {}) {
  const escape = typeof opts.escape === "function" ? opts.escape : escDefault;
  const neighbors = normalizeMandateGraphNeighbors(opts.graph_neighbors || {});
  if (!neighbors) return "";
  const omit = new Set(Array.isArray(opts.omit) ? opts.omit : []);
  const links = [];
  if (neighbors.rules_browse_href && !omit.has("rules")) {
    links.push(
      `<a class="node-action civic-object-action" href="${escape(neighbors.rules_browse_href)}" data-mandate-graph-neighbor="rules" data-scope="agency">Browse agency Rules</a>`,
    );
  }
  if (neighbors.meetings_browse_href && !omit.has("meetings")) {
    links.push(
      `<a class="node-action civic-object-action" href="${escape(neighbors.meetings_browse_href)}" data-mandate-graph-neighbor="meetings" data-scope="agency">Browse agency Meetings</a>`,
    );
  }
  if (neighbors.contracts_browse_href && !omit.has("contracts")) {
    links.push(
      `<a class="node-action civic-object-action" href="${escape(neighbors.contracts_browse_href)}" data-mandate-graph-neighbor="contracts" data-scope="agency">Browse agency Contracts</a>`,
    );
  }
  return links.join("");
}
