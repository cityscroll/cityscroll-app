import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_RULES_BYTES,
  PRODUCER,
  RECEIPT_SCHEMA,
  runPrioritySourceObservations,
} from "../tools/priority_source_observation_producers.mjs";

const NOW = "2026-09-13T14:00:00.000Z";
const RESULT = "2026-09-13T14:00:02.000Z";

function readReceipt(directory, name) {
  return JSON.parse(readFileSync(join(directory, name), "utf8"));
}

test("bounded priority observations retain successful acquisition receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cityscroll-priority-observations-"));
  try {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (String(url).includes("legistar")) {
        return new Response(JSON.stringify([{ EventId: 101, EventDate: NOW }]), {
          status: 200,
          headers: { "last-modified": "Sat, 13 Sep 2026 13:59:00 GMT" },
        });
      }
      return new Response("<rss><channel><item><title>Rules update</title></item></channel></rss>", {
        status: 200,
        headers: { "last-modified": "Sat, 13 Sep 2026 13:58:00 GMT" },
      });
    };

    const results = await runPrioritySourceObservations({
      now: NOW,
      clock: () => RESULT,
      fetchImpl,
      token: "test-token",
      receiptDir: directory,
    });

    assert.deepEqual(results.map((row) => row.status), ["succeeded", "succeeded"]);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /Events/);
    assert.match(calls[0].url, /token=test-token/);
    assert.equal(calls[1].options.headers["User-Agent"].startsWith("CityScrollBot/"), true);

    const legistar = readReceipt(directory, "priority_source_nyc_council_legistar_latest.json");
    const rules = readReceipt(directory, "priority_source_nyc_rules_rss_latest.json");
    for (const receipt of [legistar, rules]) {
      assert.equal(receipt.schema, RECEIPT_SCHEMA);
      assert.equal(receipt.status, "succeeded");
      assert.equal(receipt.attempt_at, NOW);
      assert.equal(receipt.result_at, RESULT);
      assert.equal(receipt.observed_at, RESULT);
      assert.equal(receipt.producer, PRODUCER);
      assert.equal(receipt.input_vintage.endsWith("Z"), true);
      assert.equal(receipt.provenance.evidence_class, "scheduled-rail");
      assert.equal(receipt.provenance.isolated, false);
    }
    assert.equal(legistar.source_contract_id, "nyc-council-legistar");
    assert.equal(rules.source_contract_id, "nyc-rules-rss");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded observation rejects an oversized Rules RSS response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cityscroll-priority-observations-"));
  try {
    const result = await runPrioritySourceObservations({
      sourceIds: ["nyc-rules-rss"],
      now: NOW,
      clock: () => RESULT,
      receiptDir: directory,
      fetchImpl: async () => new Response(`<rss><channel><item>${"x".repeat(MAX_RULES_BYTES)}</item></channel></rss>`, { status: 200 }),
    });
    assert.deepEqual(result.map((row) => row.status), ["failed"]);
    const receipt = readReceipt(directory, "priority_source_nyc_rules_rss_latest.json");
    assert.equal(receipt.event_kind, "failed-check");
    assert.match(receipt.exact_error, /bounded byte limit/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
