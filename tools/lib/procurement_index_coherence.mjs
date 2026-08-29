/**
 * Build-time coherence between the served procurement detail model and the
 * keyword-index family that advertises those objects.
 *
 * Search may not advertise a canonical procurement the detail-read artifact
 * cannot serve. A legitimately suppressed object stays out of the index and is
 * recorded in coverage, never present-in-index-but-absent-in-served.
 */

import { createHash } from "node:crypto";

export const PROCUREMENT_INDEX_COHERENCE_SCHEMA = "cityscroll.procurement_index_coherence.v1";
export const SOURCE_MODEL_FINGERPRINT_VERSION = "cityscroll.procurement_source_model.v2";
export const SPINE_SOURCE_PATH = "site/data/procurement_spine_sources.json";
export const AWARDS_SOURCE_PATH = "site/data/ocp_awards_warehouse_lookup.json";
export const MTA_SOURCE_PATH = "site/data/mta_procurement_sources.json";
export const READ_MODEL_PATH = "site/data/shared_procurement_read_model.json";
export const KEYWORD_INDEX_PATH = "worker/src/data/keyword_search_index_shards/manifest.json";

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value) {
  return sha256Bytes(String(value ?? ""));
}

export function sourceModelFingerprint({ spineBytes, awardsBytes, mtaBytes }) {
  if (spineBytes == null || awardsBytes == null) return null;
  const sourceHashes = [
    SOURCE_MODEL_FINGERPRINT_VERSION,
    sha256Bytes(spineBytes),
    sha256Bytes(awardsBytes),
  ];
  if (mtaBytes != null) sourceHashes.push(sha256Bytes(mtaBytes));
  return sha256Text(sourceHashes.join("\n"));
}

export function servedProcurementIds(readModel) {
  const rows = Array.isArray(readModel?.rows) ? readModel.rows : [];
  return [...new Set(rows.map((row) => String(row?.procurement_id || "").trim()).filter(Boolean))].sort();
}

export function advertisedProcurementRefs(keywordIndex) {
  const documents = keywordIndex?.families?.procurements?.documents;
  if (!Array.isArray(documents)) return [];
  return [...new Set(documents.map((document) => String(document?.object_ref || "").trim()).filter(Boolean))].sort();
}

export function selectedRowCountFromModel(readModel) {
  const publication = readModel?.publication?.selected_rows;
  if (Number.isInteger(publication)) return publication;
  const observations = readModel?.counts?.source_observations;
  if (Number.isInteger(observations)) return observations;
  const gate = readModel?.identity_gate?.selected_source_rows;
  if (Number.isInteger(gate)) return gate;
  return null;
}

