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
});

function canaryDoc(contract, stamped = "2026-08-18T00:00:00.000Z") {
  return {
    schema_version: 1,
    materialized_at: stamped,
    rows: contract.canaries.map((canary) => ({ [canary.field]: canary.value })),
  };
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
      assertServePublishTwins(site, worker, SERVE_LOOKUP_CONTRACTS[id], {
        now: "2026-08-18T12:00:00.000Z",
      });
    }
  });
});
