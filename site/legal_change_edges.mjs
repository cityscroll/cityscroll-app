/**
 * Source-explicit legislative instructions.
 *
 * This parser deliberately has a narrow admission boundary: a citation is
 * emitted only from the same source clause as an explicit statutory operation.
 * It is not a policy-impact or topic classifier.
 */

import { normalizeAdminCodeCitation } from "./admin_code_search.mjs";
import {
  LEGAL_CHANGE_GRAPH_SCHEMA,
  codeChange,
  legalChangeGraph,
} from "../ontology/legal_change.mjs";
export {
  materializeCodeChange,
  materializeCodeChanges,
  readableCodeDiff,
  resolveCodeChangeEffectiveDate,
} from "./code_version_materialization.mjs";

export const LEGAL_CHANGE_EDGE_SCHEMA = "cityscroll.legal_change_edge.v1";
export const ADMIN_CODE_CORPUS_ID = "nyc-administrative-code";

const OPERATION_PATTERNS = Object.freeze([
  { operation: "amend", pattern: /\b(?:is|are|shall\s+be)\s+amended\b/gi },
  { operation: "repeal", pattern: /\b(?:is|are|shall\s+be)\s+(?:hereby\s+)?repealed\b/gi },
  { operation: "redesignate", pattern: /\b(?:is|are|shall\s+be)\s+redesignated\b/gi },
  { operation: "rename", pattern: /\b(?:is|are|shall\s+be)\s+renamed\b/gi },
  { operation: "add", pattern: /\b(?:is|are|shall\s+be)\s+(?:hereby\s+)?added\b/gi },
]);

const CORPUS_MARKERS = Object.freeze([
  { corpus_id: ADMIN_CODE_CORPUS_ID, pattern: /\b(?:NYC\s+)?administrative\s+code\b/i },
  { corpus_id: "nyc-building-code", pattern: /\b(?:NYC\s+)?building\s+code\b/i },
  { corpus_id: "nyc-plumbing-code", pattern: /\b(?:NYC\s+)?plumbing\s+code\b/i },
  { corpus_id: "nyc-mechanical-code", pattern: /\b(?:NYC\s+)?mechanical\s+code\b/i },
  { corpus_id: "nyc-fuel-gas-code", pattern: /\b(?:NYC\s+)?fuel\s+gas\s+code\b/i },
  { corpus_id: "nyc-charter", pattern: /\b(?:NYC\s+)?charter\b/i },
  { corpus_id: "nyc-rcny", pattern: /\b(?:rules\s+of\s+the\s+city\s+of\s+new\s+york|RCNY)\b/i },
]);

