/**
 * Pure frozen research-package projection over the existing Investigation union.
 *
 * The package carries admitted claims and compact references only. It never copies a
 * source dataset, runs a comparison, or authors a thesis. `/inv` supplies storage,
 * TTL, rate limiting, and immutable version identifiers.
 */

import {
  INVESTIGATION_SIGNAL_TYPE,
  normalizeInvestigationComparativeSignal,
} from "./investigation_comparative_signal.mjs";

export const RESEARCH_PACKAGE_REQUEST_SCHEMA = "cityscroll.research_package_request.v1";
export const RESEARCH_PACKAGE_SCHEMA = "cityscroll.research_package.v1";
export const RESEARCH_PACKAGE_EXPORT_SCHEMA = "cityscroll.research_package_export.v1";
export const RESEARCH_PACKAGE_FRESHNESS_SCHEMA = "cityscroll.research_package_freshness.v1";
export const MAX_RESEARCH_PACKAGE_BYTES = 32768;
export const MAX_RESEARCH_PACKAGE_OBSERVATIONS = 25;

const RESEARCH_PACKAGE_STORY_SIGNAL_SCHEMA = "cityscroll.story_signal.v1";
const RESEARCH_PACKAGE_METHOD_DESCRIPTION = "Claims were admitted before packaging by deterministic comparison receipts. The package keeps compact references and receipts and does not copy source datasets.";
const RESEARCH_PACKAGE_CHANGE_KINDS = new Set([
  "created",
  "claim_added",
  "claim_removed",
  "data_refreshed",
  "evidence_updated",
  "method_updated",
  "question_updated",
  "other",
]);

function freezeResearchPackageValue(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeResearchPackageValue(child);
  return Object.freeze(value);
}

