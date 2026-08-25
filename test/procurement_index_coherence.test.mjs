import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildProcurementArtifacts } from "../tools/build_shared_procurement_read_model.mjs";
import { readSharedProcurementReadModel } from "../tools/lib/procurement_read_model_io.mjs";
import {
  PROCUREMENT_INDEX_COHERENCE_SCHEMA,
  advertisedProcurementRefs,
  attachCoherenceReceipt,
  attachKeywordCoherenceReceipt,
  checkProcurementIndexCoherence,
  sourceModelFingerprint,
} from "../tools/lib/procurement_index_coherence.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_index_coherence/index_only_object.json", import.meta.url),
  "utf8",
));
const checker = fileURLToPath(new URL("../tools/check_procurement_index_coherence.mjs", import.meta.url));

function keywordIndexFromDocuments(documents, receiptHost = null) {
  const index = {
    schema: "cityscroll.keyword_search_index.v1",
    generated_at: fixture.read_model.generated_at,
    families: {
      procurements: {
        source: "PASSPort, Checkbook NYC, and City Record procurement observations",
        documents,
        coverage: [{ state: "matched", indexed_count: documents.length }],
      },
    },
  };
  return receiptHost ? attachKeywordCoherenceReceipt({ readModel: receiptHost, keywordIndex: index }) : index;
}

function coherentPair({ extraRows = [], extraDocuments = [], fingerprint = "fp-coherent" } = {}) {
  const readModel = attachCoherenceReceipt({
    ...fixture.read_model,
    rows: [...fixture.read_model.rows, ...extraRows],
  }, {
    sourceModelFingerprint: fingerprint,
    advertisedRefs: [
      ...fixture.keyword_documents.map((document) => document.object_ref),
      ...extraDocuments.map((document) => document.object_ref),
    ],
    selectedRowCount: fixture.read_model.publication.selected_rows,
  });
  const keywordIndex = keywordIndexFromDocuments(
    [...fixture.keyword_documents, ...extraDocuments],
    readModel,
  );
  return { readModel, keywordIndex };
}

test("coherent served model and keyword family pass the build check", () => {
  const { readModel, keywordIndex } = coherentPair();
  const result = checkProcurementIndexCoherence({ readModel, keywordIndex });
  assert.equal(result.ok, true, format(result));
  assert.equal(readModel.coherence_receipt.schema, PROCUREMENT_INDEX_COHERENCE_SCHEMA);
  assert.equal(keywordIndex.coherence_receipt.source_model_fingerprint, "fp-coherent");
  assert.equal(keywordIndex.coherence_receipt.generated_at, fixture.read_model.generated_at);
  assert.equal(keywordIndex.coherence_receipt.selected_row_count, 1);
  assert.ok(keywordIndex.coherence_receipt.artifact_hashes.shared_procurement_read_model);
  assert.ok(keywordIndex.coherence_receipt.artifact_hashes.keyword_search_procurements);
  assert.deepEqual(readModel.coherence_receipt, keywordIndex.coherence_receipt);
});

test("an index-only advertised object fails the build check", () => {
  const { readModel } = coherentPair();
  const keywordIndex = keywordIndexFromDocuments(
    [...fixture.keyword_documents, fixture.index_only_document],
    readModel,
  );
  const result = checkProcurementIndexCoherence({ readModel, keywordIndex });
  assert.equal(result.ok, false);
  assert.ok(result.index_only.includes("procurement:contract:CT-ABSENT"));
  assert.ok(result.findings.some((item) => item.code === "index_only_advertised"));
  assert.ok(result.findings.some((item) => item.code === "artifact_hash_mismatch"));
});

test("a suppressed served object may be absent from the index", () => {
  const { readModel, keywordIndex } = coherentPair({ extraRows: [fixture.suppressed_row] });
  const result = checkProcurementIndexCoherence({ readModel, keywordIndex });
  assert.equal(result.ok, true, format(result));
  assert.equal(result.served_count, 2);
  assert.equal(result.advertised_count, 1);
  assert.deepEqual(result.index_only, []);
});

test("the committed procurement model and keyword index stay coherent", () => {
  const readModel = readSharedProcurementReadModel(
    new URL("../site/data/shared_procurement_read_model.json", import.meta.url),
  );
  const keywordIndex = JSON.parse(readFileSync(
    new URL("../worker/src/data/keyword_search_index.json", import.meta.url),
    "utf8",
  ));
  const spineBytes = readFileSync(new URL("../site/data/procurement_spine_sources.json", import.meta.url));
  const awardsBytes = readFileSync(new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url));
  const result = checkProcurementIndexCoherence({
    readModel,
    keywordIndex,
    spineBytes,
    awardsBytes,
  });
  assert.equal(result.ok, true, format(result));
  assert.equal(readModel.coherence_receipt.schema, PROCUREMENT_INDEX_COHERENCE_SCHEMA);
  assert.deepEqual(readModel.coherence_receipt, keywordIndex.coherence_receipt);
  assert.equal(
    readModel.coherence_receipt.source_model_fingerprint,
    sourceModelFingerprint({ spineBytes, awardsBytes }),
  );
  assert.equal(
    advertisedProcurementRefs(keywordIndex).length,
    buildProcurementSearchDocuments(readModel).documents.length,
  );
});

test("the procurement builder stamps a coherence receipt from source bytes", () => {
  const { model } = buildProcurementArtifacts({
    generated_at: "2026-08-18T04:05:51.552Z",
    rows: { checkbook_contracts: [], passport_contracts: [] },
  }, { rows: [] }, {
    spineBytes: Buffer.from("spine-source"),
    awardsBytes: Buffer.from("awards-source"),
  });
  assert.equal(model.coherence_receipt.schema, PROCUREMENT_INDEX_COHERENCE_SCHEMA);
  assert.equal(
    model.coherence_receipt.source_model_fingerprint,
    sourceModelFingerprint({
      spineBytes: Buffer.from("spine-source"),
      awardsBytes: Buffer.from("awards-source"),
    }),
  );
  assert.equal(model.coherence_receipt.generated_at, "2026-08-18T04:05:51.552Z");
  assert.equal(model.coherence_receipt.selected_row_count, 0);
  assert.ok(model.coherence_receipt.artifact_hashes.shared_procurement_read_model);
  assert.ok(model.coherence_receipt.artifact_hashes.keyword_search_procurements);
});

test("the deploy check CLI fails on an index-only fixture", () => {
  const { readModel } = coherentPair();
  const keywordIndex = keywordIndexFromDocuments(
    [...fixture.keyword_documents, fixture.index_only_document],
    readModel,
  );
  const root = mkdtempSync(join(tmpdir(), "procurement-index-coherence-"));
  try {
    const modelPath = join(root, "read-model.json");
    const indexPath = join(root, "keyword-index.json");
    writeFileSync(modelPath, JSON.stringify(readModel));
    writeFileSync(indexPath, JSON.stringify(keywordIndex));
    const result = spawnSync(process.execPath, [
      checker,
      "--read-model", modelPath,
      "--keyword-index", indexPath,
      "--skip-source-fingerprint",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /index_only_advertised/);
    assert.match(result.stderr, /procurement:contract:CT-ABSENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function format(result) {
  return (result.findings || []).map((item) => `${item.code}: ${item.message}`).join("; ");
}
