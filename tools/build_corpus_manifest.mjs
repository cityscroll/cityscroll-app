#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SEMANTIC_CIVIC_OBJECT_FAMILIES,
  buildSemanticCivicObjectIndex,
} from "../warehouse/lib/semantic_civic_object_groups.mjs";

export const CORPUS_MANIFEST_SCHEMA = "cityscroll.semantic_retrieval.corpus_manifest.v1";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_PATH = join(ROOT, "warehouse/experiments/semantic-layer-trial/corpus.json");
const SELECTION_PATH = join(ROOT, "warehouse/experiments/semantic-layer-trial/source_manifest.json");
const OUTPUT_PATH = join(ROOT, "warehouse/manifests/semantic_retrieval_corpus_manifest.json");

const FAMILY_SPECS = Object.freeze({
  attachment_text: Object.freeze({ coverage_field: "attachment" }),
  city_record_notice: Object.freeze({ coverage_field: "notice_ids" }),
  community_board_minutes: Object.freeze({ coverage_field: "outcome_document" }),
});

const DROP_REASONS = new Set([
  "content_checksum_mismatch",
  "duplicate_source_record_id",
  "invalid_source_url",
  "missing_passage_text",
  "missing_record_id",
  "unsupported_source_family",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareText = (left, right) => String(left).localeCompare(String(right), "en");
const canonicalSha256 = (value) => sha256(JSON.stringify(value));

function sourceRecordId(family, nativeId) {
  return `${family}:${encodeURIComponent(nativeId)}`;
}

function validSourceUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function sourcePublishedAt(row) {
  return String(row?.published_at || row?.event_date || "").trim() || null;
}

function familyBoundary(corpus, selectionManifest, family) {
  const field = FAMILY_SPECS[family].coverage_field;
  const selection = selectionManifest?.selection || corpus?.selection || {};
  const boundary = String(selection?.[field] || "").trim();
  return boundary || "Bounded committed snapshot; the complete publisher corpus is not represented.";
}

function droppedRecord(row, reason) {
  return {
    source_family: String(row?.kind || "").trim() || null,
    source_native_id: String(row?.id || "").trim() || null,
    reason,
  };
}

function recordFromRow(row, observedOn, civicObjectIndex) {
  const family = String(row?.kind || "").trim();
  if (!Object.hasOwn(FAMILY_SPECS, family)) {
    return { dropped: droppedRecord(row, "unsupported_source_family") };
  }
  const nativeId = String(row?.id || "").trim();
  if (!nativeId) return { dropped: droppedRecord(row, "missing_record_id") };
  const sourceUrl = String(row?.source?.url || "").trim();
  if (!validSourceUrl(sourceUrl)) return { dropped: droppedRecord(row, "invalid_source_url") };
  if (typeof row?.text !== "string" || row.text.length === 0) {
    return { dropped: droppedRecord(row, "missing_passage_text") };
  }
  const contentSha256 = sha256(row.text);
  if (String(row?.text_sha256 || "").trim() !== contentSha256) {
    return { dropped: droppedRecord(row, "content_checksum_mismatch") };
  }
  const publishedAt = sourcePublishedAt(row);
  const recordId = sourceRecordId(family, nativeId);
  const civicObjectFamily = civicObjectIndex.get(recordId);
  if (!civicObjectFamily) {
    throw new Error(`semantic source is missing civic object classification: ${recordId}`);
  }
  return {
    record: {
      source_record_id: recordId,
      source_family: family,
      source_native_id: nativeId,
      civic_object_family: civicObjectFamily,
      source_url: sourceUrl,
      source_system: String(row?.source?.system || "").trim() || null,
      passage: {
        title: String(row?.title || "").trim() || null,
        text_state: "retained",
        content_sha256: contentSha256,
        character_count: row.text.length,
      },
      geography: {
        body_id: String(row?.body_id || "").trim() || null,
      },
      dates: {
        published_at: String(row?.published_at || "").trim() || null,
        event_date: String(row?.event_date || "").trim() || null,
      },
      coverage_state: "partial",
      freshness_receipt: {
        state: observedOn ? "observed" : "unknown",
        observed_on: observedOn,
        source_published_at: publishedAt,
      },
    },
  };
}

function familySummary(family, records, droppedRecords, corpus, selectionManifest, observedOn) {
  const familyRecords = records.filter((row) => row.source_family === family);
  const familyDropped = droppedRecords.filter((row) => row.source_family === family);
  const publishedDates = familyRecords
    .map((row) => row.freshness_receipt.source_published_at)
    .filter(Boolean)
    .sort(compareText);
  return {
    source_family: family,
    type_version: 1,
    identity: {
      record_id_field: "id",
      record_id_format: "{source_family}:{percent_encoded_source_native_id}",
      source_url_field: "source.url",
    },
    passage_fields: ["title", "text"],
    civic_object_fields: ["civic_object_family"],
    geography_fields: ["body_id"],
    date_fields: ["published_at", "event_date"],
    coverage: {
      state: "partial",
      boundary: familyBoundary(corpus, selectionManifest, family),
    },
    freshness_receipt: {
      state: observedOn ? "observed" : "unknown",
      observed_on: observedOn,
      records_with_source_published_at: publishedDates.length,
      source_published_at_min: publishedDates.at(0) || null,
      source_published_at_max: publishedDates.at(-1) || null,
    },
    record_count: familyRecords.length,
    dropped_record_count: familyDropped.length,
  };
}

function manifestChecksumPayload(manifest) {
  const { manifest_sha256: _checksum, ...payload } = manifest;
  return payload;
}

export function buildCorpusManifest(corpus, selectionManifest, {
  corpusReceipt = null,
  selectionReceipt = null,
} = {}) {
  if (!Array.isArray(corpus?.documents)) throw new Error("corpus manifest requires a documents array");
  const observedOn = String(corpus?.observed_on || "").trim() || null;
  const civicObjectIndex = buildSemanticCivicObjectIndex(selectionManifest);
  const rows = [...corpus.documents].sort((left, right) => compareText(
    `${String(left?.kind || "")}:${String(left?.id || "")}:${JSON.stringify(left)}`,
    `${String(right?.kind || "")}:${String(right?.id || "")}:${JSON.stringify(right)}`,
  ));
  const records = [];
  const droppedRecords = [];
  const seenRecordIds = new Set();

  for (const row of rows) {
    const result = recordFromRow(row, observedOn, civicObjectIndex);
    if (result.dropped) {
      droppedRecords.push(result.dropped);
      continue;
    }
    if (seenRecordIds.has(result.record.source_record_id)) {
      droppedRecords.push(droppedRecord(row, "duplicate_source_record_id"));
      continue;
    }
    seenRecordIds.add(result.record.source_record_id);
    records.push(result.record);
  }
  records.sort((left, right) => compareText(left.source_record_id, right.source_record_id));
  droppedRecords.sort((left, right) => compareText(
    `${left.source_family || ""}:${left.source_native_id || ""}:${left.reason}`,
    `${right.source_family || ""}:${right.source_native_id || ""}:${right.reason}`,
  ));

  const familyNames = [...new Set([
    ...records.map((row) => row.source_family),
    ...droppedRecords.map((row) => row.source_family).filter((family) => Object.hasOwn(FAMILY_SPECS, family)),
  ])].sort(compareText);
  const droppedReasonCounts = Object.fromEntries(
    [...new Set(droppedRecords.map((row) => row.reason))]
      .sort(compareText)
      .map((reason) => [reason, droppedRecords.filter((row) => row.reason === reason).length]),
  );
  const defaultCorpusReceipt = {
    path: null,
    sha256: canonicalSha256(corpus),
  };
  const defaultSelectionReceipt = {
    path: null,
    sha256: canonicalSha256(selectionManifest || {}),
  };
  const manifest = {
    schema: CORPUS_MANIFEST_SCHEMA,
    manifest_version: 1,
    observed_on: observedOn,
    authorization: {
      runtime_semantic_retrieval: false,
      scope: "offline_candidate_corpus",
    },
    input_receipts: {
      corpus: corpusReceipt || defaultCorpusReceipt,
      selection: selectionReceipt || defaultSelectionReceipt,
    },
    coverage: {
      state: "partial",
      boundary: "Only the records enumerated below are included; this is not a complete publisher or CityScroll corpus.",
    },
    source_family_count: familyNames.length,
    record_count: records.length,
    dropped_record_count: droppedRecords.length,
    dropped_reason_counts: droppedReasonCounts,
    source_families: familyNames.map((family) => familySummary(
      family,
      records,
      droppedRecords,
      corpus,
      selectionManifest,
      observedOn,
    )),
    records,
    dropped_records: droppedRecords,
    corpus_sha256: canonicalSha256(records.map((record) => ({
      source_record_id: record.source_record_id,
      civic_object_family: record.civic_object_family,
      source_url: record.source_url,
      content_sha256: record.passage.content_sha256,
    }))),
  };
  manifest.manifest_sha256 = canonicalSha256(manifestChecksumPayload(manifest));
  return validateCorpusManifest(manifest);
}

export function validateCorpusManifest(manifest) {
  if (manifest?.schema !== CORPUS_MANIFEST_SCHEMA || manifest.manifest_version !== 1) {
    throw new Error("corpus manifest schema mismatch");
  }
  if (manifest.authorization?.runtime_semantic_retrieval !== false) {
    throw new Error("corpus manifest must not authorize runtime semantic retrieval");
  }
  if (manifest.coverage?.state !== "partial" || !manifest.coverage.boundary) {
    throw new Error("corpus manifest must declare its partial coverage boundary");
  }
  if (!Array.isArray(manifest.source_families)
      || !Array.isArray(manifest.records)
      || !Array.isArray(manifest.dropped_records)) {
    throw new Error("corpus manifest arrays are missing");
  }
  if (manifest.source_family_count !== manifest.source_families.length
      || manifest.record_count !== manifest.records.length
      || manifest.dropped_record_count !== manifest.dropped_records.length) {
    throw new Error("corpus manifest counts do not match serialized rows");
  }
  for (const receipt of Object.values(manifest.input_receipts || {})) {
    if (!receipt || !/^[a-f0-9]{64}$/.test(String(receipt.sha256 || ""))) {
      throw new Error("corpus manifest input receipt checksum is missing");
    }
  }

  const families = new Map();
  for (const family of manifest.source_families) {
    if (!Object.hasOwn(FAMILY_SPECS, family.source_family) || families.has(family.source_family)) {
      throw new Error(`invalid or duplicate source family ${family.source_family}`);
    }
    if (family.type_version !== 1
        || family.coverage?.state !== "partial"
        || !family.coverage.boundary
        || family.freshness_receipt?.observed_on !== manifest.observed_on) {
      throw new Error(`incomplete family contract ${family.source_family}`);
    }
    families.set(family.source_family, family);
  }

  const recordIds = new Set();
  for (const record of manifest.records) {
    if (!families.has(record.source_family)
        || !record.source_native_id
        || record.source_record_id !== sourceRecordId(record.source_family, record.source_native_id)
        || recordIds.has(record.source_record_id)) {
      throw new Error(`invalid or duplicate source record ${record.source_record_id || "unknown"}`);
    }
    if (!validSourceUrl(record.source_url)) throw new Error(`invalid source URL ${record.source_record_id}`);
    if (!SEMANTIC_CIVIC_OBJECT_FAMILIES.includes(record.civic_object_family)
        || record.coverage_state !== "partial"
        || record.freshness_receipt?.observed_on !== manifest.observed_on
        || record.passage?.text_state !== "retained"
        || !/^[a-f0-9]{64}$/.test(String(record.passage?.content_sha256 || ""))
        || !Number.isInteger(record.passage?.character_count)
        || record.passage.character_count <= 0) {
      throw new Error(`incomplete source record ${record.source_record_id}`);
    }
    recordIds.add(record.source_record_id);
  }

  for (const row of manifest.dropped_records) {
    if (!DROP_REASONS.has(row.reason)) throw new Error(`unknown drop reason ${row.reason}`);
  }
  const expectedReasonCounts = Object.fromEntries(
    [...new Set(manifest.dropped_records.map((row) => row.reason))]
      .sort(compareText)
      .map((reason) => [reason, manifest.dropped_records.filter((row) => row.reason === reason).length]),
  );
  if (JSON.stringify(manifest.dropped_reason_counts) !== JSON.stringify(expectedReasonCounts)) {
    throw new Error("corpus manifest dropped reason counts do not match rows");
  }
  for (const [familyName, family] of families) {
    const recordCount = manifest.records.filter((row) => row.source_family === familyName).length;
    const droppedCount = manifest.dropped_records.filter((row) => row.source_family === familyName).length;
    if (family.record_count !== recordCount || family.dropped_record_count !== droppedCount) {
      throw new Error(`source family counts do not match ${familyName}`);
    }
  }

  const expectedCorpusSha256 = canonicalSha256(manifest.records.map((record) => ({
    source_record_id: record.source_record_id,
    civic_object_family: record.civic_object_family,
    source_url: record.source_url,
    content_sha256: record.passage.content_sha256,
  })));
  if (manifest.corpus_sha256 !== expectedCorpusSha256) throw new Error("corpus manifest content checksum mismatch");
  const expectedManifestSha256 = canonicalSha256(manifestChecksumPayload(manifest));
  if (manifest.manifest_sha256 !== expectedManifestSha256) throw new Error("corpus manifest checksum mismatch");
  return manifest;
}

export function serializeCorpusManifest(manifest) {
  validateCorpusManifest(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function buildAndWriteCorpusManifest({ check = false } = {}) {
  const corpusText = readFileSync(CORPUS_PATH, "utf8");
  const selectionText = readFileSync(SELECTION_PATH, "utf8");
  const manifest = buildCorpusManifest(JSON.parse(corpusText), JSON.parse(selectionText), {
    corpusReceipt: {
      path: "warehouse/experiments/semantic-layer-trial/corpus.json",
      sha256: sha256(corpusText),
    },
    selectionReceipt: {
      path: "warehouse/experiments/semantic-layer-trial/source_manifest.json",
      sha256: sha256(selectionText),
    },
  });
  const serialized = serializeCorpusManifest(manifest);
  if (check) {
    if (!existsSync(OUTPUT_PATH)) throw new Error("corpus manifest is missing; rebuild it without --check");
    const existing = readFileSync(OUTPUT_PATH, "utf8");
    validateCorpusManifest(JSON.parse(existing));
    if (existing !== serialized) throw new Error("corpus manifest is stale; rebuild it without --check");
    console.log(`corpus manifest ok families=${manifest.source_family_count} records=${manifest.record_count}`);
    return manifest;
  }
  writeFileSync(OUTPUT_PATH, serialized, "utf8");
  console.log(`wrote corpus manifest families=${manifest.source_family_count} records=${manifest.record_count}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildAndWriteCorpusManifest({ check: process.argv.includes("--check") });
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