function researchPackageText(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function researchPackageNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function researchPackagePositiveInteger(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function researchPackageInstant(value) {
  const result = researchPackageText(value, 40);
  return result && Number.isFinite(Date.parse(result)) ? new Date(result).toISOString() : null;
}

function researchPackageLocalHref(value) {
  const href = researchPackageText(value, 500);
  return href.startsWith("/") && !href.startsWith("//") ? href : null;
}

function researchPackageHttpsHref(value) {
  const href = researchPackageText(value, 500);
  try {
    const parsed = new URL(href);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function researchPackageSha256(value) {
  const hash = researchPackageText(value, 64).toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

function researchPackageIdentifier(value, max = 500) {
  const result = researchPackageText(value, max);
  return result && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result) ? result : null;
}

function researchPackageByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalResearchPackageValue(value) {
  if (Array.isArray(value)) return value.map(canonicalResearchPackageValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalResearchPackageValue(value[key])]),
  );
}

function normalizeResearchPackageObjectRef(value) {
  const type = researchPackageIdentifier(value?.type, 80);
  const id = researchPackageIdentifier(value?.id, 160);
  const ref = researchPackageIdentifier(value?.ref, 240);
  const label = researchPackageText(value?.label, 300);
  const href = researchPackageLocalHref(value?.href);
  return type && id && ref && label && href ? { type, id, ref, label, href } : null;
}

function normalizeResearchPackageEvidence(value) {
  const kind = researchPackageIdentifier(value?.kind, 80);
  const sourceContractId = researchPackageIdentifier(value?.source_contract_id, 160);
  const sourceRowId = researchPackageIdentifier(value?.source_row_id, 200);
  const href = researchPackageHttpsHref(value?.href);
  if (!kind || !sourceContractId || !sourceRowId || !href) return null;
  const result = {
    kind,
    source_contract_id: sourceContractId,
    source_row_id: sourceRowId,
    href,
  };
  const contentHash = researchPackageSha256(value?.source_vault_sha256);
  const vaultRef = researchPackageLocalHref(value?.source_vault_ref);
  if (contentHash && vaultRef === `/source-vault/${contentHash}`) {
    result.source_vault_sha256 = contentHash;
    result.source_vault_ref = vaultRef;
  }
  return result;
}

function normalizeResearchPackageVintage(value) {
  const sourceContractId = researchPackageIdentifier(value?.source_contract_id, 160);
  const datasetId = researchPackageIdentifier(value?.dataset_id, 160);
  const materializedAt = researchPackageInstant(value?.materialized_at);
  if (!sourceContractId || !datasetId || !materializedAt) return null;
  return {
    source_contract_id: sourceContractId,
    source_contract_schema_version: researchPackageNonnegativeInteger(value?.source_contract_schema_version),
    dataset_id: datasetId,
    materialized_at: materializedAt,
    row_count: researchPackageNonnegativeInteger(value?.row_count),
  };
}

function normalizeResearchPackageComparison(value) {
  const objectType = researchPackageIdentifier(value?.population?.object_type, 80);
  const sourceFamily = researchPackageIdentifier(value?.population?.source_family, 160);
  const eligibleCount = researchPackageNonnegativeInteger(value?.eligible_count);
  const observedCount = researchPackageNonnegativeInteger(value?.observed_count);
  const rank = researchPackagePositiveInteger(value?.rank);
  const start = researchPackageText(value?.window?.start, 10);
  const end = researchPackageText(value?.window?.end, 10);
  if (
    !objectType
    || !sourceFamily
    || eligibleCount == null
    || observedCount == null
    || rank == null
    || !/^\d{4}-\d{2}-\d{2}$/.test(start)
    || !/^\d{4}-\d{2}-\d{2}$/.test(end)
  ) return null;
  return {
    population: {
      object_type: objectType,
      source_family: sourceFamily,
      agency_id: researchPackageIdentifier(value?.population?.agency_id, 160),
      agency_name: researchPackageText(value?.population?.agency_name, 200) || null,
    },
    eligible_count: eligibleCount,
    observed_count: observedCount,
    window: { start, end, end_inclusive: value?.window?.end_inclusive === true },
    rank,
  };
}

function normalizeResearchPackageReceipt(value) {
  const receiptId = researchPackageIdentifier(value?.receipt_id, 500);
  const metricMethod = researchPackageIdentifier(value?.metric_method, 160);
  const classId = researchPackageIdentifier(value?.peer_basis?.class_id, 500);
  const generatedAt = researchPackageInstant(value?.generated_at);
  const vintages = Array.isArray(value?.peer_basis?.source_vintages)
    ? value.peer_basis.source_vintages.slice(0, 12).map(normalizeResearchPackageVintage).filter(Boolean)
    : [];
  const contractVersions = Array.isArray(value?.peer_basis?.source_contract_versions)
    ? value.peer_basis.source_contract_versions.slice(0, 12).map((item) => researchPackageText(item, 200)).filter(Boolean)
    : [];
  if (
    value?.schema !== "cityscroll.comparative_fact_reference.v1"
    || value?.receipt_schema !== "cityscroll.comparative_fact.v1"
    || !receiptId
    || !metricMethod
    || !classId
    || !generatedAt
    || !vintages.length
    || !contractVersions.length
  ) return null;
  return {
    schema: "cityscroll.comparative_fact_reference.v1",
    receipt_schema: "cityscroll.comparative_fact.v1",
    receipt_id: receiptId,
    metric_method: metricMethod,
    peer_basis: {
      class_id: classId,
      observability_basis: researchPackageText(value.peer_basis.observability_basis, 80),
      source_contract_versions: contractVersions,
      source_vintages: vintages,
      inclusion_rule: researchPackageText(value.peer_basis.inclusion_rule, 1000),
      identity_gate: researchPackageText(value.peer_basis.identity_gate, 300),
      observation_quality_class: researchPackageText(value.peer_basis.observation_quality_class, 200),
      censoring_class: researchPackageText(value.peer_basis.censoring_class, 200),
      selected_level: researchPackageText(value.peer_basis.selected_level, 160),
      small_n_policy_id: researchPackageText(value.peer_basis.small_n_policy_id, 160),
    },
    generated_at: generatedAt,
  };
}

function normalizeResearchPackageObservation(value) {
  const observationId = researchPackageIdentifier(value?.observation_id, 500);
  const exactClaim = researchPackageText(value?.exact_claim, 1000);
  const comparisonBasis = normalizeResearchPackageComparison(value?.comparison_basis);
  const receipt = normalizeResearchPackageReceipt(value?.comparison_receipt);
  const objects = Array.isArray(value?.objects)
    ? value.objects.slice(0, 12).map(normalizeResearchPackageObjectRef).filter(Boolean)
    : [];
  const evidence = Array.isArray(value?.official_evidence)
    ? value.official_evidence.slice(0, 12).map(normalizeResearchPackageEvidence).filter(Boolean)
    : [];
  const vintages = Array.isArray(value?.snapshot_vintages)
    ? value.snapshot_vintages.slice(0, 12).map(normalizeResearchPackageVintage).filter(Boolean)
    : [];
  if (
    !observationId
    || !exactClaim
    || !comparisonBasis
    || !receipt
    || !objects.length
    || !evidence.length
    || !vintages.length
    || observationId !== `story_signal:${receipt.receipt_id}`
    || !evidence.some((item) => item.source_row_id === objects[0].id)
    || JSON.stringify(vintages) !== JSON.stringify(receipt.peer_basis.source_vintages)
  ) return null;
  return {
    observation_id: observationId,
    exact_claim: exactClaim,
    comparison_basis: comparisonBasis,
    objects,
    official_evidence: evidence,
    comparison_receipt: receipt,
    snapshot_vintages: vintages,
  };
}

function normalizeResearchPackageChanges(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).map((item) => {
    const kind = researchPackageText(item?.kind, 40);
    const summary = researchPackageText(item?.summary, 500);
    return RESEARCH_PACKAGE_CHANGE_KINDS.has(kind) && summary ? { kind, summary } : null;
  }).filter(Boolean);
}

function deriveResearchPackageMetadata(observations) {
  const contractVersions = new Set();
  const methods = new Map();
  for (const observation of observations) {
    const receipt = observation.comparison_receipt;
    for (const reference of receipt.peer_basis.source_contract_versions) contractVersions.add(reference);
    methods.set(receipt.metric_method, {
      method_id: receipt.metric_method,
      receipt_schema: receipt.receipt_schema,
    });
  }
  methods.set("comparative_signal_admission_v1", {
    method_id: "comparative_signal_admission_v1",
    receipt_schema: "cityscroll.comparative_signal_admission.v1",
  });
  return {
    methods: {
      description: RESEARCH_PACKAGE_METHOD_DESCRIPTION,
      items: [...methods.values()].sort((a, b) => a.method_id.localeCompare(b.method_id)),
    },
    source_contracts: [...contractVersions].sort().map((reference) => ({ reference })),
  };
}

/** Validate the explicit package request discriminator accepted by POST /inv. */
export function normalizeResearchPackageRequest(value) {
  if (
    value?.schema !== RESEARCH_PACKAGE_REQUEST_SCHEMA
    || value?.discriminator !== "research_package"
  ) return null;
  const title = researchPackageText(value?.title, 160);
  const question = researchPackageText(value?.question, 500);
  const observations = Array.isArray(value?.observations)
    ? value.observations.slice(0, MAX_RESEARCH_PACKAGE_OBSERVATIONS).map(normalizeResearchPackageObservation).filter(Boolean)
    : [];
  if (!title || !question || !observations.length || observations.length !== value.observations.length) return null;
  const changes = normalizeResearchPackageChanges(value?.changes);
  if (Array.isArray(value?.changes) && changes.length !== value.changes.length) return null;
  const supersedesVersionId = researchPackageIdentifier(value?.supersedes?.version_id, 80);
  const metadata = deriveResearchPackageMetadata(observations);
  const normalized = {
    schema: RESEARCH_PACKAGE_REQUEST_SCHEMA,
    discriminator: "research_package",
    title,
    question,
    observations,
    methods: metadata.methods,
    source_contracts: metadata.source_contracts,
    supersedes: supersedesVersionId ? { version_id: supersedesVersionId } : null,
    changes,
  };
  return researchPackageByteLength(JSON.stringify(normalized)) <= MAX_RESEARCH_PACKAGE_BYTES ? freezeResearchPackageValue(normalized) : null;
}

/** Project the admitted comparative-signal members of one Investigation. */
export function researchPackageRequestFromInvestigation(investigation, {
  title = "",
  question = "",
  supersedes = null,
  changes = [],
} = {}) {
  if (!investigation || !Array.isArray(investigation.items)) return null;
  const observations = [];
  for (const item of investigation.items) {
    if (item?.t !== INVESTIGATION_SIGNAL_TYPE) continue;
    const signal = normalizeInvestigationComparativeSignal(item);
    if (!signal) return null;
    observations.push({
      observation_id: signal.id,
      exact_claim: signal.claim,
      comparison_basis: signal.comparison,
      objects: [{ ...signal.subject, href: signal.subject_href }],
      official_evidence: signal.evidence,
      comparison_receipt: signal.comparison_receipt,
      snapshot_vintages: signal.comparison_receipt.peer_basis.source_vintages,
    });
  }
  const metadata = deriveResearchPackageMetadata(observations);
  return normalizeResearchPackageRequest({
    schema: RESEARCH_PACKAGE_REQUEST_SCHEMA,
    discriminator: "research_package",
    title: title || investigation.name,
    question,
    observations,
    methods: metadata.methods,
    source_contracts: metadata.source_contracts,
    supersedes,
    changes,
  });
}

/** Clamp a stored package while discarding any unregistered/copy-dataset fields. */
export function normalizeResearchPackage(value) {
  if (value?.schema !== RESEARCH_PACKAGE_SCHEMA) return null;
  const packageId = researchPackageIdentifier(value?.package_id, 80);
  const versionId = researchPackageIdentifier(value?.version_id, 80);
  const version = researchPackagePositiveInteger(value?.version);
  const createdAt = researchPackageInstant(value?.created_at);
  const generatedAt = researchPackageInstant(value?.generated_at);
  const request = normalizeResearchPackageRequest({
    schema: RESEARCH_PACKAGE_REQUEST_SCHEMA,
    discriminator: "research_package",
    title: value?.title,
    question: value?.question,
    observations: value?.observations,
    changes: value?.changes,
    supersedes: value?.supersedes,
  });
  if (!packageId || !versionId || !version || !createdAt || !generatedAt || !request) return null;
  const supersedesVersion = researchPackagePositiveInteger(value?.supersedes?.version);
  if (
    (version === 1 && request.supersedes !== null)
    || (version === 1 && (request.changes.length !== 1
      || request.changes[0].kind !== "created"
      || request.changes[0].summary !== "Initial frozen package."))
    || (version > 1 && (!request.supersedes || supersedesVersion !== version - 1 || !request.changes.length))
  ) return null;
  const normalized = {
    schema: RESEARCH_PACKAGE_SCHEMA,
    package_id: packageId,
    version_id: versionId,
    version,
    created_at: createdAt,
    generated_at: generatedAt,
    supersedes: version === 1 ? null : {
      version_id: request.supersedes.version_id,
      version: supersedesVersion,
    },
    title: request.title,
    question: request.question,
    observations: request.observations,
    methods: request.methods,
    source_contracts: request.source_contracts,
    changes: request.changes,
    bounded_export: {
      schema: RESEARCH_PACKAGE_EXPORT_SCHEMA,
      media_type: "application/json",
      content_schema: RESEARCH_PACKAGE_SCHEMA,
      maximum_bytes: MAX_RESEARCH_PACKAGE_BYTES,
      dataset_payloads: "references_only",
    },
  };
  return researchPackageByteLength(JSON.stringify(normalized)) <= MAX_RESEARCH_PACKAGE_BYTES ? freezeResearchPackageValue(normalized) : null;
}

/** Mint a new immutable version. The caller provides server-generated identities. */
export function finalizeResearchPackage(requestValue, {
  packageId = "",
  versionId = "",
  generatedAt = "",
  previousPackage = null,
} = {}) {
  const request = normalizeResearchPackageRequest(requestValue);
  const previous = previousPackage ? normalizeResearchPackage(previousPackage) : null;
  const nextVersionId = researchPackageIdentifier(versionId, 80);
  const generated = researchPackageInstant(generatedAt);
  if (!request || !nextVersionId || !generated) return null;

  let nextPackageId;
  let version;
  let createdAt;
  let supersedesValue;
  let changes;
  if (request.supersedes) {
    if (!previous || request.supersedes.version_id !== previous.version_id || !request.changes.length) return null;
    nextPackageId = previous.package_id;
    version = previous.version + 1;
    createdAt = previous.created_at;
    supersedesValue = { version_id: previous.version_id, version: previous.version };
    changes = request.changes;
  } else {
    nextPackageId = researchPackageIdentifier(packageId, 80);
    if (!nextPackageId || previous || request.changes.length) return null;
    version = 1;
    createdAt = generated;
    supersedesValue = null;
    changes = [{ kind: "created", summary: "Initial frozen package." }];
  }

  return normalizeResearchPackage({
    schema: RESEARCH_PACKAGE_SCHEMA,
    package_id: nextPackageId,
    version_id: nextVersionId,
    version,
    created_at: createdAt,
    generated_at: generated,
    supersedes: supersedesValue,
    title: request.title,
    question: request.question,
    observations: request.observations,
    methods: request.methods,
    source_contracts: request.source_contracts,
    changes,
  });
}

/** Stable, bounded machine-readable export of a validated frozen version. */
export function researchPackageJson(value) {
  const normalized = normalizeResearchPackage(value);
  if (!normalized) return null;
  const result = `${JSON.stringify(canonicalResearchPackageValue(normalized), null, 2)}\n`;
  return researchPackageByteLength(result) <= MAX_RESEARCH_PACKAGE_BYTES ? result : null;
}

/** Compare current admitted materializations without modifying the frozen version. */
export function researchPackageNewerData(value, currentSignals = []) {
  const researchPackage = normalizeResearchPackage(value);
  if (!researchPackage) return null;
  const newer = [];
  for (const observation of researchPackage.observations) {
    const frozenAt = Date.parse(observation.comparison_receipt.generated_at);
    const objectRef = observation.objects[0]?.ref;
    const method = observation.comparison_receipt.metric_method;
    const candidates = Array.isArray(currentSignals) ? currentSignals.filter((signal) => (
      signal?.schema === RESEARCH_PACKAGE_STORY_SIGNAL_SCHEMA
      && signal?.subject?.ref === objectRef
      && signal?.comparison_receipt?.metric_method === method
      && Date.parse(signal?.comparison_receipt?.generated_at || signal?.generated_at || "") > frozenAt
    )) : [];
    candidates.sort((a, b) => String(b.comparison_receipt?.generated_at || b.generated_at)
      .localeCompare(String(a.comparison_receipt?.generated_at || a.generated_at)));
    if (candidates[0]) {
      newer.push({
        observation_id: observation.observation_id,
        signal_id: researchPackageText(candidates[0].signal_id, 500),
        generated_at: researchPackageInstant(candidates[0].comparison_receipt?.generated_at || candidates[0].generated_at),
      });
    }
  }
  return freezeResearchPackageValue({
    schema: RESEARCH_PACKAGE_FRESHNESS_SCHEMA,
    package_id: researchPackage.package_id,
    version_id: researchPackage.version_id,
    newer_data_available: newer.length > 0,
    newer_materializations: newer,
  });
}