export function procurementArtifactHashes({
  readModel,
  advertisedRefs,
  selectedRowCount = selectedRowCountFromModel(readModel),
} = {}) {
  const servedIds = servedProcurementIds(readModel);
  const advertised = [...new Set((advertisedRefs || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
  return {
    shared_procurement_read_model: sha256Text(JSON.stringify({
      schema: readModel?.schema || null,
      generated_at: readModel?.generated_at || null,
      selected_row_count: selectedRowCount,
      procurement_ids: servedIds,
    })),
    keyword_search_procurements: sha256Text(JSON.stringify(advertised)),
  };
}

export function buildCoherenceReceipt({
  sourceModelFingerprint: fingerprint,
  generatedAt,
  selectedRowCount,
  artifactHashes,
} = {}) {
  return {
    schema: PROCUREMENT_INDEX_COHERENCE_SCHEMA,
    source_model_fingerprint: fingerprint || null,
    generated_at: generatedAt || null,
    selected_row_count: Number.isInteger(selectedRowCount) ? selectedRowCount : null,
    artifact_hashes: {
      shared_procurement_read_model: artifactHashes?.shared_procurement_read_model || null,
      keyword_search_procurements: artifactHashes?.keyword_search_procurements || null,
    },
  };
}

export function attachCoherenceReceipt(readModel, {
  sourceModelFingerprint: fingerprint,
  advertisedRefs,
  selectedRowCount = selectedRowCountFromModel(readModel),
  generatedAt = readModel?.generated_at || null,
} = {}) {
  const { coherence_receipt: _ignored, ...body } = readModel && typeof readModel === "object" ? readModel : {};
  const receipt = buildCoherenceReceipt({
    sourceModelFingerprint: fingerprint,
    generatedAt,
    selectedRowCount,
    artifactHashes: procurementArtifactHashes({
      readModel: body,
      advertisedRefs,
      selectedRowCount,
    }),
  });
  return { ...body, coherence_receipt: receipt };
}

function finding(code, message, extra = {}) {
  return { code, message, ...extra };
}

function receiptsEqual(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

export function checkProcurementIndexCoherence({
  readModel,
  keywordIndex,
  spineBytes,
  awardsBytes,
  mtaBytes,
} = {}) {
  const advertised = advertisedProcurementRefs(keywordIndex);
  const served = servedProcurementIds(readModel);
  const servedSet = new Set(served);
  const indexOnly = advertised.filter((id) => !servedSet.has(id));
  const selectedRowCount = selectedRowCountFromModel(readModel);
  const expectedHashes = procurementArtifactHashes({
    readModel,
    advertisedRefs: advertised,
    selectedRowCount,
  });
  const sourceFingerprint = spineBytes != null && awardsBytes != null
    ? sourceModelFingerprint({ spineBytes, awardsBytes, mtaBytes })
    : (readModel?.coherence_receipt?.source_model_fingerprint
      || keywordIndex?.coherence_receipt?.source_model_fingerprint
      || null);
  const expectedReceipt = buildCoherenceReceipt({
    sourceModelFingerprint: sourceFingerprint,
    generatedAt: readModel?.generated_at || null,
    selectedRowCount,
    artifactHashes: expectedHashes,
  });

  const findings = [];
  if (!readModel?.coherence_receipt) {
    findings.push(finding("missing_receipt", "served procurement model is missing coherence_receipt"));
  }
  if (!keywordIndex?.coherence_receipt) {
    findings.push(finding("missing_receipt", "keyword search index is missing coherence_receipt"));
  }
  if (readModel?.coherence_receipt && keywordIndex?.coherence_receipt
    && !receiptsEqual(readModel.coherence_receipt, keywordIndex.coherence_receipt)) {
    findings.push(finding(
      "receipt_mismatch",
      "served procurement model and keyword index coherence receipts disagree",
    ));
  }

  const actualReceipt = readModel?.coherence_receipt || keywordIndex?.coherence_receipt || null;
  if (actualReceipt) {
    if (actualReceipt.schema !== PROCUREMENT_INDEX_COHERENCE_SCHEMA) {
      findings.push(finding(
        "receipt_schema",
        `coherence receipt schema must be ${PROCUREMENT_INDEX_COHERENCE_SCHEMA}`,
        { actual: actualReceipt.schema || null },
      ));
    }
    if (actualReceipt.generated_at !== expectedReceipt.generated_at) {
      findings.push(finding(
        "generated_at_mismatch",
        "coherence receipt generated_at must match the served procurement model",
        { expected: expectedReceipt.generated_at, actual: actualReceipt.generated_at || null },
      ));
    }
    if (actualReceipt.selected_row_count !== expectedReceipt.selected_row_count) {
      findings.push(finding(
        "selected_row_count_mismatch",
        "coherence receipt selected_row_count must match the served procurement selection",
        { expected: expectedReceipt.selected_row_count, actual: actualReceipt.selected_row_count ?? null },
      ));
    }
    if (actualReceipt.artifact_hashes?.shared_procurement_read_model
      !== expectedReceipt.artifact_hashes.shared_procurement_read_model) {
      findings.push(finding(
        "artifact_hash_mismatch",
        "coherence receipt hash for the served procurement model does not match the detail-read artifact",
      ));
    }
    if (actualReceipt.artifact_hashes?.keyword_search_procurements
      !== expectedReceipt.artifact_hashes.keyword_search_procurements) {
      findings.push(finding(
        "artifact_hash_mismatch",
        "coherence receipt hash for advertised procurements does not match the keyword index family",
      ));
    }
    if (spineBytes != null && awardsBytes != null
      && actualReceipt.source_model_fingerprint !== expectedReceipt.source_model_fingerprint) {
      findings.push(finding(
        "source_fingerprint_mismatch",
        "coherence receipt source-model fingerprint does not match the procurement source artifacts",
      ));
    }
  }

  if (indexOnly.length) {
    findings.push(finding(
      "index_only_advertised",
      `keyword index advertises ${indexOnly.length} procurement object(s) absent from the served detail model`,
      { object_refs: indexOnly },
    ));
  }

  return {
    ok: findings.length === 0,
    findings,
    advertised_count: advertised.length,
    served_count: served.length,
    index_only: indexOnly,
    receipt: expectedReceipt,
  };
}

export function formatCoherenceFindings(findings = []) {
  const lines = [`procurement index coherence: ${findings.length} finding(s)`];
  for (const item of findings) {
    lines.push(`  ${item.code}: ${item.message}`);
    if (Array.isArray(item.object_refs) && item.object_refs.length) {
      for (const ref of item.object_refs.slice(0, 20)) lines.push(`    ${ref}`);
      if (item.object_refs.length > 20) lines.push(`    … ${item.object_refs.length - 20} more`);
    }
  }
  return lines.join("\n");
}

export function attachKeywordCoherenceReceipt({ readModel, keywordIndex }) {
  const advertisedRefs = advertisedProcurementRefs(keywordIndex);
  const selectedRowCount = selectedRowCountFromModel(readModel);
  const receipt = readModel?.coherence_receipt || buildCoherenceReceipt({
    sourceModelFingerprint: null,
    generatedAt: readModel?.generated_at || null,
    selectedRowCount,
    artifactHashes: procurementArtifactHashes({
      readModel,
      advertisedRefs,
      selectedRowCount,
    }),
  });
  const { coherence_receipt: _ignored, ...body } = keywordIndex && typeof keywordIndex === "object"
    ? keywordIndex
    : {};
  return { ...body, coherence_receipt: receipt };
}
