import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  buildCapabilitySemanticScoutReceipt,
  serializeReceipt,
} from "../tools/run_capability_semantic_scout.mjs";
import { verifyCapabilitySemanticScout } from "../tools/verify_capability_semantic_scout.mjs";

const FIXTURE = JSON.parse(readFileSync(
  new URL("fixtures/capability_semantic_scout.json", import.meta.url),
  "utf8",
));
const REQUIRED_REFERENCES = [
  "notice.search@1",
  "entity.dossier.get@1",
  "entity.relationships.get@1",
  "cited.passages.retrieve@1",
];

function check(receipt, reference) {
  return receipt.checks.find(({ capability_reference: candidate }) => candidate === reference);
}

test("local semantic scout proves the four registered civic capabilities", async () => {
  const receipt = await buildCapabilitySemanticScoutReceipt(FIXTURE);
  assert.equal(verifyCapabilitySemanticScout(receipt), true);
  assert.equal(receipt.status, "pass");
  assert.deepEqual(receipt.registry.map(({ reference }) => reference), REQUIRED_REFERENCES);
  assert.deepEqual(receipt.checks.map(({ capability_reference: reference }) => reference), REQUIRED_REFERENCES);
  assert.ok(receipt.checks.every(({ provider_parity: parity }) => parity.status === "pass"));
  assert.deepEqual(receipt.runtime_boundary, {
    network_calls: 0,
    model_calls: 0,
    browser_actions: 0,
    production_writes: 0,
    cloudflare_os_required: false,
    transport_imports: 0,
  });

  const notice = check(receipt, "notice.search@1").actual_projection;
  assert.equal(notice.availability, "complete");
  assert.deepEqual(notice.identity.request_ids, ["20260730002", "20260730001"]);
  assert.deepEqual(notice.freshness.publication_dates, ["2026-07-30", "2026-08-01"]);
  assert.equal(notice.counts.total_matches, 2);
  assert.equal(notice.bounds.returned <= notice.bounds.requested_limit, true);

  const dossier = check(receipt, "entity.dossier.get@1").actual_projection;
  assert.equal(dossier.identity.entity.id, "vendor:stem:ACME CONSTRUCTION");
  assert.equal(dossier.counts.linked_records, 2);
  assert.deepEqual(dossier.evidence.disagreement_facts, ["contract_amount", "start_date"]);
  assert.deepEqual(dossier.provenance.linked_sources, [
    "checkbook:CT-850-1",
    "city_record:20260730001",
  ]);

  const relationships = check(receipt, "entity.relationships.get@1").actual_projection;
  assert.equal(relationships.bounds.applied_fan_out, 12);
  assert.equal(relationships.counts.edges, 5);
  assert.ok(relationships.provenance.every(({ source_fields: fields }) => fields.length > 0));
  assert.ok(relationships.evidence.confidence.every((confidence) => !Object.hasOwn(confidence, "score")));

  const cited = check(receipt, "cited.passages.retrieve@1").actual_projection;
  assert.equal(cited.availability, "partial");
  assert.equal(cited.counts.citations, 1);
  assert.equal(cited.evidence.exact_joins[0].state, "matched");
  assert.equal(cited.evidence.exact_joins[0].passage_id, cited.identity.citation_ids[0]);
  assert.equal(cited.freshness[0].state, "observed");
  assert.ok(receipt.checks.every(({ actual_projection: projection }) => projection.public_redaction.passed));
});