function clean(value, max = 8_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sourceText(value) {
  if (typeof value === "string") return value;
  return value?.source_text || value?.text || value?.body || value?.document_text || "";
}

function sourceRef(value = {}) {
  return {
    source_ref: clean(value.source_ref || value.document_id || value.id, 500) || null,
    url: clean(value.url || value.source_url, 2_000) || null,
    source_system: clean(value.source_system || value.system, 160) || null,
    observed_at: clean(value.observed_at, 80) || null,
    document_id: clean(value.document_id, 240) || null,
  };
}

function lineStart(text, offset) {
  const start = text.lastIndexOf("\n", offset);
  return start < 0 ? 0 : start + 1;
}

function lineEnd(text, offset) {
  const end = text.indexOf("\n", offset);
  return end < 0 ? text.length : end;
}

function clauseFor(text, markerStart, markerEnd) {
  const boundaries = [lineStart(text, markerStart)];
  const semicolonPosition = text.lastIndexOf(";", markerStart - 1);
  if (semicolonPosition >= 0) boundaries.push(semicolonPosition + 1);
  const sentenceBreaks = [...text.slice(0, markerStart).matchAll(/\.\s+/g)];
  if (sentenceBreaks.length) boundaries.push(sentenceBreaks.at(-1).index + 1);
  const start = Math.max(...boundaries);
  const end = lineEnd(text, markerEnd);
  const line = text.slice(start, end).trim();
  // A statutory instruction normally ends at a colon/semicolon. Keeping the
  // replacement text out of the clause prevents its citations being inferred
  // as additional targets.
  const operationEnd = markerEnd - start;
  const colon = line.indexOf(":", operationEnd);
  const semicolon = line.indexOf(";", operationEnd);
  const cutoff = [colon, semicolon].filter((value) => value >= 0).sort((a, b) => a - b)[0];
  return {
    text: cutoff == null ? line : line.slice(0, cutoff).trim(),
    start: start + text.slice(start, end).indexOf(line),
  };
}

function citationMatches(clause) {
  const matches = [];
  const pattern = /(?:§|sections?|secs?\.?|paragraphs?|subsections?)\s*([0-9]+[A-Za-z]?-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)/gi;
  for (const match of clause.matchAll(pattern)) {
    const citation = normalizeAdminCodeCitation(match[1]);
    if (citation) matches.push({ citation, index: match.index });
  }
  // A list may name the first section once and use bare section numbers for
  // the remaining targets. The surrounding operation is still required.
  if (matches.length && /(?:sections?|secs?\.?|paragraphs?|subsections?)\b/i.test(clause)) {
    const known = new Set(matches.map((match) => match.citation));
    for (const match of clause.matchAll(/\b([0-9]+[A-Za-z]?-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)\b/gi)) {
      const citation = normalizeAdminCodeCitation(match[1]);
      if (citation && !known.has(citation)) matches.push({ citation, index: match.index });
    }
  }
  return matches;
}

function corpusForCitation(clause, citationIndex, fallback = null) {
  const candidates = CORPUS_MARKERS.flatMap((marker) => [...clause.matchAll(new RegExp(marker.pattern.source, "gi"))].map((match) => ({
    corpus_id: marker.corpus_id,
    index: match.index,
  })));
  const preceding = candidates.filter((candidate) => candidate.index <= citationIndex);
  if (preceding.length) return preceding.at(-1).corpus_id;
  if (candidates.length) return candidates[0].corpus_id;
  return clean(fallback, 120) || null;
}

function targetId(corpusId, citation) {
  return corpusId === ADMIN_CODE_CORPUS_ID ? `${ADMIN_CODE_CORPUS_ID}:${citation}` : null;
}

function explicitWholeProvisionPatch(text, operationEnd, operation) {
  if (operation !== "amend") return null;
  const remainder = String(text || "").slice(operationEnd);
  const marker = remainder.match(/^\s*to\s+read\s+as\s+follows\s*:\s*/i);
  if (!marker) return null;
  const afterText = remainder
    .slice(marker[0].length)
    .split(/\n\s*(?=(?:section|sections|subsection|subsections|paragraph|paragraphs)\b)/i)[0]
    .replace(/[;\s]+$/, "")
    .trim();
  return afterText ? { after_text: afterText, scope: "whole_provision" } : null;
}

function targetResolution(targetIdValue, corpusId, knownProvisionIds) {
  if (corpusId !== ADMIN_CODE_CORPUS_ID) return "unresolved_external_corpus";
  if (!(knownProvisionIds instanceof Set)) return "unknown";
  return knownProvisionIds.has(targetIdValue) ? "resolved" : "unresolved_not_ingested";
}

function explicitMatches(text, { corpus_id: fallbackCorpusId = null } = {}) {
  const matches = [];
  for (const operationEntry of OPERATION_PATTERNS) {
    for (const operationMatch of text.matchAll(operationEntry.pattern)) {
      const clause = clauseFor(text, operationMatch.index, operationMatch.index + operationMatch[0].length);
      const citations = citationMatches(clause.text);
      for (const citationMatch of citations) {
        const corpusId = corpusForCitation(clause.text, citationMatch.index, fallbackCorpusId);
        if (!corpusId) continue;
        const operation = operationEntry.operation === "amend"
          && /\b(?:heading|title)\b/i.test(clause.text)
          ? "rename"
          : operationEntry.operation;
        const provisionId = targetId(corpusId, citationMatch.citation);
        matches.push({
          operation,
          corpus_id: corpusId,
          citation: citationMatch.citation,
          provision_id: provisionId,
          source_text: clause.text,
          source_start: clause.start,
          source_end: clause.start + clause.text.length,
          patch: explicitWholeProvisionPatch(text, operationMatch.index + operationMatch[0].length, operation),
        });
      }
    }
  }
  const seen = new Set();
  return matches.filter((match) => {
    const key = `${match.operation}:${match.corpus_id}:${match.citation}:${match.source_start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.source_start - right.source_start || left.citation.localeCompare(right.citation, "en-US", { numeric: true }));
}

export function extractExplicitCodeChanges(value, options = {}) {
  const text = sourceText(value);
  if (!clean(text)) return [];
  const knownProvisionIds = options.known_provision_ids instanceof Set
    ? options.known_provision_ids
    : Array.isArray(options.known_provision_ids) ? new Set(options.known_provision_ids) : null;
  const source = sourceRef(typeof value === "object" ? value : options);
  return explicitMatches(text, options).map((match) => codeChange({
    id: `${source.source_ref || "source"}:${match.operation}:${match.corpus_id}:${match.citation}:${match.source_start}`,
    operation: match.operation,
    matter_id: options.matter_id || value?.matter_id || value?.matter?.id || value?.matter?.matter_id,
    legal_instrument_id: options.legal_instrument_id || value?.legal_instrument_id || value?.local_law?.id,
    state: options.state || value?.state || (value?.local_law ? "enacted" : "prospective"),
    effective_at: options.effective_at || value?.effective_at || value?.local_law?.effective_at,
    effective_date_text: options.effective_date_text || value?.effective_date_text || value?.local_law?.effective_date_text,
    effective_date_clauses: options.effective_date_clauses || value?.effective_date_clauses || value?.local_law?.effective_date_clauses,
    target: {
      corpus_id: match.corpus_id,
      citation: `§ ${match.citation}`,
      provision_id: match.provision_id,
      resolution: targetResolution(match.provision_id, match.corpus_id, knownProvisionIds),
    },
    source: {
      ...source,
      instruction_text: match.source_text,
      start: match.source_start,
      end: match.source_end,
    },
    patch: match.patch,
    materialization_confidence: "unknown",
  }));
}

export function buildExplicitLegalChangeGraph({ matter = null, local_law = null, source_text = "", source = {}, corpus_id = null, known_provision_ids = null, effective_at = null } = {}) {
  const changes = extractExplicitCodeChanges({
    source_text,
    ...source,
    matter_id: matter?.id || matter?.matter_id,
    local_law,
  }, {
    corpus_id,
    known_provision_ids,
    effective_at,
  });
  return legalChangeGraph({ matter, local_law, changes });
}

export function indexLegalChanges(graphs = []) {
  const normalized = graphs.filter((graph) => graph?.schema === LEGAL_CHANGE_GRAPH_SCHEMA);
  const byProvision = new Map();
  const byMatter = new Map();
  for (const graph of normalized) {
    const matterId = graph.matter?.id || graph.local_law?.matter_id || null;
    if (matterId) byMatter.set(matterId, [...(byMatter.get(matterId) || []), graph]);
    for (const change of graph.changes) {
      const provisionId = change.target.provision_id;
      if (provisionId) byProvision.set(provisionId, [...(byProvision.get(provisionId) || []), { graph, change }]);
    }
  }
  return Object.freeze({
    schema: LEGAL_CHANGE_EDGE_SCHEMA,
    graphs: Object.freeze(normalized),
    by_provision: Object.freeze(Object.fromEntries(byProvision)),
    by_matter: Object.freeze(Object.fromEntries(byMatter)),
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function targetLabel(change) {
  const target = change?.target || {};
  const corpus = target.corpus_id === ADMIN_CODE_CORPUS_ID
    ? "Administrative Code"
    : target.corpus_id || "Unresolved legal corpus";
  return `${corpus}${target.citation ? ` ${target.citation}` : ""}`;
}

function targetHref(change) {
  const target = change?.target || {};
  if (target.corpus_id !== ADMIN_CODE_CORPUS_ID || !target.citation) return null;
  const citation = normalizeAdminCodeCitation(target.citation);
  return citation ? `/administrative-code/${encodeURIComponent(citation)}/` : null;
}

function matterHref(change) {
  const value = String(change?.matter_id || "").replace(/^matter:/, "");
  return /^\d+$/.test(value) ? `/matters/${encodeURIComponent(value)}/` : null;
}

function materializationMarkup(change) {
  const materialization = change?.materialization;
  if (change?.materialization_status === "materialized" && materialization) {
    const before = materialization.before_text == null
      ? "No prior provision text"
      : `<pre class="code-change-text code-change-before">${escapeHtml(materialization.before_text)}</pre>`;
    const after = materialization.after_text == null
      ? "Provision is inactive after repeal"
      : `<pre class="code-change-text code-change-after">${escapeHtml(materialization.after_text)}</pre>`;
    const diff = materialization.diff?.text
      ? `<details class="code-change-diff"><summary>Diff</summary><pre>${escapeHtml(materialization.diff.text)}</pre></details>`
      : "";
    return `<div class="code-change-materialization" data-materialization-status="materialized"><p><strong>Before</strong></p>${before}<p><strong>After</strong></p>${after}${diff}</div>`;
  }
  if (change?.materialization_status === "unresolved" && materialization?.reason && change.state !== "prospective") {
    return `<p class="code-change-materialization" data-materialization-status="unresolved">CityScroll identified the legal change instruction but has not safely reconstructed the resulting text.</p>`;
  }
  return "";
}

export function renderLegalChangeList(changes = [], { empty = "No explicit statutory changes are modeled." } = {}) {
  const rows = (Array.isArray(changes) ? changes : []).map((change) => {
    const href = targetHref(change);
    const target = href ? `<a href="${escapeHtml(href)}">${escapeHtml(targetLabel(change))}</a>` : escapeHtml(targetLabel(change));
    const source = change.source?.url
      ? ` · <a href="${escapeHtml(change.source.url)}" rel="noopener noreferrer">Source</a>`
      : "";
    const timeline = matterHref(change)
      ? ` · <a href="${escapeHtml(matterHref(change))}">Matter timeline</a>`
      : "";
    const state = change.state === "prospective" ? "Prospective proposal" : "Enacted change";
    return `<li data-code-change-id="${escapeHtml(change.id)}" data-code-change-state="${escapeHtml(change.state)}"><strong>${escapeHtml(change.operation.toUpperCase())}</strong> · ${target} <span class="legal-change-state">${escapeHtml(state)}</span>${timeline}${source}<p>${escapeHtml(change.source?.instruction_text || "Source-stated instruction retained.")}</p>${materializationMarkup(change)}</li>`;
  });
  return rows.length ? `<ul class="legal-change-list">${rows.join("")}</ul>` : `<p class="legal-change-empty">${escapeHtml(empty)}</p>`;
}

export function renderLegalChangeSummary(graph) {
  if (!graph || graph.schema !== LEGAL_CHANGE_GRAPH_SCHEMA || !graph.changes?.length) return "";
  const enacted = Boolean(graph.local_law);
  const heading = enacted ? "What this law changed" : "What this proposal changes";
  const note = enacted
    ? "These are source-stated legal instructions. Enactment is shown separately from effectiveness."
    : "These are prospective source-stated instructions; a pending matter is not current law.";
  return `<section class="node-section node-card legal-change-summary" aria-labelledby="legal-changes-heading"><h2 id="legal-changes-heading">${heading}</h2><p class="node-muted">${note}</p>${renderLegalChangeList(graph.changes)}</section>`;
}

export { targetId };
