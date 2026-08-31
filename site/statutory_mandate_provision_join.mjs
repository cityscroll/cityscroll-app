/**
 * Evidence-qualified join from an existing statutory mandate to exact
 * Administrative Code provisions.
 *
 * This is a ledger edge over the current mandate identity. It does not mint a
 * second mandate, rewrite duty/deadline/agency, or treat RCNY/Charter/state
 * citations as Administrative Code.
 */

import { adminCodeHref, adminCodeProvisionId } from "./admin_code_search.mjs";
import { canonicalMandateId, mandateSubjectRef } from "./mandate_subject_ref.mjs";

export const STATUTORY_MANDATE_PROVISION_JOIN_SCHEMA =
  "cityscroll.statutory_mandate_provision_join.v1";
export const CREATES_MANDATE_EDGE_SCHEMA = "cityscroll.creates_mandate.v1";
export const CREATES_MANDATE_RELATION = "creates_mandate";
export const CREATED_BY_PROVISION_RELATION = "created_by_provision";
export const OBLIGATES_RELATION = "obligates";
export const JOIN_METHOD = "exact_statutory_citation_v1";
export const JOIN_METHOD_VERSION = 1;
export const ADMIN_CODE_CORPUS_ID = "nyc-administrative-code";
export const LEGAL_BASIS_MAY_HAVE_CHANGED_COPY =
  "The legal basis for this mandate may have changed.";

export const UNRESOLVED_REASONS = Object.freeze([
  "missing_citation",
  "malformed_citation",
  "ambiguous_citation",
  "rcny_not_administrative_code",
  "external_statute",
  "no_exact_section",
  "unsupported_citation",
  "provision_not_in_corpus",
  "missing_source_document",
]);

const SECTION_TOKEN = /(\d+[A-Za-z]?-\d+[A-Za-z0-9]*(?:\.\d+[A-Za-z0-9]*)*)/g;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, freeze(nested)]),
  ));
}

