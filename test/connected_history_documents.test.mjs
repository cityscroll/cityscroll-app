import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CONNECTED_HISTORY_DOCUMENTS_PARSER_VERSION,
  CONNECTED_HISTORY_DOCUMENTS_SCHEMA,
  CONNECTED_HISTORY_DOCUMENTS_TRANSPORT,
  CONNECTED_HISTORY_DOCUMENT_SOURCES,
  CONNECTED_HISTORY_DOT_SELECTOR_MANIFEST_SCHEMA,
  DATE_KINDS,
  DOT_PARENT_URL,
  acquireConnectedHistoryDocuments,
  assertRetainedObservationsHaveFetchReceipts,
  assertNotOpenConsultation,
  assertRetentionBoundaries,
  buildDotSelectorManifest,
  createLiveHttpGet,
  resolveDotAttachmentSelector,
} from "../tools/lib/connected_history_documents.mjs";
import {
  createFixtureHttpGet,
  fixtureParentHtml,
} from "./fixtures/connected_history_documents/http_fixture_map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB_SOURCE = readFileSync(
  join(ROOT, "tools/lib/connected_history_documents.mjs"),
  "utf8",
);
const BUILDER_SOURCE = readFileSync(
  join(ROOT, "tools/build_connected_history_documents.mjs"),
  "utf8",
);
const committed = JSON.parse(
  readFileSync(join(ROOT, "site/data/connected_history_documents.json"), "utf8"),
);
const committedReceipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/connected_history_sources/verification_receipts/connected_history_documents_latest.json",
    ),
    "utf8",
  ),
);

