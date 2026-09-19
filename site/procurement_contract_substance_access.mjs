/**
 * Role-specific public access classification for contract-substance evidence.
 *
 * Distinguishes publicly retrievable documents from PASSPort Public metadata,
 * authenticated PASSPort contract tabs, bounded searches that locate nothing,
 * and failed fetches. A positive `public_document` label requires an accessible
 * public URL (or retained artifact with recorded redistribution authority) and
 * never admits a login destination, authenticated screenshot, analytics row,
 * project summary, notice description, or contract title.
 */

export const CONTRACT_SUBSTANCE_ACCESS_SCHEMA =
  "cityscroll.procurement_contract_substance_access.v1";

export const ACCESS_STATES = Object.freeze({
  PUBLIC_DOCUMENT: "public_document",
  METADATA_ONLY: "metadata_only",
  ACCOUNT_GATED: "account_gated",
  NOT_LOCATED: "not_located",
  FETCH_FAILED: "fetch_failed",
});

export const DOCUMENT_ROLES = Object.freeze({
  EXECUTED_CONTRACT: "executed_contract",
  STATEMENT_OF_WORK: "statement_of_work",
  PRICING_SCHEDULE: "pricing_schedule",
  SITE_SCHEDULE: "site_schedule",
  PERFORMANCE_EVALUATION: "performance_evaluation",
});

export const REQUIRED_DOCUMENT_ROLES = Object.freeze([
  DOCUMENT_ROLES.EXECUTED_CONTRACT,
  DOCUMENT_ROLES.STATEMENT_OF_WORK,
  DOCUMENT_ROLES.PRICING_SCHEDULE,
  DOCUMENT_ROLES.SITE_SCHEDULE,
  DOCUMENT_ROLES.PERFORMANCE_EVALUATION,
]);

/** Source classes kept distinct for admission and disclosure. */
export const SOURCE_CLASSES = Object.freeze({
  PASSPORT_PUBLIC_METADATA: "passport_public_metadata",
  PASSPORT_AUTHENTICATED_CONTRACT: "passport_authenticated_contract",
  PUBLIC_RETRIEVABLE_DOCUMENT: "public_retrievable_document",
});

export const FIXED_CONTRACT_IDS = Object.freeze([
  "CT107120258801626", // BHRAGS HOME CARE CORP
  "CT110220271400991", // S & P GLOBAL MARKET INTELLIGENCE LLC
  "CT105720278802113", // AMERICAN HEART ASSOCIATION INC
  "CT104020273009333", // QUIZIZZ INC
]);

export const ACCESS_SOURCE_COVERAGE = Object.freeze([
  Object.freeze({
    source_id: "checkbook-contracts",
    label: "Checkbook registered contracts",
    source_class: SOURCE_CLASSES.PUBLIC_RETRIEVABLE_DOCUMENT,
  }),
  Object.freeze({
    source_id: "city-record-awards",
    label: "City Record award notices",
    source_class: SOURCE_CLASSES.PUBLIC_RETRIEVABLE_DOCUMENT,
  }),
  Object.freeze({
    source_id: "passport-public",
    label: "PASSPort Public",
    source_class: SOURCE_CLASSES.PASSPORT_PUBLIC_METADATA,
  }),
  Object.freeze({
    source_id: "passport-authenticated-contract",
    label: "PASSPort authenticated contract record",
    source_class: SOURCE_CLASSES.PASSPORT_AUTHENTICATED_CONTRACT,
  }),
]);

const ACCESS_STATE_SET = new Set(Object.values(ACCESS_STATES));
const DOCUMENT_ROLE_SET = new Set(Object.values(DOCUMENT_ROLES));
const SOURCE_CLASS_SET = new Set(Object.values(SOURCE_CLASSES));
const SOURCE_ID_SET = new Set(ACCESS_SOURCE_COVERAGE.map((row) => row.source_id));

const DISQUALIFIED_DOCUMENT_ROLES = new Set([
  "metadata",
  "source_metadata",
  "analytics_row",
  "public_analytics_row",
  "project_summary",
  "project_description",
  "scope_summary",
  "notice_description",
  "contract_title",
  "title",
  "authenticated_screenshot",
  "screenshot",
]);

const CONTENT_HASH_RE = /^(sha256:)?[a-f0-9]{64}$/i;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value, max = 500) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function isoInstant(value) {
  if (!clean(value, 64) || !ISO_INSTANT_RE.test(String(value).trim())) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime());
}