function clean(value, max = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function isoDate(value) {
  const match = clean(value, 40).match(ISO_DATE);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function hasMarker(text, pattern) {
  return pattern.test(text);
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Hyphenated title-section tokens, ignoring subsection parentheticals. */
export function extractAdminCodeSectionTokens(value) {
  const input = clean(value, 500);
  if (!input) return [];
  const tokens = [];
  for (const match of input.matchAll(SECTION_TOKEN)) {
    tokens.push(match[1].toLowerCase());
  }
  return unique(tokens);
}

function classifyDomain(citation) {
  const text = clean(citation, 500);
  if (!text) {
    return { domain: "missing", unresolved_reason: "missing_citation", sections: [] };
  }

  const rcny = hasMarker(text, /\b(?:rules\s+of\s+the\s+city\s+of\s+new\s+york|RCNY|NYCRR)\b/i);
  const adminCode = hasMarker(text, /\b(?:NYC\s+)?admin(?:istrative)?\s+code\b/i);
  const charter = hasMarker(text, /\b(?:new\s+york\s+city\s+)?charter\b/i);
  const construction = hasMarker(text, /\b(?:building|plumbing|mechanical|fuel\s+gas)\s+code\b/i);
  const external = hasMarker(text, /\b(?:U\.?S\.?C\.?|united\s+states\s+code|n\.?y\.?\s+state|state\s+of\s+new\s+york|public\s+health\s+law|education\s+law|labor\s+law|cplr)\b/i);
  const sections = extractAdminCodeSectionTokens(text);
  const orChoice = /\bor\b/i.test(text) && sections.length > 1;

  if (rcny && !adminCode) {
    return { domain: "rcny", unresolved_reason: "rcny_not_administrative_code", sections: [] };
  }
  if ((charter || construction || external) && !adminCode) {
    return { domain: "external", unresolved_reason: "external_statute", sections: [] };
  }
  if ((rcny && adminCode) || orChoice) {
    return { domain: "ambiguous", unresolved_reason: "ambiguous_citation", sections };
  }
  if (adminCode && !sections.length) {
    return { domain: "malformed", unresolved_reason: "malformed_citation", sections: [] };
  }
  if (!sections.length) {
    return { domain: "unsupported", unresolved_reason: "no_exact_section", sections: [] };
  }
  if (!adminCode && !sections.length) {
    return { domain: "unsupported", unresolved_reason: "unsupported_citation", sections: [] };
  }
  return { domain: "administrative_code", unresolved_reason: null, sections };
}

export function classifyMandateCitation(citation) {
  return freeze(classifyDomain(citation));
}

function lookupFromOption(section, lookupProvision) {
  if (typeof lookupProvision === "function") {
    return lookupProvision(section) || lookupProvision(`§ ${section}`) || null;
  }
  if (lookupProvision && typeof lookupProvision === "object") {
    return lookupProvision[`§ ${section}`]
      || lookupProvision[section]
      || lookupProvision[`${ADMIN_CODE_CORPUS_ID}:${section}`]
      || null;
  }
  return null;
}

function resolvedProvision(section, lookupProvision) {
  const hit = lookupFromOption(section, lookupProvision);
  if (!hit) return null;
  const id = hit.id || hit.provision_id || adminCodeProvisionId(section);
  if (!id) return null;
  const citation = hit.citation || `§ ${section}`;
  return {
    id,
    citation,
    href: hit.href || adminCodeHref(section),
    shard: hit.shard || null,
    content_hash: hit.content_hash || hit.source?.content_hash || null,
    source_ref: hit.source_ref || hit.source?.source_ref || null,
  };
}

function sourceEnvelope(mandate = {}, extra = {}) {
  const source = mandate.source && typeof mandate.source === "object" ? mandate.source : {};
  const document = clean(
    extra.source_document
      || mandate.source_href
      || source.law_text_url
      || source.legistar_url
      || mandate.law_text_url
      || mandate.legistar_url,
    1_000,
  ) || null;
  const record = clean(
    extra.source_record
      || source.matter_id
      || mandate.matter_id
      || source.document_id
      || mandate.source_record,
    240,
  ) || null;
  const observedAt = isoDate(
    extra.observed_at
      || source.observed_at
      || mandate.observed_at
      || mandate.effective_date
      || mandate.enactment_date
      || extra.as_of,
  );
  return {
    document,
    record,
    citation: clean(mandate.citation || source.citation, 240) || null,
    fields: freeze({
      citation: clean(mandate.citation || source.citation, 240) || null,
      matter_id: clean(source.matter_id || mandate.matter_id, 80) || null,
      law_text_url: clean(source.law_text_url || mandate.law_text_url, 1_000) || null,
      legistar_url: clean(source.legistar_url || mandate.source_href, 1_000) || null,
    }),
    observed_at: observedAt,
  };
}

function laterLegalChange(provisionId, { changes = [], versions = [] } = {}, clock) {
  const relatedChanges = (Array.isArray(changes) ? changes : []).filter((change) => (
    change?.target?.provision_id === provisionId
    || change?.redesignation?.successor_provision_id === provisionId
  ));
  const relatedVersions = (Array.isArray(versions) ? versions : []).filter((version) => (
    version?.provision_id === provisionId
  ));
  if (!relatedChanges.length && !relatedVersions.length) {
    return { status: "none", copy: null, change_ids: [] };
  }
  if (!clock) {
    return { status: "unknown", copy: null, change_ids: relatedChanges.map((change) => change.id).filter(Boolean) };
  }
  const laterChanges = relatedChanges.filter((change) => {
    const at = isoDate(change.effective_at || change.materialization?.effective_at);
    return at && at > clock && change.materialization_status !== "unresolved";
  });
  const laterVersions = relatedVersions.filter((version) => {
    const from = isoDate(version.valid_from);
    return from && from > clock;
  });
  if (laterChanges.length || laterVersions.length) {
    return {
      status: "possible",
      copy: LEGAL_BASIS_MAY_HAVE_CHANGED_COPY,
      change_ids: laterChanges.map((change) => change.id).filter(Boolean),
    };
  }
  const unresolvedLater = relatedChanges.filter((change) => {
    const at = isoDate(change.effective_at || change.materialization?.effective_at);
    return at && at > clock && change.materialization_status === "unresolved";
  });
  if (unresolvedLater.length) {
    return { status: "unknown", copy: null, change_ids: unresolvedLater.map((change) => change.id).filter(Boolean) };
  }
  return { status: "none", copy: null, change_ids: [] };
}

function obligatesEdge(mandate, mandateId) {
  const agencyId = clean(mandate.agency_id, 120);
  const agencyName = clean(mandate.agency_name, 200);
  if (!agencyId) {
    return freeze({
      relation: OBLIGATES_RELATION,
      from: mandateSubjectRef(mandateId),
      to: null,
      href: null,
      agency_id: null,
      agency_name: agencyName || null,
      status: "unresolved",
      unresolved_reason: "missing_agency",
    });
  }
  return freeze({
    relation: OBLIGATES_RELATION,
    from: mandateSubjectRef(mandateId),
    to: `agency:id:${agencyId}`,
    href: `/agencies/${encodeURIComponent(agencyId)}/`,
    agency_id: agencyId,
    agency_name: agencyName || null,
    status: "accepted",
    unresolved_reason: null,
  });
}

function unresolvedJoin({
  mandateId,
  citation,
  source,
  reason,
  domain,
  classified,
  extra = {},
}) {
  return freeze({
    schema: STATUTORY_MANDATE_PROVISION_JOIN_SCHEMA,
    mandate_id: mandateId,
    mandate_ref: mandateSubjectRef(mandateId),
    citation,
    source,
    method: JOIN_METHOD,
    method_version: JOIN_METHOD_VERSION,
    corpus_id: domain === "rcny" ? "nyc-rcny" : domain === "administrative_code" ? ADMIN_CODE_CORPUS_ID : null,
    corpus_boundary: domain,
    status: reason === "ambiguous_citation" ? "unresolved" : (reason === "rcny_not_administrative_code" ? "held" : "unresolved"),
    unresolved_reason: reason,
    classified,
    edges: [],
    reciprocal: [],
    obligates: extra.obligates || null,
    legal_basis_change: { status: "none", copy: null, change_ids: [] },
    mandate_fields: extra.mandate_fields || null,
  });
}

/**
 * Join one existing mandate row to zero or more exact CodeProvisions.
 * Never returns a new mandate identity or rewritten duty/deadline/agency.
 */
export function joinMandateToProvisions(mandate = {}, options = {}) {
  const mandateId = canonicalMandateId(
    mandate.mandate_id || mandate.obligation_id || mandate.id || mandate.subject_ref,
  );
  const citation = clean(mandate.citation || mandate.source?.citation, 240) || null;
  const source = sourceEnvelope(mandate, options);
  const classified = classifyMandateCitation(citation);
  const mandateFields = freeze({
    duty_text: clean(mandate.duty_text || mandate.required_action, 700) || null,
    deadline: mandate.deadline && typeof mandate.deadline === "object"
      ? {
        kind: clean(mandate.deadline.kind, 80) || null,
        computed_date: isoDate(mandate.deadline.computed_date) || isoDate(mandate.deadline_date),
        text: clean(mandate.deadline.text || mandate.deadline_text, 300) || null,
      }
      : {
        kind: null,
        computed_date: isoDate(mandate.deadline_date),
        text: clean(mandate.deadline_text, 300) || null,
      },
    agency_id: clean(mandate.agency_id, 120) || null,
    agency_name: clean(mandate.agency_name, 200) || null,
    recurrence: clean(mandate.recurrence, 80) || null,
  });
  const obligates = mandateId ? obligatesEdge(mandate, mandateId) : null;

  if (!mandateId) {
    return unresolvedJoin({
      mandateId: null,
      citation,
      source,
      reason: "unsupported_citation",
      domain: classified.domain,
      classified,
      extra: { obligates, mandate_fields: mandateFields },
    });
  }
  if (classified.unresolved_reason && classified.domain !== "administrative_code") {
    return unresolvedJoin({
      mandateId,
      citation,
      source,
      reason: classified.unresolved_reason,
      domain: classified.domain,
      classified,
      extra: { obligates, mandate_fields: mandateFields },
    });
  }
  if (!source.document || !source.record) {
    return unresolvedJoin({
      mandateId,
      citation,
      source,
      reason: "missing_source_document",
      domain: classified.domain,
      classified,
      extra: { obligates, mandate_fields: mandateFields },
    });
  }

  const sections = classified.sections || [];
  const resolved = [];
  const missing = [];
  for (const section of sections) {
    const provision = resolvedProvision(section, options.lookupProvision);
    if (!provision) missing.push(section);
    else resolved.push({ section, provision });
  }
  if (!resolved.length) {
    return unresolvedJoin({
      mandateId,
      citation,
      source,
      reason: missing.length ? "provision_not_in_corpus" : (classified.unresolved_reason || "malformed_citation"),
      domain: classified.domain,
      classified,
      extra: { obligates, mandate_fields: mandateFields },
    });
  }
  if (missing.length) {
    return unresolvedJoin({
      mandateId,
      citation,
      source,
      reason: "ambiguous_citation",
      domain: classified.domain,
      classified,
      extra: { obligates, mandate_fields: mandateFields },
    });
  }

  const clock = source.observed_at;
  const edges = resolved.map(({ section, provision }) => {
    const basis = laterLegalChange(provision.id, options, clock);
    return freeze({
      schema: CREATES_MANDATE_EDGE_SCHEMA,
      relation: CREATES_MANDATE_RELATION,
      inverse: CREATED_BY_PROVISION_RELATION,
      status: "accepted",
      from: provision.id,
      to: mandateSubjectRef(mandateId),
      provision_id: provision.id,
      provision_citation: provision.citation,
      provision_href: provision.href,
      section,
      citation_span: citation,
      source_document: source.document,
      source_record: source.record,
      source_fields: source.fields,
      observed_at: source.observed_at,
      content_hash: provision.content_hash,
      source_ref: provision.source_ref,
      method: JOIN_METHOD,
      method_version: JOIN_METHOD_VERSION,
      corpus_id: ADMIN_CODE_CORPUS_ID,
      unresolved_reason: null,
      legal_basis_change: basis,
    });
  });
  const possible = edges.find((edge) => edge.legal_basis_change.status === "possible");
  const unknown = edges.find((edge) => edge.legal_basis_change.status === "unknown");
  const legalBasisChange = possible
    ? possible.legal_basis_change
    : unknown
      ? unknown.legal_basis_change
      : { status: "none", copy: null, change_ids: [] };

  return freeze({
    schema: STATUTORY_MANDATE_PROVISION_JOIN_SCHEMA,
    mandate_id: mandateId,
    mandate_ref: mandateSubjectRef(mandateId),
    citation,
    source,
    method: JOIN_METHOD,
    method_version: JOIN_METHOD_VERSION,
    corpus_id: ADMIN_CODE_CORPUS_ID,
    corpus_boundary: "administrative_code",
    status: "accepted",
    unresolved_reason: null,
    classified,
    edges,
    reciprocal: edges.map((edge) => freeze({
      relation: CREATED_BY_PROVISION_RELATION,
      from: edge.to,
      to: edge.from,
      href: edge.provision_href,
      provision_id: edge.provision_id,
      mandate_id: mandateId,
    })),
    obligates,
    legal_basis_change: legalBasisChange,
    mandate_fields: mandateFields,
  });
}

export function joinsForProvision(provisionId, mandates = [], options = {}) {
  const id = clean(provisionId, 240);
  const out = [];
  for (const mandate of Array.isArray(mandates) ? mandates : []) {
    const join = joinMandateToProvisions(mandate, options);
    const hits = (join.edges || []).filter((edge) => edge.provision_id === id && edge.status === "accepted");
    if (!hits.length) continue;
    out.push(freeze({
      ...join,
      edges: hits,
      reciprocal: (join.reciprocal || []).filter((edge) => edge.to === id),
    }));
  }
  return freeze(out);
}

export function mandateRowsFromLookup(lookup) {
  if (!lookup || typeof lookup !== "object") return [];
  return Object.values(lookup.by_agency || {}).flatMap((bucket) => (
    Array.isArray(bucket?.obligations) ? bucket.obligations : []
  ));
}

function unresolvedCopy(reason) {
  switch (reason) {
    case "rcny_not_administrative_code":
      return "This citation is a city rule, not an Administrative Code provision.";
    case "external_statute":
      return "This citation is not an Administrative Code provision.";
    case "ambiguous_citation":
      return "This citation does not identify one Administrative Code provision.";
    case "malformed_citation":
    case "no_exact_section":
    case "unsupported_citation":
      return "This citation does not identify an exact Administrative Code section.";
    case "provision_not_in_corpus":
      return "This Administrative Code citation is not in the current provision corpus.";
    case "missing_source_document":
      return "The source law record for this citation is missing.";
    case "missing_citation":
      return "No statutory citation is recorded for this mandate.";
    default:
      return "This citation does not resolve to an Administrative Code provision.";
  }
}

/** Mandate-page HTML: exact provision links, or a visible unresolved state. */
export function renderMandateProvisionJoin(join) {
  if (!join?.schema) return "";
  const basis = join.legal_basis_change?.status === "possible" && join.legal_basis_change.copy
    ? `<p data-legal-basis-change="possible">${esc(join.legal_basis_change.copy)}</p>`
    : "";
  const accepted = (join.edges || []).filter((edge) => edge.status === "accepted" && edge.provision_href);
  if (accepted.length) {
    const items = accepted.map((edge) => (
      `<li data-creates-mandate-from="${esc(edge.provision_id)}"><a href="${esc(edge.provision_href)}" data-target-kind="legal-code">Administrative Code ${esc(edge.provision_citation)}</a></li>`
    )).join("");
    return `<section class="node-section civic-object-section mandate-legal-basis" data-provision-join="accepted" data-provision-join-count="${accepted.length}"><h2>Legal provision</h2><ul>${items}</ul>${basis}</section>`;
  }
  if (!join.unresolved_reason) return basis;
  return `<section class="node-section civic-object-section mandate-legal-basis" data-provision-join="${esc(join.status || "unresolved")}" data-unresolved-reason="${esc(join.unresolved_reason)}"><h2>Legal provision</h2><p>${esc(unresolvedCopy(join.unresolved_reason))}</p>${basis}</section>`;
}

/** Provision-page HTML: reciprocal mandate links. Empty when none. */
export function renderProvisionMandateJoins(joins = []) {
  const accepted = (Array.isArray(joins) ? joins : []).filter((join) => (
    join?.status === "accepted" && join.mandate_id
  ));
  if (!accepted.length) return "";
  const items = accepted.map((join) => {
    const href = `/mandates/${encodeURIComponent(join.mandate_id)}/`;
    const label = join.mandate_fields?.duty_text || `Mandate ${join.mandate_id}`;
    const basis = join.legal_basis_change?.status === "possible" && join.legal_basis_change.copy
      ? ` <span data-legal-basis-change="possible">${esc(join.legal_basis_change.copy)}</span>`
      : "";
    return `<li data-creates-mandate="${esc(join.mandate_ref)}"><a href="${esc(href)}" data-target-kind="mandate">${esc(label)}</a>${basis}</li>`;
  }).join("");
  return `<section class="history mandate-joins" aria-labelledby="created-mandates" data-provision-join="accepted" data-provision-join-count="${accepted.length}"><h3 id="created-mandates">Mandates this provision creates</h3><ul>${items}</ul></section>`;
}