test("A1 retains every fixed dossier source or an explicit failure receipt", async () => {
  const httpGet = createFixtureHttpGet();
  const { artifact, receipt } = await acquireConnectedHistoryDocuments({
    httpGet,
    observedAt: "2026-09-18T00:00:00.000Z",
  });

  assert.equal(artifact.schema, CONNECTED_HISTORY_DOCUMENTS_SCHEMA);
  assert.equal(artifact.observations.length, CONNECTED_HISTORY_DOCUMENT_SOURCES.length);
  assert.equal(artifact.counts.sources, CONNECTED_HISTORY_DOCUMENT_SOURCES.length);
  assert.equal(
    artifact.counts.retained + artifact.counts.acquisition_failures,
    artifact.counts.sources,
  );

  for (const source of CONNECTED_HISTORY_DOCUMENT_SOURCES) {
    const row = artifact.observations.find((item) => item.source_id === source.source_id);
    assert.ok(row, `missing observation for ${source.source_id}`);
    assert.ok(row.resolved_url || row.reason, "resolved URL or failure reason required");
    assert.ok(row.source_span?.locator, "source span required");
    assert.ok(row.publication?.precision, "publication precision required");
    assert.equal(row.observation_time, "2026-09-18T00:00:00.000Z");
    if (row.retained) {
      assert.match(row.content_hash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(row.status, "retained");
    } else {
      assert.equal(row.content_hash, null);
      assert.equal(row.retained, false);
      assert.ok(row.reason);
    }
  }

  assert.equal(
    artifact.dot_selector_manifest.schema,
    CONNECTED_HISTORY_DOT_SELECTOR_MANIFEST_SCHEMA,
  );
  assert.ok(artifact.dot_selector_manifest.entry_count >= 5);
  assert.equal(
    artifact.dot_selector_manifest.resolved_count,
    artifact.dot_selector_manifest.entries.filter((row) => row.status === "resolved").length,
  );
  assert.equal(receipt.checkpointed, true);
  assert.equal(receipt.max_retries, CONNECTED_HISTORY_DOCUMENTS_TRANSPORT.maxRetries);
  assert.equal(receipt.acquisition_mode, "injected");
  assert.ok(receipt.request_count > 0);
  assert.equal(receipt.parser_version, CONNECTED_HISTORY_DOCUMENTS_PARSER_VERSION);
});

test("A1 committed corpus is explicitly live-retrieved or failed", () => {
  assert.equal(committedReceipt.acquisition_mode, "live");
  assert.equal(committedReceipt.checkpointed, true);
  assert.ok(Number.isInteger(committedReceipt.request_timeout_ms));
  assert.ok(Number.isInteger(committedReceipt.request_count));
  assert.equal(
    committed.counts.retained + committed.counts.acquisition_failures,
    committed.counts.sources,
  );
  for (const row of committed.observations) {
    assert.ok(["retrieved", "failed"].includes(row.provenance));
    if (row.provenance === "retrieved") {
      assert.equal(row.status, "retained");
      assert.equal(row.request_receipt.outcome, "ok");
      assert.equal(row.content_hash, row.request_receipt.content_hash);
      assert.equal(row.byte_count, row.request_receipt.byte_count);
      assert.equal(row.source_span.located, true);
    } else {
      assert.equal(row.status, "acquisition_failure");
      assert.equal(row.retained, false);
      assert.equal(row.content_hash, null);
    }
  }
  assertRetainedObservationsHaveFetchReceipts(committed.observations);
});

test("builder refuses a retained record without a successful fetch receipt", () => {
  assert.throws(
    () => assertRetainedObservationsHaveFetchReceipts([
      {
        source_id: "missing-receipt",
        retained: true,
        request_receipt: null,
      },
    ]),
    /successful fetch receipt/,
  );
});

test("A2 refuses a second board scraper, BSA calendar, or consultation conversion", () => {
  assert.equal(committed.boundaries.board_scraper, false);
  assert.equal(committed.boundaries.bsa_calendar, false);
  assert.equal(committed.boundaries.historical_presentations_as_consultations, false);
  assert.doesNotThrow(() => assertRetentionBoundaries(LIB_SOURCE));
  assert.doesNotThrow(() => assertRetentionBoundaries(BUILDER_SOURCE));
  assert.equal(/from\s+["'][^"']*bsa_calendar/.test(LIB_SOURCE), false);
  assert.equal(/acquireConsultationSources\s*\(/.test(LIB_SOURCE), false);
  assert.equal(/import\s+[^;]*parseBsaAgendaPages/.test(BUILDER_SOURCE), false);

  for (const source of CONNECTED_HISTORY_DOCUMENT_SOURCES.filter((row) => row.publisher === "dot")) {
    assert.equal(source.consultation, false);
    assert.doesNotThrow(() => assertNotOpenConsultation(source));
  }
  assert.throws(
    () => assertNotOpenConsultation({ source_id: "bad", publisher: "dot" }),
    /consultation=false/,
  );
});

test("A3 document-version case keeps successive CEQR identities distinct", async () => {
  const httpGet = createFixtureHttpGet();
  const { artifact } = await acquireConnectedHistoryDocuments({
    httpGet,
    observedAt: "2026-09-18T00:00:00.000Z",
  });
  const iceCenter = artifact.observations.find(
    (row) => row.source_id === "kingsbridge-ceqr-13dme013x-page",
  );
  const redevelopment = artifact.observations.find(
    (row) => row.source_id === "kingsbridge-ceqr-25dme006x-findings",
  );
  assert.ok(iceCenter?.retained);
  assert.ok(redevelopment?.retained);
  assert.notEqual(iceCenter.content_hash, redevelopment.content_hash);
  assert.deepEqual(iceCenter.subject_ids, ["ceqr:13DME013X"]);
  assert.deepEqual(redevelopment.subject_ids, ["ceqr:25DME006X"]);
  assert.equal(iceCenter.publication.value, "2013");
  assert.equal(redevelopment.publication.value, "2025-10-01");
});

test("A3 internal-date case distinguishes publication, section, and observation time", async () => {
  const httpGet = createFixtureHttpGet();
  const { artifact } = await acquireConnectedHistoryDocuments({
    httpGet,
    observedAt: "2026-09-18T12:00:00.000Z",
  });
  const iceCenter = artifact.observations.find(
    (row) => row.source_id === "kingsbridge-ceqr-13dme013x-page",
  );
  assert.equal(iceCenter.publication.kind, "document_publication");
  assert.equal(iceCenter.publication.value, "2013");
  assert.equal(iceCenter.internal_dates[0].kind, "internal_section");
  assert.equal(iceCenter.internal_dates[0].value, "2018");
  assert.match(iceCenter.internal_dates[0].note, /forecast/i);
  assert.equal(iceCenter.observation_time, "2026-09-18T12:00:00.000Z");
  assert.notEqual(iceCenter.publication.value, iceCenter.internal_dates[0].value);
  assert.notEqual(iceCenter.publication.value, iceCenter.observation_time.slice(0, 4));
  for (const kind of DATE_KINDS) {
    assert.ok(
      [
        iceCenter.publication.kind,
        ...iceCenter.internal_dates.map((row) => row.kind),
        "observation",
      ].includes(kind) || kind === "observation",
    );
  }
  assert.equal(iceCenter.observation_time.slice(0, 10), "2026-09-18");
});

test("A3 selector-mismatch case records failure and never retains evidence", () => {
  const html = fixtureParentHtml().replace("June 2024 CB2", "June 2024 other label");
  const resolution = resolveDotAttachmentSelector(html, {
    heading: "Sixth Avenue, Lispenard Street to West 14th Street",
    link_label: "June 2024 CB2",
  });
  assert.equal(resolution.status, "selector_mismatch");
  assert.equal(resolution.resolved_url, null);

  const manifest = buildDotSelectorManifest(html, {
    observedAt: "2026-09-18T00:00:00.000Z",
    sources: CONNECTED_HISTORY_DOCUMENT_SOURCES.filter(
      (row) => row.source_id === "sixth-avenue-june-2024-cb2",
    ),
  });
  assert.equal(manifest.mismatch_count, 1);
  assert.equal(manifest.resolved_count, 0);
});

test("A3 retrieval-failure case yields failure receipt, not retained evidence", async () => {
  const httpGet = createFixtureHttpGet({
    "https://edc.nyc/project/lighthouse-point": {
      status: 404,
      bytes: Buffer.from("missing"),
      contentType: "text/plain",
    },
  });
  const { artifact, receipt } = await acquireConnectedHistoryDocuments({
    httpGet,
    observedAt: "2026-09-18T00:00:00.000Z",
  });
  const row = artifact.observations.find(
    (item) => item.source_id === "lighthouse-point-project-page",
  );
  assert.equal(row.retained, false);
  assert.equal(row.status, "acquisition_failure");
  assert.equal(row.reason, "retrieval_failure");
  assert.equal(row.content_hash, null);
  assert.ok(receipt.failures.some((item) => item.source_id === row.source_id));
  assert.ok(!artifact.observations.filter((item) => item.retained).some((item) => item.source_id === row.source_id));
});

test("A3 bounded acquisition run checkpoints, retries, and emits receipts", async () => {
  let attempts = 0;
  const base = createFixtureHttpGet();
  const flaky = async (url) => {
    if (url === "https://edc.nyc/project/lighthouse-point") {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("temporary upstream reset");
        throw err;
      }
    }
    return base(url);
  };
  flaky.calls = base.calls;

  const first = await acquireConnectedHistoryDocuments({
    httpGet: flaky,
    observedAt: "2026-09-18T00:00:00.000Z",
    maxRetries: 2,
  });
  assert.ok(first.checkpoint.completed_source_ids.includes("lighthouse-point-project-page"));
  assert.ok(first.requestGraph.some((row) => row.retries >= 1 || row.reason?.includes("temporary")));
  assert.equal(first.receipt.checkpointed, true);
  assert.equal(first.receipt.max_retries, 2);

  const resumeHttp = createFixtureHttpGet({
    [DOT_PARENT_URL]: async () => {
      throw new Error("parent should not be refetched when checkpoint carries html");
    },
  });
  // Drop one completed observation to prove resume fills only the gap.
  const checkpoint = {
    ...first.checkpoint,
    observations: first.checkpoint.observations.filter(
      (row) => row.source_id !== "lighthouse-point-opening-announcement",
    ),
  };
  checkpoint.completed_source_ids = checkpoint.observations.map((row) => row.source_id);

  const resumed = await acquireConnectedHistoryDocuments({
    httpGet: resumeHttp,
    observedAt: "2026-09-18T00:00:00.000Z",
    checkpoint,
  });
  assert.ok(
    resumed.artifact.observations.some(
      (row) => row.source_id === "lighthouse-point-opening-announcement" && row.retained,
    ),
  );
  assert.equal(
    resumeHttp.calls.includes(DOT_PARENT_URL),
    false,
    "checkpointed parent html must prevent a second parent fetch",
  );
});

test("A3 live transport fixture server covers success, 404, timeout, and selector mismatch", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/parent") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h2>Fixture corridor</h2><a href=\"/success\">different label</a>");
      return;
    }
    if (request.url === "/success") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("success body");
      return;
    }
    if (request.url === "/missing") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    if (request.url === "/timeout") {
      setTimeout(() => response.end("too late"), 100);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const template = CONNECTED_HISTORY_DOCUMENT_SOURCES[0];
    const dotTemplate = CONNECTED_HISTORY_DOCUMENT_SOURCES.find((row) => row.kind === "dot_selector");
    const sources = [
      { ...template, source_id: "fixture-success", url: `${base}/success`, source_span: { locator: "body", quote: "success body" } },
      { ...template, source_id: "fixture-404", url: `${base}/missing` },
      { ...template, source_id: "fixture-timeout", url: `${base}/timeout` },
      { ...dotTemplate, source_id: "fixture-selector-mismatch", parent_url: `${base}/parent`, selector: { heading: "Fixture corridor", link_label: "expected label" } },
    ];
    const { artifact, requestGraph } = await acquireConnectedHistoryDocuments({
      httpGet: createLiveHttpGet(),
      sources,
      observedAt: "2026-09-21T00:00:00.000Z",
      maxRetries: 0,
      requestTimeoutMs: 20,
    });
    const byId = new Map(artifact.observations.map((row) => [row.source_id, row]));
    assert.equal(byId.get("fixture-success").provenance, "retrieved");
    assert.equal(byId.get("fixture-404").reason, "retrieval_failure");
    assert.equal(byId.get("fixture-timeout").reason, "retrieval_failure");
    assert.equal(byId.get("fixture-selector-mismatch").reason, "link_label_not_found_under_heading");
    assert.equal(requestGraph.length, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("A4 stays inside the fixed dossier and reports missing strata honestly", () => {
  const publishers = new Set(CONNECTED_HISTORY_DOCUMENT_SOURCES.map((row) => row.publisher));
  assert.deepEqual([...publishers].sort(), ["ceqr", "dot", "edc"]);
  assert.equal(committed.source_policy, "fixed-six-case-dossier-ceqr-dot-edc-only");
  assert.equal(
    CONNECTED_HISTORY_DOCUMENT_SOURCES.some((row) => /board|bsa|consultation/i.test(row.source_id)),
    false,
  );
  // Insufficient retained evidence is a reportable outcome, never a quota.
  assert.ok("acquisition_failures" in committed.counts);
  assert.ok(Number.isInteger(committed.counts.retained));
});
