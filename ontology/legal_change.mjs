/** Source-preserving identities and relations for explicit legislative code changes. */

export const CODE_CHANGE_SCHEMA = "cityscroll.code_change.v1";
export const LOCAL_LAW_SCHEMA = "cityscroll.local_law.v1";
export const LEGAL_CHANGE_GRAPH_SCHEMA = "cityscroll.legal_change_graph.v1";

export const CODE_CHANGE_OPERATIONS = Object.freeze([
  "add", "amend", "repeal", "redesignate", "rename",
]);

export const LEGAL_CHANGE_RELATIONS = Object.freeze([
  "enacted_as", "contains", "targets", "changes", "proposes_change_to",
]);

const OPERATION_SET = new Set(CODE_CHANGE_OPERATIONS);
const CORPUS_ID = /^[a-z0-9][a-z0-9._:-]{0,119}$/;

function clean(value, max = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function text(value, max = 2_000) {
  const result = clean(value, max);
  return result || null;
}

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, immutable(nested)])));
}

function sourceEvidence(value = {}) {
  const instructionText = text(value.instruction_text || value.quote || value.excerpt, 8_000);
  const sourceRef = text(value.source_ref || value.document_id || value.id, 500);
  const url = text(value.url || value.source_url, 2_000);
  if (!instructionText || (!sourceRef && !url)) {
    throw new TypeError("CodeChange requires source-stated instruction text and a source reference or URL");
  }
  return immutable({
    instruction_text: instructionText,
    source_ref: sourceRef,
    url,
    source_system: text(value.source_system || value.system, 160),
    observed_at: text(value.observed_at, 80),
    document_id: text(value.document_id, 240),
    locator: text(value.locator || value.location, 240),
    start: Number.isInteger(value.start) && value.start >= 0 ? value.start : null,
    end: Number.isInteger(value.end) && value.end >= 0 ? value.end : null,
  });
}

function canonicalTarget(value = {}) {
  const target = typeof value === "string" ? { id: value } : value;
  const corpusId = text(target.corpus_id || target.corpus, 120);
  const citation = text(target.citation || target.section, 240);
  const id = text(target.id || target.provision_id, 320);
  if (!corpusId || !CORPUS_ID.test(corpusId)) {
    throw new TypeError("CodeChange target requires a corpus_id");
  }
  if (!citation && !id) throw new TypeError("CodeChange target requires a citation or stable id");
  return immutable({
    corpus_id: corpusId,
    citation,
    provision_id: id,
    resolution: text(target.resolution || target.resolution_status, 80) || "unknown",
    heading: text(target.heading, 500),
  });
}

export function normalizeCodeChangeOperation(value) {
  const operation = clean(value, 40).toLowerCase().replace(/[ _-]+/g, "_");
  const normalized = operation === "re_designate" ? "redesignate" : operation;
  return OPERATION_SET.has(normalized) ? normalized : null;
}

export function localLaw(value = {}) {
  const id = text(value.id || value.legal_instrument_id, 240);
  const matterId = text(value.matter_id || value.matter_ref, 240);
  const lawNumber = text(value.local_law_number || value.law_number, 120);
  if (!id || !matterId || !lawNumber) {
    throw new TypeError("LocalLaw requires distinct id, matter_id, and local_law_number");
  }
  return immutable({
    schema: LOCAL_LAW_SCHEMA,
    id,
    matter_id: matterId,
    local_law_number: lawNumber,
    title: text(value.title, 500),
    introduced_at: text(value.introduced_at, 40),
    passed_at: text(value.passed_at, 40),
    signed_at: text(value.signed_at, 40),
    enacted_at: text(value.enacted_at, 40),
    effective_at: text(value.effective_at, 40),
    effective_date_text: text(value.effective_date_text, 2_000),
    source: value.source ? sourceEvidence({ ...value.source, instruction_text: value.source.instruction_text || value.title || lawNumber }) : null,
  });
}

export function codeChange(value = {}) {
  const operation = normalizeCodeChangeOperation(value.operation);
  const target = canonicalTarget(value.target || {
    corpus_id: value.corpus_id,
    citation: value.target_citation,
    id: value.target_provision_id,
  });
  const instrumentId = text(value.legal_instrument_id || value.local_law_id, 240);
  const matterId = text(value.matter_id || value.matter_ref, 240);
  if (!operation) throw new TypeError(`Unsupported explicit CodeChange operation: ${value.operation}`);
  if (!instrumentId && !matterId) throw new TypeError("CodeChange requires a matter or legal instrument identity");
  const evidence = sourceEvidence(value.source || value);
  const id = text(value.id, 320) || `${instrumentId || matterId}:${operation}:${target.provision_id || `${target.corpus_id}:${target.citation}`}:${evidence.start ?? "source"}`;
  return immutable({
    schema: CODE_CHANGE_SCHEMA,
    id,
    operation,
    matter_id: matterId,
    legal_instrument_id: instrumentId,
    state: text(value.state, 40) || (instrumentId ? "enacted" : "prospective"),
    effective_at: text(value.effective_at, 40),
    effective_date_text: text(value.effective_date_text, 2_000),
    target,
    source: evidence,
    change_basis: "source_stated",
    materialization_status: text(value.materialization_status, 40) || "unresolved",
    materialization_confidence: text(value.materialization_confidence, 40) || "unknown",
  });
}

export function legalChangeGraph({ matter = null, local_law: lawInput = null, changes = [] } = {}) {
  const matterId = text(matter?.id || matter?.matter_id || matter?.ref, 240);
  const law = lawInput ? localLaw(lawInput) : null;
  if (!matterId && !law) throw new TypeError("Legal change graph requires a matter or LocalLaw");
  const normalizedChanges = changes.map((change) => codeChange({
    ...change,
    matter_id: change.matter_id || matterId,
    legal_instrument_id: change.legal_instrument_id || law?.id,
    state: change.state || (law ? "enacted" : "prospective"),
  }));
  const edges = [];
  if (law) {
    edges.push({ relation: "enacted_as", from_ref: matterId || law.matter_id, to_ref: law.id, state: "enacted" });
    for (const change of normalizedChanges) {
      edges.push({ relation: "contains", from_ref: law.id, to_ref: change.id, state: "enacted" });
      edges.push({ relation: "targets", from_ref: change.id, to_ref: change.target.provision_id || null, target: change.target, state: "enacted" });
    }
  } else {
    for (const change of normalizedChanges) {
      edges.push({ relation: "proposes_change_to", from_ref: matterId, to_ref: change.target.provision_id || null, target: change.target, state: "prospective" });
    }
  }
  return immutable({
    schema: LEGAL_CHANGE_GRAPH_SCHEMA,
    matter: matter ? immutable({ ...matter, id: matterId }) : null,
    local_law: law,
    changes: normalizedChanges,
    edges,
  });
}

export function isProspectiveCodeChange(change) {
  return change?.state === "prospective" || (!change?.legal_instrument_id && Boolean(change?.matter_id));
}
