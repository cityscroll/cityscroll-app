import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assertServePublishLookup,
  assertServePublishTwins,
  SERVE_LOOKUP_CONTRACTS,
  servePublishFindings,
} from "../warehouse/lib/serve_publish_contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED_SERVES = Object.freeze({
  ocp_awards: "ocp_awards_warehouse_lookup.json",
  zap_projects: "zap_projects_warehouse_lookup.json",
  zap_bbl: "zap_bbl_warehouse_lookup.json",
  doing_business: "doing_business_warehouse_lookup.json",
  city_record_pin_chain: "city_record_pin_chain_warehouse_lookup.json",
  payroll_title: "payroll_title_warehouse_lookup.json",
});

function canaryDoc(contract, stamped = "2026-08-18T00:00:00.000Z") {
  return {
    schema_version: 1,
    materialized_at: stamped,
    rows: contract.canaries.map((canary) => ({ [canary.field]: canary.value })),
  };
}

function timestampMs(doc, field = "materialized_at") {
  return Date.parse(String(doc?.[field] || ""));
}

/**
 * Reference clock for the committed-twin gate: the newest site/worker stamp.
 * A same-day refresh is in-window by construction, so this case cannot rot
 * against a frozen calendar day. Age and future guards are proven separately
 * against this derived now with synthetic docs.
 */
function referenceNowFromTwins(siteDoc, workerDoc, timestampField = "materialized_at") {
  const stamps = [timestampMs(siteDoc, timestampField), timestampMs(workerDoc, timestampField)].filter(
    Number.isFinite,
  );
  assert.ok(stamps.length, "serve twins have no parseable materialized_at");
  return new Date(Math.max(...stamps)).toISOString();
}

describe("warehouse serve publish contract", () => {
  it("declares an age window and named canaries for every committed serve", () => {
    assert.deepEqual(
      Object.keys(SERVE_LOOKUP_CONTRACTS).sort(),
      Object.keys(COMMITTED_SERVES).sort(),
    );
    for (const contract of Object.values(SERVE_LOOKUP_CONTRACTS)) {
      assert.ok(Number.isFinite(contract.max_age_days));
      assert.ok(contract.max_age_days > 0);
      assert.ok(contract.canaries.length > 0);
      assert.ok(contract.canaries.every((canary) => canary.field && canary.value));
    }
  });

  it("fails each serve after its declared maximum age", () => {
    for (const contract of Object.values(SERVE_LOOKUP_CONTRACTS)) {
      const doc = canaryDoc(contract);
      const inside = new Date(
        Date.parse(doc.materialized_at) + contract.max_age_days * 86_400_000,
      );
      assert.equal(servePublishFindings(doc, contract, { now: inside }).length, 0);

      const outside = new Date(inside.getTime() + 1);
      assert.throws(
        () => assertServePublishLookup(doc, contract, { now: outside }),
        /exceeds max/,
        contract.id,
      );
    }
  });

  it("fails each serve when a named canary is missing", () => {
    for (const contract of Object.values(SERVE_LOOKUP_CONTRACTS)) {
      const doc = canaryDoc(contract);
      doc.rows.shift();
      assert.throws(
        () => assertServePublishLookup(doc, contract, { now: doc.materialized_at }),
        /missing canary/,
        contract.id,
      );
    }
  });

  it("accepts the current committed twins within their recorded age windows", () => {
    for (const [id, filename] of Object.entries(COMMITTED_SERVES)) {
      const site = JSON.parse(readFileSync(join(ROOT, "site/data", filename), "utf8"));
      const worker = JSON.parse(
        readFileSync(join(ROOT, "worker/src/data", filename), "utf8"),
      );
      const contract = SERVE_LOOKUP_CONTRACTS[id];
      const now = referenceNowFromTwins(site, worker, contract.timestamp_field);
      assertServePublishTwins(site, worker, contract, { now });
    }
  });

  it("fails a twin stamped truly in the future or older than max_age_days relative to derived now", () => {
    for (const contract of Object.values(SERVE_LOOKUP_CONTRACTS)) {
      const current = canaryDoc(contract, "2026-08-20T08:00:00.000Z");
      const now = referenceNowFromTwins(current, current, contract.timestamp_field);
      assert.equal(servePublishFindings(current, contract, { now }).length, 0);

      const future = canaryDoc(
        contract,
        new Date(Date.parse(now) + 2 * 86_400_000).toISOString(),
      );
      assert.throws(
        () => assertServePublishTwins(future, future, contract, { now }),
        /in the future/,
        `${contract.id} future`,
      );

      const stale = canaryDoc(
        contract,
        new Date(Date.parse(now) - (contract.max_age_days + 1) * 86_400_000).toISOString(),
      );
      assert.throws(
        () => assertServePublishTwins(stale, stale, contract, { now }),
        /exceeds max/,
        `${contract.id} over-age`,
      );
    }
  });
});
