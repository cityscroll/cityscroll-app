/**
 * Evidence-bearing AgencyRulemaking → cites_authority → CodeProvision join.
 *
 * Only an exact source-stated Administrative Code citation mints a public
 * legal relation. Authority-at-publication uses the law-at-time-T lookup
 * when a known CodeVersion covers the rule date; otherwise the historical
 * comparison stays unknown. Later provision changes are possible
 * authority-basis changes only.
 */

import {
  adminCodeHref,
  adminCodeProvisionId,
  normalizeAdminCodeCitation,
} from "./admin_code_search.mjs";
import { getProvisionAsOf, validAsOfDate } from "./code_provision_history.mjs";
import { compactCitationLawKeys } from "./rule_evidence_stamps.mjs";

export const ADMIN_CODE_CORPUS_ID = "nyc-administrative-code";
export const CITES_AUTHORITY_SCHEMA = "cityscroll.cites_authority.v1";
export const CITES_AUTHORITY_RELATION = "cites_authority";
export const CITED_AS_AUTHORITY_BY_RELATION = "cited_as_authority_by";

export const RULEMAKING_AUTHORITY_SCHEMA = "cityscroll.rulemaking_authority.v1";
export const CITES_AUTHORITY_METHOD = "exact_admin_code_authority_citation_v1";
export const CITES_AUTHORITY_EXTRACTION_VERSION = "1.0.0";
export const POSSIBLE_AUTHORITY_BASIS_CHANGE_COPY =
  "The cited provision later changed. This records a possible authority-basis change. Open the provision history to inspect the later amendment.";

export const AUTHORITY_UNRESOLVED_REASONS = Object.freeze({
  missing_source_document: "missing_source_document",
  malformed_section: "malformed_section",
  ambiguous_citation: "ambiguous_citation",
  rcny_citation: "rcny_citation",
  external_statute: "external_statute",
  unsupported_corpus: "unsupported_corpus",
  unresolved_version: "unresolved_version",
  generic_authority: "generic_authority",
});