test("unchanged runs are byte-identical and generated_at is outside the semantic digest", async () => {
  const first = await buildCapabilitySemanticScoutReceipt(FIXTURE);
  const second = await buildCapabilitySemanticScoutReceipt(FIXTURE);
  assert.equal(serializeReceipt(first), serializeReceipt(second));

  const later = await buildCapabilitySemanticScoutReceipt(FIXTURE, {
    generatedAt: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(first.actual_semantic_sha256, later.actual_semantic_sha256);
  assert.equal(first.expected_semantic_sha256, later.expected_semantic_sha256);
  const { generated_at: firstGeneratedAt, ...firstSemantic } = first;
  const { generated_at: laterGeneratedAt, ...laterSemantic } = later;
  assert.notEqual(firstGeneratedAt, laterGeneratedAt);
  assert.deepEqual(firstSemantic, laterSemantic);
});

test("seeded semantic corruptions fail with exact agent-readable JSON paths", async (t) => {
  const base = await buildCapabilitySemanticScoutReceipt(FIXTURE);
  const corruptions = [
    {
      name: "identity",
      path: "checks[0].actual_projection.identity.request_ids[0]",
      mutate(receipt) { receipt.checks[0].actual_projection.identity.request_ids[0] = "20260000000"; },
    },
    {
      name: "availability",
      path: "checks[1].actual_projection.availability",
      mutate(receipt) { receipt.checks[1].actual_projection.availability = "unavailable"; },
    },
    {
      name: "source provenance",
      path: "checks[1].actual_projection.provenance.linked_sources[0]",
      mutate(receipt) { receipt.checks[1].actual_projection.provenance.linked_sources[0] = "unknown:source"; },
    },
    {
      name: "citation exact join",
      path: "checks[3].actual_projection.evidence.exact_joins[0].state",
      mutate(receipt) { receipt.checks[3].actual_projection.evidence.exact_joins[0].state = "unknown"; },
    },
    {
      name: "edge vocabulary",
      path: "checks[2].actual_projection.evidence.edge_types[0]",
      mutate(receipt) { receipt.checks[2].actual_projection.evidence.edge_types[0] = "associated_with"; },
    },
    {
      name: "fan-out bound",
      path: "checks[2].actual_projection.bounds.applied_fan_out",
      mutate(receipt) { receipt.checks[2].actual_projection.bounds.applied_fan_out = 13; },
    },
    {
      name: "public score redaction",
      path: "checks[2].actual_projection.public_redaction.passed",
      mutate(receipt) {
        receipt.checks[2].actual_projection.public_redaction.passed = false;
        receipt.checks[2].actual_projection.public_redaction.forbidden_paths = ["graph.edges[0].confidence.score"];
      },
    },
    {
      name: "freshness",
      path: "checks[1].actual_projection.freshness.observed_through",
      mutate(receipt) { receipt.checks[1].actual_projection.freshness.observed_through = null; },
    },
    {
      name: "provider parity",
      path: "checks[0].provider_parity.status",
      mutate(receipt) { receipt.checks[0].provider_parity.status = "fail"; },
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, () => {
      const receipt = structuredClone(base);
      corruption.mutate(receipt);
      assert.throws(
        () => verifyCapabilitySemanticScout(receipt),
        (error) => error.message.includes(corruption.path),
      );
    });
  }
});

test("verifier CLI exits nonzero and prints the semantic JSON path", async () => {
  const receipt = await buildCapabilitySemanticScoutReceipt(FIXTURE);
  receipt.checks[3].actual_projection.evidence.exact_joins[0].state = "unknown";
  const directory = mkdtempSync(join(tmpdir(), "crol-semantic-scout-"));
  const path = join(directory, "corrupt.json");
  try {
    writeFileSync(path, JSON.stringify(receipt), "utf8");
    const result = spawnSync(
      process.execPath,
      [new URL("../tools/verify_capability_semantic_scout.mjs", import.meta.url).pathname, path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /checks\[3\]\.actual_projection\.evidence\.exact_joins\[0\]\.state/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scout source imports providers directly and contains no runtime transport path", () => {
  const source = readFileSync(new URL("../tools/run_capability_semantic_scout.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(([, specifier]) => specifier);
  assert.equal(imports.some((specifier) => /(?:mcp|cloudflare|agents)/i.test(specifier)), false);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bWebSocket\b|chrome|playwright|puppeteer/i);
});