function isoDate(value) {
  return Boolean(clean(value, 10) && ISO_DATE_RE.test(String(value).trim()));
}

function normalizeRole(value) {
  return clean(value, 80)?.toLowerCase().replace(/[\s-]+/g, "_") || null;
}

function normalizeSourceIds(value) {
  const list = Array.isArray(value) ? value : [];
  const ids = [];
  for (const entry of list) {
    const id = clean(entry, 120);
    if (id && SOURCE_ID_SET.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function isLoginOrSigninUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return true;
    if (/\/(?:login|signin)(?:[/?#]|$)/i.test(parsed.pathname)) return true;
    if (/[?&](?:ReturnUrl|returnUrl|return_url)=/i.test(parsed.search)) return true;
    // Authenticated PASSPort host is never a public document URL.
    if (/(^|\.)passport\.cityofnewyork\.us$/i.test(parsed.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

function publicDocumentRefusalReasons(candidate = {}) {
  const reasons = [];
  const role = normalizeRole(candidate.document_role || candidate.role);
  const sourceClass = clean(candidate.source_class, 80);
  const evidenceKind = normalizeRole(candidate.evidence_kind || candidate.kind);

  if (!clean(candidate.contract_id, 160)) reasons.push("missing_contract_identity");
  if (!clean(candidate.source_document_id || candidate.document_id, 180)) {
    reasons.push("missing_source_document_id");
  }
  if (!clean(candidate.public_url || candidate.url, 2000)) reasons.push("missing_public_url");
  if (!clean(candidate.content_hash, 100) || !CONTENT_HASH_RE.test(String(candidate.content_hash).trim())) {
    reasons.push("missing_or_invalid_content_hash");
  }
  const dated = candidate.publication_date || candidate.effective_date;
  if (!isoDate(dated)) reasons.push("missing_publication_or_effective_date");
  if (!clean(candidate.locator || candidate.page_section_locator, 240)) {
    reasons.push("missing_page_section_locator");
  }

  if (role && DISQUALIFIED_DOCUMENT_ROLES.has(role)) {
    reasons.push(`disqualified_document_role:${role}`);
  }
  if (evidenceKind && DISQUALIFIED_DOCUMENT_ROLES.has(evidenceKind)) {
    reasons.push(`disqualified_evidence_kind:${evidenceKind}`);
  }
  if (sourceClass === SOURCE_CLASSES.PASSPORT_PUBLIC_METADATA) {
    reasons.push("passport_public_metadata_cannot_be_public_document");
  }
  if (sourceClass === SOURCE_CLASSES.PASSPORT_AUTHENTICATED_CONTRACT) {
    reasons.push("authenticated_passport_cannot_be_public_document");
  }

  const url = clean(candidate.public_url || candidate.url, 2000);
  if (url && isLoginOrSigninUrl(url)) reasons.push("login_or_authenticated_url");

  if (candidate.authenticated_screenshot === true || candidate.screenshot === true) {
    reasons.push("authenticated_screenshot");
  }
  if (candidate.redistribution_authority === false) {
    reasons.push("no_redistribution_authority");
  }

  return reasons;
}

/**
 * Admit a candidate as a `public_document` access result, or return null with
 * refusal reasons. Login URLs, authenticated screenshots, PASSPort Public
 * metadata rows, project summaries, notice descriptions, and titles refuse.
 */
export function admitPublicDocument(candidate = {}) {
  const reasons = publicDocumentRefusalReasons(candidate);
  if (reasons.length) {
    return { ok: false, access_state: null, reasons, document: null };
  }
  const contractId = clean(candidate.contract_id, 160);
  const sourceDocumentId = clean(candidate.source_document_id || candidate.document_id, 180);
  const publicUrl = clean(candidate.public_url || candidate.url, 2000);
  const contentHash = clean(candidate.content_hash, 100).toLowerCase().replace(/^sha256:/, "");
  const publicationDate = clean(candidate.publication_date || candidate.effective_date, 10);
  const locator = clean(candidate.locator || candidate.page_section_locator, 240);
  return {
    ok: true,
    access_state: ACCESS_STATES.PUBLIC_DOCUMENT,
    reasons: [],
    document: {
      contract_id: contractId,
      source_document_id: sourceDocumentId,
      public_url: publicUrl,
      content_hash: `sha256:${contentHash}`,
      publication_date: publicationDate,
      effective_date: isoDate(candidate.effective_date) ? clean(candidate.effective_date, 10) : publicationDate,
      locator,
      redistribution_authority: candidate.redistribution_authority === true,
    },
  };
}

/**
 * Normalize one role-access observation. `public_document` must pass admission.
 * `account_gated` never records redistribution authority as true.
 * `fetch_failed` stays distinct from `not_located`.
 */
export function normalizeAccessObservation(raw = {}) {
  const contractId = clean(raw.contract_id || raw.prime_contract_id, 160);
  const documentRole = normalizeRole(raw.document_role || raw.role);
  const observedAt = clean(raw.observed_at, 64);
  const checkedSourceIds = normalizeSourceIds(raw.checked_source_ids || raw.checked_sources);
  const sourceClass = clean(raw.source_class, 80);
  let accessState = clean(raw.access_state || raw.state, 40);

  if (!contractId || !documentRole || !DOCUMENT_ROLE_SET.has(documentRole)) return null;
  if (!isoInstant(observedAt) || checkedSourceIds.length === 0) return null;
  if (sourceClass && !SOURCE_CLASS_SET.has(sourceClass)) return null;

  if (accessState === ACCESS_STATES.PUBLIC_DOCUMENT) {
    const admitted = admitPublicDocument({
      ...raw,
      contract_id: contractId,
      document_role: documentRole,
      source_class: sourceClass || SOURCE_CLASSES.PUBLIC_RETRIEVABLE_DOCUMENT,
    });
    if (!admitted.ok) return null;
    return {
      schema: CONTRACT_SUBSTANCE_ACCESS_SCHEMA,
      contract_id: contractId,
      document_role: documentRole,
      access_state: ACCESS_STATES.PUBLIC_DOCUMENT,
      observed_at: observedAt,
      checked_source_ids: checkedSourceIds,
      source_class: SOURCE_CLASSES.PUBLIC_RETRIEVABLE_DOCUMENT,
      redistribution_authority: admitted.document.redistribution_authority === true,
      document: admitted.document,
      absence_claim: null,
    };
  }

  if (!ACCESS_STATE_SET.has(accessState) || accessState === ACCESS_STATES.PUBLIC_DOCUMENT) {
    return null;
  }

  // Source-class hard bounds: metadata and authenticated classes cannot claim
  // a completed public-document search result.
  if (sourceClass === SOURCE_CLASSES.PASSPORT_PUBLIC_METADATA && accessState !== ACCESS_STATES.METADATA_ONLY) {
    accessState = ACCESS_STATES.METADATA_ONLY;
  }
  if (
    sourceClass === SOURCE_CLASSES.PASSPORT_AUTHENTICATED_CONTRACT
    && accessState !== ACCESS_STATES.ACCOUNT_GATED
    && accessState !== ACCESS_STATES.FETCH_FAILED
  ) {
    accessState = ACCESS_STATES.ACCOUNT_GATED;
  }

  return {
    schema: CONTRACT_SUBSTANCE_ACCESS_SCHEMA,
    contract_id: contractId,
    document_role: documentRole,
    access_state: accessState,
    observed_at: observedAt,
    checked_source_ids: checkedSourceIds,
    source_class: sourceClass || null,
    // Account access never implies redistribution authority.
    redistribution_authority: false,
    document: null,
    // Bounded absence: not_located never means "document does not exist".
    absence_claim: accessState === ACCESS_STATES.NOT_LOCATED
      ? "no_public_document_located_in_checked_sources"
      : accessState === ACCESS_STATES.FETCH_FAILED
        ? "fetch_failed_distinct_from_absence"
        : null,
  };
}

/**
 * Resident-facing distinction helpers. Fetch failure must never read as
 * "no document", and account-gated access never claims redistribution rights.
 */
export function accessStateDisclosure(observation) {
  const state = observation?.access_state;
  if (state === ACCESS_STATES.FETCH_FAILED) {
    return {
      access_state: state,
      implies_no_document: false,
      implies_redistribution_authority: false,
      reader_basis: "retrieval_failed",
    };
  }
  if (state === ACCESS_STATES.NOT_LOCATED) {
    return {
      access_state: state,
      implies_no_document: false,
      implies_redistribution_authority: false,
      reader_basis: "bounded_search_complete",
      checked_source_ids: Array.isArray(observation?.checked_source_ids)
        ? [...observation.checked_source_ids]
        : [],
      observed_at: observation?.observed_at || null,
    };
  }
  if (state === ACCESS_STATES.ACCOUNT_GATED) {
    return {
      access_state: state,
      implies_no_document: false,
      implies_redistribution_authority: false,
      reader_basis: "account_required",
    };
  }
  if (state === ACCESS_STATES.METADATA_ONLY) {
    return {
      access_state: state,
      implies_no_document: false,
      implies_redistribution_authority: false,
      reader_basis: "metadata_without_document",
    };
  }
  if (state === ACCESS_STATES.PUBLIC_DOCUMENT) {
    return {
      access_state: state,
      implies_no_document: false,
      implies_redistribution_authority: observation?.redistribution_authority === true,
      reader_basis: "public_document",
    };
  }
  return null;
}

export function indexAccessObservations(observations = []) {
  const byContract = new Map();
  for (const raw of Array.isArray(observations) ? observations : []) {
    const normalized = normalizeAccessObservation(raw);
    if (!normalized) continue;
    const roles = byContract.get(normalized.contract_id) || new Map();
    // First normalized observation for a role wins; callers should pre-order.
    if (!roles.has(normalized.document_role)) roles.set(normalized.document_role, normalized);
    byContract.set(normalized.contract_id, roles);
  }
  return byContract;
}

export function roleAccessForContract(observations, contractId, documentRole) {
  const indexed = observations instanceof Map
    ? observations
    : indexAccessObservations(observations);
  return indexed.get(clean(contractId, 160))?.get(normalizeRole(documentRole)) || null;
}

export function validateFixedContractAccessCoverage(document) {
  const errors = [];
  if (!isRecord(document) || document.schema !== CONTRACT_SUBSTANCE_ACCESS_SCHEMA) {
    return { ok: false, errors: ["document must use the contract-substance access schema"] };
  }
  const rows = Array.isArray(document.rows) ? document.rows : [];
  const indexed = indexAccessObservations(rows);
  for (const contractId of FIXED_CONTRACT_IDS) {
    const roles = indexed.get(contractId);
    if (!roles) {
      errors.push(`missing access rows for ${contractId}`);
      continue;
    }
    for (const role of REQUIRED_DOCUMENT_ROLES) {
      const observation = roles.get(role);
      if (!observation) {
        errors.push(`missing ${role} access for ${contractId}`);
        continue;
      }
      if (!ACCESS_STATE_SET.has(observation.access_state)) {
        errors.push(`invalid access_state for ${contractId}/${role}`);
      }
      if (!isoInstant(observation.observed_at)) {
        errors.push(`missing observed_at for ${contractId}/${role}`);
      }
      if (!Array.isArray(observation.checked_source_ids) || observation.checked_source_ids.length === 0) {
        errors.push(`missing checked_source_ids for ${contractId}/${role}`);
      }
      if (observation.access_state === ACCESS_STATES.PUBLIC_DOCUMENT) {
        const doc = observation.document;
        if (!doc?.contract_id || !doc?.source_document_id || !doc?.public_url
          || !doc?.content_hash || !doc?.publication_date || !doc?.locator) {
          errors.push(`public_document missing required identity fields for ${contractId}/${role}`);
        }
      }
      if (observation.access_state === ACCESS_STATES.ACCOUNT_GATED
        && observation.redistribution_authority === true) {
        errors.push(`account_gated must not claim redistribution authority for ${contractId}/${role}`);
      }
      if (observation.access_state === ACCESS_STATES.FETCH_FAILED) {
        const disclosure = accessStateDisclosure(observation);
        if (disclosure?.implies_no_document) {
          errors.push(`fetch_failed must not imply no document for ${contractId}/${role}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function buildContractSubstanceAccessDocument({
  rows = [],
  generatedAt = null,
  observationVintage = null,
} = {}) {
  const normalizedRows = [];
  for (const raw of rows) {
    const normalized = normalizeAccessObservation(raw);
    if (normalized) normalizedRows.push(normalized);
  }
  normalizedRows.sort((left, right) => (
    left.contract_id.localeCompare(right.contract_id)
    || left.document_role.localeCompare(right.document_role)
  ));
  return {
    schema: CONTRACT_SUBSTANCE_ACCESS_SCHEMA,
    generated_at: generatedAt,
    observation_vintage: observationVintage,
    source_coverage: ACCESS_SOURCE_COVERAGE.map((row) => ({ ...row })),
    absence_scope: "not_located means no qualifying public document was found in the named checked sources at observed_at. It does not establish that a document does not exist.",
    account_access_boundary: "account_gated records require publisher sign-in and never imply redistribution authority.",
    fetch_failure_boundary: "fetch_failed is distinct from not_located and must not render as an absence of a document.",
    rows: normalizedRows,
  };
}
