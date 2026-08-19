/**
 * Narrow waist from one admitted comparative story signal into Investigation.
 *
 * Measurement and admission already happened upstream. This module only validates,
 * clamps, and copies the frozen claim, subject, comparison basis, receipt reference,
 * and source-record evidence into the existing local-first Investigation item union.
 */

export const INVESTIGATION_COMPARATIVE_SIGNAL_SCHEMA = "cityscroll.investigation_comparative_signal.v1";
export const COMPARATIVE_FACT_REFERENCE_SCHEMA = "cityscroll.comparative_fact_reference.v1";
export const INVESTIGATION_SIGNAL_TYPE = "signal";
export const MAX_INV_SIGNAL_EVIDENCE = 12;

const STORY_SIGNAL_SCHEMA = "cityscroll.story_signal.v1";
const COMPARATIVE_FACT_SCHEMA = "cityscroll.comparative_fact.v1";

function text(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function nullableText(value, max) {
  const valueText = text(value, max);
  return valueText || null;
}

function integer(value, minimum = 0) {
  return Number.isInteger(value) && value >= minimum ? value : null;
}

function isoDay(value) {
  const day = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== day ? null : day;
}

function safeLocalHref(value, max = 500) {
  const href = text(value, max);
  return href.startsWith("/") && !href.startsWith("//") ? href : null;
}

function safeHttpsHref(value) {
  const href = text(value, 500);
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function sourceVintage(value) {
  const sourceContractId = text(value?.source_contract_id, 160);
  const datasetId = text(value?.dataset_id, 160);
  const materializedAt = text(value?.materialized_at, 40);
  if (!sourceContractId || !datasetId || !materializedAt) return null;
  return {
    source_contract_id: sourceContractId,
    source_contract_schema_version: integer(value?.source_contract_schema_version),
    dataset_id: datasetId,
    materialized_at: materializedAt,
    row_count: integer(value?.row_count),
  };
}

function comparison(value) {
  const eligibleCount = integer(value?.eligible_count);
  const observedCount = integer(value?.observed_count);
  const rank = integer(value?.rank, 1);
  const start = isoDay(value?.window?.start);
  const end = isoDay(value?.window?.end);
  const objectType = text(value?.population?.object_type, 80);
  const sourceFamily = text(value?.population?.source_family, 160);
  if (eligibleCount == null || observedCount == null || rank == null || !start || !end || !objectType || !sourceFamily) {
    return null;
  }
  return {
    population: {
      object_type: objectType,
      source_family: sourceFamily,
      agency_id: nullableText(value?.population?.agency_id, 160),
      agency_name: nullableText(value?.population?.agency_name, 200),
    },
    eligible_count: eligibleCount,
    observed_count: observedCount,
    window: {
      start,
      end,
      end_inclusive: value?.window?.end_inclusive === true,
    },
    rank,
  };
}

function receiptReference(value) {
  const receiptId = text(value?.receipt_id, 500);
  const metricMethod = text(value?.metric_method, 160);
  const classId = text(value?.peer_basis?.class_id, 500);
  const generatedAt = text(value?.generated_at, 40);
  const vintages = Array.isArray(value?.peer_basis?.source_vintages)
    ? value.peer_basis.source_vintages.slice(0, 12).map(sourceVintage).filter(Boolean)
    : [];
  if (
    value?.schema !== COMPARATIVE_FACT_REFERENCE_SCHEMA
    || value?.receipt_schema !== COMPARATIVE_FACT_SCHEMA
    || !receiptId
    || !metricMethod
    || !classId
    || !generatedAt
    || !vintages.length
  ) return null;
  return {
    schema: COMPARATIVE_FACT_REFERENCE_SCHEMA,
    receipt_schema: COMPARATIVE_FACT_SCHEMA,
    receipt_id: receiptId,
    metric_method: metricMethod,
    peer_basis: {
      class_id: classId,
      observability_basis: text(value.peer_basis.observability_basis, 80),
      source_contract_versions: Array.isArray(value.peer_basis.source_contract_versions)
        ? value.peer_basis.source_contract_versions.slice(0, 12).map((item) => text(item, 200)).filter(Boolean)
        : [],
      source_vintages: vintages,
      inclusion_rule: text(value.peer_basis.inclusion_rule, 1000),
      identity_gate: text(value.peer_basis.identity_gate, 300),
      observation_quality_class: text(value.peer_basis.observation_quality_class, 200),
      censoring_class: text(value.peer_basis.censoring_class, 200),
      selected_level: text(value.peer_basis.selected_level, 160),
      small_n_policy_id: text(value.peer_basis.small_n_policy_id, 160),
    },
    generated_at: generatedAt,
  };
}

function evidenceReference(value) {
  const kind = text(value?.kind, 80);
  const sourceContractId = text(value?.source_contract_id, 160);
  const sourceRowId = text(value?.source_row_id, 200);
  const href = safeHttpsHref(value?.href);
  if (!kind || !sourceContractId || !sourceRowId || !href) return null;
  return { kind, source_contract_id: sourceContractId, source_row_id: sourceRowId, href };
}

function subject(value) {
  const type = text(value?.type, 80);
  const id = text(value?.id, 160);
  const ref = text(value?.ref, 240);
  const label = text(value?.label, 300);
  return type && id && ref && label ? { type, id, ref, label } : null;
}

/** Validate and clamp a versioned comparative-signal Investigation item. */
export function normalizeInvestigationComparativeSignal(item) {
  if (
    item?.schema !== INVESTIGATION_COMPARATIVE_SIGNAL_SCHEMA
    || item?.t !== INVESTIGATION_SIGNAL_TYPE
    || Object.hasOwn(item, "state")
    || Object.hasOwn(item, "backstage")
    || Object.hasOwn(item, "public_signal")
  ) return null;
  const id = text(item.id, 500);
  const claim = text(item.claim, 1000);
  const itemSubject = subject(item.subject);
  const subjectHref = safeLocalHref(item.subject_href);
  const peerSetHref = safeLocalHref(item.peer_set_href);
  const itemComparison = comparison(item.comparison);
  const receipt = receiptReference(item.comparison_receipt);
  const evidence = Array.isArray(item.evidence)
    ? item.evidence.slice(0, MAX_INV_SIGNAL_EVIDENCE).map(evidenceReference).filter(Boolean)
    : [];
  if (
    !id
    || !claim
    || !itemSubject
    || !subjectHref
    || !peerSetHref
    || !itemComparison
    || !receipt
    || !evidence.length
    || id !== `story_signal:${receipt.receipt_id}`
    || !evidence.some((entry) => entry.source_row_id === itemSubject.id)
  ) return null;
  return {
    schema: INVESTIGATION_COMPARATIVE_SIGNAL_SCHEMA,
    t: INVESTIGATION_SIGNAL_TYPE,
    id,
    title: text(item.title || itemSubject.label, 300),
    meta: text(item.meta, 300),
    claim,
    subject: itemSubject,
    subject_href: subjectHref,
    peer_set_href: peerSetHref,
    comparison: itemComparison,
    comparison_receipt: receipt,
    evidence,
    note: text(item.note, 1000),
    added: isoDay(item.added) || "",
  };
}

/** Copy an admitted story signal into the strict Investigation item contract. */
export function storySignalInvestigationItem(signal, { peerSetHref = "" } = {}) {
  if (
    signal?.schema !== STORY_SIGNAL_SCHEMA
    || Object.hasOwn(signal, "state")
    || Object.hasOwn(signal, "backstage")
    || Object.hasOwn(signal, "public_signal")
    || signal?.signal_id !== `story_signal:${signal?.fact_id || ""}`
  ) return null;
  const itemSubject = subject(signal.subject);
  if (!itemSubject) return null;
  return normalizeInvestigationComparativeSignal({
    schema: INVESTIGATION_COMPARATIVE_SIGNAL_SCHEMA,
    t: INVESTIGATION_SIGNAL_TYPE,
    id: signal.signal_id,
    title: itemSubject.label,
    meta: [signal?.metric?.id, `${signal?.comparison?.observed_count ?? ""} compared records`].filter(Boolean).join(" · "),
    claim: signal.basis_sentence,
    subject: itemSubject,
    subject_href: `/notices/${encodeURIComponent(itemSubject.id)}/`,
    peer_set_href: peerSetHref,
    comparison: signal.comparison,
    comparison_receipt: signal.comparison_receipt,
    evidence: signal.evidence,
    note: "",
    added: "",
  });
}

/** Add once by frozen signal identity. Shared-snapshot imports use the same path. */
export function addInvestigationComparativeSignal(items, candidate, { added = "" } = {}) {
  if (!Array.isArray(items)) return false;
  const normalized = normalizeInvestigationComparativeSignal({ ...candidate, added: candidate?.added || added });
  if (!normalized || items.some((item) => item?.t === INVESTIGATION_SIGNAL_TYPE && item?.id === normalized.id)) return false;
  items.push(normalized);
  return true;
}

/** Stable flattened fields for the existing Investigation CSV export. */
export function comparativeSignalCsvFields(item) {
  const normalized = normalizeInvestigationComparativeSignal(item);
  if (!normalized) return { claim: "", subject: "", peer_set: "", comparison_receipt: "", evidence: "" };
  return {
    claim: normalized.claim,
    subject: normalized.subject.label,
    peer_set: normalized.peer_set_href,
    comparison_receipt: normalized.comparison_receipt.receipt_id,
    evidence: normalized.evidence.map((entry) => `${entry.source_contract_id}:${entry.source_row_id} ${entry.href}`).join(" | "),
  };
}