const AUTHORITY_WINDOW = /(?:pursuant\s+to|under\s+the\s+authority|authority\s+vested|authorized\s+by|authoriz(?:es|ed|ing)|based\s+on)[^.!?\n]{0,400}/gi;
const ADMIN_CODE_SECTION = /^nyc-admin-code:(\d+[a-z]?-\d[0-9a-z.]*)(?:\([^)]+\))?$/i;
const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function clean(value, max = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isoDay(value) {
  const match = clean(value, 80).match(ISO_DAY);
  return match?.[1] || validAsOfDate(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sourceUrl(value) {
  const href = clean(value, 2_000);
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function documentText(document = {}) {
  return clean(document.text || document.extracted_text || document.source_text, 50_000);
}

function documentId(document = {}) {
  return clean(document.source_id || document.document_id || document.id, 300) || null;
}

function observedAt(document = {}, fallback = null) {
  return clean(document.observed_at || document.observedAt || fallback, 80) || null;
}

function publicationDate(document = {}, rulemaking = null) {
  return isoDay(
    document.published_at
    || document.publication_date
    || document.notice_date
    || rulemaking?.notice_date
    || rulemaking?.nyc_rules?.adoption_published_at,
  );
}

function sourceFields(document = {}, span = null) {
  const fields = [];
  if (document.text || document.extracted_text || document.source_text) fields.push("document_text");
  if (document.authority_citation) fields.push("authority_citation");
  if (span?.field && !fields.includes(span.field)) fields.push(span.field);
  return Object.freeze(fields);
}

function reasonCopy(reason) {
  return {
    missing_source_document: "No retained source document states the claimed authority.",
    malformed_section: "The source citation is not a well-formed Administrative Code section.",
    ambiguous_citation: "The source citation is ambiguous and is not a unique Administrative Code provision.",
    rcny_citation: "The source cites the Rules of the City of New York, which is not Administrative Code statutory authority.",
    external_statute: "The source cites an external statute, Charter provision, or other non-Administrative-Code instrument.",
    unsupported_corpus: "The cited corpus is not the NYC Administrative Code.",
    unresolved_version: "CityScroll does not have a CodeVersion with known legal validity on the rule publication date.",
    generic_authority: "A generic authority phrase is not an exact Administrative Code citation.",
  }[reason] || "The authority citation could not be resolved.";
}

function sourceSpan(text, start, end, field = "document_text") {
  const value = String(text || "").slice(start, end);
  const excerpt = clean(value, 1_200);
  return excerpt ? freeze({ field, start, end, text: excerpt }) : null;
}

function authorityWindows(text) {
  return [...String(text || "").matchAll(AUTHORITY_WINDOW)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function classifyKey(key) {
  const value = clean(key, 200).toLowerCase();
  if (!value) return null;
  if (value.startsWith("rcny:")) return { kind: "rcny", key: value, reason: AUTHORITY_UNRESOLVED_REASONS.rcny_citation };
  if (value.startsWith("nyc-charter:") || value.startsWith("local-law:")) {
    return { kind: "external", key: value, reason: AUTHORITY_UNRESOLVED_REASONS.external_statute };
  }
  if (value.startsWith("nyc-admin-code:")) {
    const match = value.match(ADMIN_CODE_SECTION);
    if (!match) return { kind: "malformed", key: value, reason: AUTHORITY_UNRESOLVED_REASONS.malformed_section };
    const citation = normalizeAdminCodeCitation(match[1]);
    if (!citation) return { kind: "malformed", key: value, reason: AUTHORITY_UNRESOLVED_REASONS.malformed_section };
    return { kind: "admin_code", key: value, citation, provision_id: adminCodeProvisionId(citation) };
  }
  if (value.startsWith("section:")) {
    return { kind: "ambiguous", key: value, reason: AUTHORITY_UNRESOLVED_REASONS.ambiguous_citation };
  }
  return { kind: "unsupported", key: value, reason: AUTHORITY_UNRESOLVED_REASONS.unsupported_corpus };
}

function classifyWindow(windowText) {
  const keys = compactCitationLawKeys(windowText, { limit: 16 });
  const classified = keys.map(classifyKey).filter(Boolean);
  const admin = [];
  const seenAdmin = new Set();
  const others = [];
  for (const item of classified) {
    if (item.kind === "admin_code") {
      if (seenAdmin.has(item.provision_id)) continue;
      seenAdmin.add(item.provision_id);
      admin.push(item);
      continue;
    }
    others.push(item);
  }
  const mentionsAdmin = /administrative\s+code/i.test(windowText);
  const mentionsRcny = /\brcny\b/i.test(windowText);
  const mentionsCharter = /\bcharter\b/i.test(windowText);
  const mentionsExternal = /\b(?:united states|u\.s\.c|state of new york|multiple dwelling law|general municipal law|building code|plumbing code)\b/i.test(windowText);
  if (admin.length === 1 && mentionsAdmin) {
    const noise = new Set(admin.flatMap((item) => {
      const parent = item.citation.split("-")[0];
      return [
        `nyc-admin-code:${parent}`,
        `section:${item.citation}`,
        `section:${parent}`,
      ];
    }));
    return {
      admin,
      others: others.filter((item) => !noise.has(item.key) && !admin.some((hit) => String(item.key || "").startsWith(`section:${hit.citation}`))),
      status: "exact",
    };
  }
  if (admin.length > 1 && mentionsAdmin) {
    return {
      admin: [],
      others: [{ kind: "ambiguous", reason: AUTHORITY_UNRESOLVED_REASONS.ambiguous_citation, key: admin.map((item) => item.citation).join(",") }],
      status: "unresolved",
    };
  }
  if (mentionsRcny && !mentionsAdmin) {
    return { admin: [], others: [{ kind: "rcny", reason: AUTHORITY_UNRESOLVED_REASONS.rcny_citation, key: keys.find((key) => key.startsWith("rcny:")) || "rcny" }], status: "unresolved" };
  }
  if ((mentionsCharter || mentionsExternal) && !mentionsAdmin) {
    const reason = mentionsExternal && !mentionsCharter
      ? AUTHORITY_UNRESOLVED_REASONS.unsupported_corpus
      : AUTHORITY_UNRESOLVED_REASONS.external_statute;
    return { admin: [], others: [{ kind: "external", reason, key: keys[0] || "external" }], status: "unresolved" };
  }
  if (others.length) return { admin: [], others, status: "unresolved" };
  if (/authority/i.test(windowText)) {
    return {
      admin: [],
      others: [{ kind: "generic", reason: AUTHORITY_UNRESOLVED_REASONS.generic_authority, key: "authority" }],
      status: "unresolved",
    };
  }
  return { admin: [], others: [], status: "empty" };
}

function unresolvedObservation({
  rulemakingId,
  reason,
  document,
  span = null,
  citation = null,
  corpus = null,
  observedAt: observed = null,
}) {
  return freeze({
    schema: CITES_AUTHORITY_SCHEMA,
    status: "unresolved",
    relation: CITES_AUTHORITY_RELATION,
    inverse: CITED_AS_AUTHORITY_BY_RELATION,
    linking: false,
    from_ref: rulemakingId,
    to_ref: null,
    provision_id: null,
    citation,
    corpus_id: corpus,
    unresolved_reason: reason,
    unresolved_copy: reasonCopy(reason),
    source_document_id: documentId(document),
    source_record_id: clean(document?.request_id, 80) || documentId(document),
    source_url: sourceUrl(document?.source_url || document?.url),
    source_fields: sourceFields(document, span),
    source_span: span,
    observed_at: observed || observedAt(document),
    extraction_method: CITES_AUTHORITY_METHOD,
    extraction_version: CITES_AUTHORITY_EXTRACTION_VERSION,
    authority_at_publication: freeze({
      status: "unknown",
      as_of: publicationDate(document),
      version: null,
      text: null,
      reason: reason === AUTHORITY_UNRESOLVED_REASONS.unresolved_version
        ? reasonCopy(reason)
        : "Authority-at-publication is withheld until the citation and version evidence resolve exactly.",
    }),
    possible_basis_change: null,
    duplicated_rulemaking: false,
    duplicated_provision: false,
  });
}

function laterChanges(changes, provisionId, asOf) {
  if (!asOf) return [];
  return (Array.isArray(changes) ? changes : []).filter((change) => {
    if (change?.target?.provision_id !== provisionId && change?.redesignation?.successor_provision_id !== provisionId) {
      return false;
    }
    const effective = isoDay(change.effective_at || change.materialization?.effective_at);
    return effective && effective > asOf;
  });
}

function authorityAtPublication({ provisionId, provision, versions, changes, asOf }) {
  const asOfResult = getProvisionAsOf({
    provision_id: provisionId,
    provision,
    versions,
    changes,
    as_of: asOf,
  });
  if (!asOf || asOfResult.status === "unknown" || !asOfResult.version) {
    return freeze({
      status: "unknown",
      as_of: asOf,
      version: null,
      text: null,
      reason: reasonCopy(AUTHORITY_UNRESOLVED_REASONS.unresolved_version),
      used_publisher_current_text: false,
      clocks: freeze({
        valid_from: null,
        valid_to: null,
        observed_at: null,
      }),
    });
  }
  return freeze({
    status: asOfResult.status,
    as_of: asOf,
    version: asOfResult.version,
    text: asOfResult.text,
    reason: null,
    used_publisher_current_text: asOfResult.used_publisher_current_text === true,
    clocks: freeze({
      valid_from: asOfResult.version.valid_from || null,
      valid_to: asOfResult.version.valid_to || null,
      observed_at: asOfResult.version.observed_at || null,
    }),
    content_hash: asOfResult.content_hash,
    source_ref: asOfResult.source_ref,
  });
}

function acceptedEdge({
  rulemakingId,
  citation,
  document,
  span,
  provision,
  versions,
  changes,
  observed,
}) {
  const provisionId = adminCodeProvisionId(citation);
  const asOf = publicationDate(document);
  const atPublication = authorityAtPublication({
    provisionId,
    provision: provision || { id: provisionId, citation: `§ ${citation}` },
    versions,
    changes,
    asOf,
  });
  const later = laterChanges(changes, provisionId, asOf);
  return freeze({
    schema: CITES_AUTHORITY_SCHEMA,
    status: "accepted",
    relation: CITES_AUTHORITY_RELATION,
    inverse: CITED_AS_AUTHORITY_BY_RELATION,
    linking: true,
    from_ref: rulemakingId,
    to_ref: provisionId,
    provision_id: provisionId,
    citation: `§ ${citation}`,
    corpus_id: ADMIN_CODE_CORPUS_ID,
    href: adminCodeHref(citation),
    lookup_id: provisionId,
    unresolved_reason: atPublication.status === "unknown" ? AUTHORITY_UNRESOLVED_REASONS.unresolved_version : null,
    unresolved_copy: atPublication.status === "unknown" ? atPublication.reason : null,
    source_document_id: documentId(document),
    source_record_id: clean(document?.request_id, 80) || documentId(document),
    source_url: sourceUrl(document?.source_url || document?.url),
    source_fields: sourceFields(document, span),
    source_span: span,
    observed_at: observed || observedAt(document),
    extraction_method: CITES_AUTHORITY_METHOD,
    extraction_version: CITES_AUTHORITY_EXTRACTION_VERSION,
    authority_at_publication: atPublication,
    possible_basis_change: later.length
      ? freeze({
        status: "possible",
        copy: POSSIBLE_AUTHORITY_BASIS_CHANGE_COPY,
        later_operations: later.map((change) => change.operation).filter(Boolean),
      })
      : null,
    duplicated_rulemaking: false,
    duplicated_provision: false,
  });
}

function documentsFrom(input) {
  if (Array.isArray(input.documents) && input.documents.length) return input.documents;
  if (Array.isArray(input.rulemaking?.versions)) return input.rulemaking.versions;
  if (Array.isArray(input.rule_version_documents)) return input.rule_version_documents;
  return [];
}

function explicitMalformed(document) {
  const raw = clean(document.authority_citation || document.malformed_citation, 240);
  if (!raw) return false;
  if (/administrative\s+code/i.test(raw) && !normalizeAdminCodeCitation(raw)) return true;
  return false;
}

/**
 * Project cites_authority edges from retained rulemaking source documents.
 */
export function projectRulemakingAuthority(input = {}) {
  const rulemaking = input.rulemaking || {};
  const rulemakingId = clean(rulemaking.rulemaking_id || input.rulemaking_id, 700) || null;
  const documents = documentsFrom(input);
  const versions = Array.isArray(input.versions) ? input.versions : [];
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const provision = input.provision || null;
  const observed = input.observed_at || null;
  const unresolved = [];
  const accepted = [];
  const seenProvision = new Set();

  if (!rulemakingId) {
    return freeze({
      schema: RULEMAKING_AUTHORITY_SCHEMA,
      rulemaking_id: null,
      edges: [],
      unresolved: [unresolvedObservation({
        rulemakingId: null,
        reason: AUTHORITY_UNRESOLVED_REASONS.missing_source_document,
        document: {},
        observedAt: observed,
      })],
      accepted_count: 0,
      duplicated_objects: false,
    });
  }

  if (!documents.length) {
    unresolved.push(unresolvedObservation({
      rulemakingId,
      reason: AUTHORITY_UNRESOLVED_REASONS.missing_source_document,
      document: {},
      observedAt: observed,
    }));
  }

  for (const document of documents) {
    const text = documentText(document);
    const hasIdentity = Boolean(documentId(document) || sourceUrl(document.source_url || document.url));
    if (!hasIdentity) {
      unresolved.push(unresolvedObservation({
        rulemakingId,
        reason: AUTHORITY_UNRESOLVED_REASONS.missing_source_document,
        document,
        observedAt: observed,
      }));
      continue;
    }
    if (!text) {
      unresolved.push(unresolvedObservation({
        rulemakingId,
        reason: AUTHORITY_UNRESOLVED_REASONS.missing_source_document,
        document,
        observedAt: observed,
      }));
      continue;
    }
    if (explicitMalformed(document)) {
      unresolved.push(unresolvedObservation({
        rulemakingId,
        reason: AUTHORITY_UNRESOLVED_REASONS.malformed_section,
        document,
        citation: clean(document.authority_citation, 80),
        corpus: ADMIN_CODE_CORPUS_ID,
        observedAt: observed,
      }));
    }
    const windows = authorityWindows(text);
    if (!windows.length) {
      if (/authority/i.test(text)) {
        unresolved.push(unresolvedObservation({
          rulemakingId,
          reason: AUTHORITY_UNRESOLVED_REASONS.generic_authority,
          document,
          span: sourceSpan(text, 0, Math.min(text.length, 280)),
          observedAt: observed,
        }));
      }
      continue;
    }
    for (const window of windows) {
      const classified = classifyWindow(window.text);
      const span = sourceSpan(text, window.start, window.end);
      for (const other of classified.others) {
        unresolved.push(unresolvedObservation({
          rulemakingId,
          reason: other.reason,
          document,
          span,
          citation: other.key || null,
          corpus: other.kind === "rcny" ? "rcny" : other.kind === "admin_code" ? ADMIN_CODE_CORPUS_ID : other.kind,
          observedAt: observed,
        }));
      }
      for (const item of classified.admin) {
        if (seenProvision.has(item.provision_id)) continue;
        seenProvision.add(item.provision_id);
        accepted.push(acceptedEdge({
          rulemakingId,
          citation: item.citation,
          document,
          span,
          provision,
          versions: versions.filter((version) => version?.provision_id === item.provision_id),
          changes,
          observed,
        }));
      }
    }
  }

  return freeze({
    schema: RULEMAKING_AUTHORITY_SCHEMA,
    rulemaking_id: rulemakingId,
    edges: accepted,
    unresolved,
    accepted_count: accepted.length,
    duplicated_objects: false,
  });
}

export function attachRulemakingAuthority(object, options = {}) {
  if (!object || typeof object !== "object") return object;
  const projection = projectRulemakingAuthority({
    rulemaking: object,
    documents: options.documents,
    versions: options.versions,
    changes: options.changes,
    provision: options.provision,
    observed_at: options.observed_at,
  });
  return { ...object, authority: projection };
}

export function authorityCitedBy(provisionId, projections = []) {
  const id = adminCodeProvisionId(provisionId) || clean(provisionId, 240);
  return freeze((Array.isArray(projections) ? projections : [])
    .flatMap((projection) => projection?.edges || [])
    .filter((edge) => edge.status === "accepted" && edge.provision_id === id)
    .map((edge) => ({
      relation: CITED_AS_AUTHORITY_BY_RELATION,
      from_ref: edge.from_ref,
      to_ref: edge.provision_id,
      href: `/rules/${encodeURIComponent(edge.from_ref)}/`,
      source_url: edge.source_url,
      citation: edge.citation,
      authority_at_publication: edge.authority_at_publication,
      possible_basis_change: edge.possible_basis_change,
    })));
}

export function renderRulemakingAuthority(projection, { includeMissingDocument = false } = {}) {
  if (!projection) return "";
  const edges = Array.isArray(projection.edges) ? projection.edges : [];
  const unresolved = (Array.isArray(projection.unresolved) ? projection.unresolved : [])
    .filter((row) => includeMissingDocument || row.unresolved_reason !== AUTHORITY_UNRESOLVED_REASONS.missing_source_document || edges.length);
  if (!edges.length && !unresolved.length) return "";
  const acceptedMarkup = edges.map((edge) => {
    const asOf = edge.authority_at_publication;
    const versionCopy = asOf?.status && asOf.status !== "unknown" && asOf.text
      ? `Authority at publication (${escapeHtml(asOf.as_of)}): the legally valid version beginning ${escapeHtml(asOf.clocks?.valid_from || "unknown")}.`
      : `Authority at publication is unknown. ${escapeHtml(asOf?.reason || reasonCopy(AUTHORITY_UNRESOLVED_REASONS.unresolved_version))}`;
    const basis = edge.possible_basis_change
      ? `<p class="rulemaking-authority-basis" data-authority-basis-change="possible">${escapeHtml(edge.possible_basis_change.copy)}</p>`
      : "";
    const source = edge.source_url
      ? `<a class="ui-official-source-link" href="${escapeHtml(edge.source_url)}" target="_blank" rel="noopener noreferrer">Source document<span aria-hidden="true">↗</span></a>`
      : "";
    return `<li class="rulemaking-authority-edge" data-authority-status="accepted" data-provision-id="${escapeHtml(edge.provision_id)}" data-corpus="${escapeHtml(edge.corpus_id)}">
      <a href="${escapeHtml(edge.href)}">Administrative Code ${escapeHtml(edge.citation)}</a>
      <p class="muted">${escapeHtml(versionCopy)}</p>
      ${basis}${source}
    </li>`;
  }).join("");
  const unresolvedMarkup = unresolved.map((row) =>
    `<li class="rulemaking-authority-unresolved" data-authority-status="unresolved" data-unresolved-reason="${escapeHtml(row.unresolved_reason)}">${escapeHtml(row.unresolved_copy)}</li>`,
  ).join("");
  return `<div class="rulemaking-authority" data-authority-accepted="${edges.length}" data-authority-unresolved="${unresolved.length}">
    ${acceptedMarkup ? `<ul class="rulemaking-authority-edges">${acceptedMarkup}</ul>` : ""}
    ${unresolvedMarkup ? `<ul class="rulemaking-authority-held">${unresolvedMarkup}</ul>` : ""}
  </div>`;
}

export function renderProvisionAuthorityCitations(rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return "";
  return `<ul class="admin-code-authority-citations">${items.map((row) => {
    const basis = row.possible_basis_change
      ? `<p class="code-change-formerly" data-authority-basis-change="possible">${escapeHtml(row.possible_basis_change.copy)}</p>`
      : "";
    return `<li data-rulemaking-id="${escapeHtml(row.from_ref)}"><a href="${escapeHtml(row.href)}">${escapeHtml(row.from_ref)}</a>${basis}</li>`;
  }).join("")}</ul>`;
}
