import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  REFRESH_FRACTION,
  WAREHOUSE_SERVE_LOOKUPS,
  isServeLookupDue,
  planServeLookupRefresh,
  runServeLookupRefresh,
  serveAgeDays,
} from "../ops/first-class-refresh/refresh-warehouse-serve-lookups.mjs";
import {
  SERVE_LOOKUP_CONTRACTS,
  assertServePublishLookup,
  servePublishFindings,
} from "../warehouse/lib/serve_publish_contract.mjs";

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix = "warehouse-serve-refresh-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeServeDoc(root, relativePath, doc) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}

function canaryDoc(contract, stamped) {
  return {
    schema_version: 1,
    materialized_at: stamped,
    row_count: contract.canaries.length,
    project_count: contract.canaries.length,
    rows: contract.canaries.map((canary) => ({ [canary.field]: canary.value })),
  };
}

describe("warehouse serve lookup scheduled refresh", () => {
  it("lists the seven CI-gated warehouse serve builders", () => {
    const ids = WAREHOUSE_SERVE_LOOKUPS.map((row) => row.id).sort();
    assert.deepEqual(ids, [
      "city_record_pin_chain",
      "doing_business",
      "e_designation",
      "later_housing_activity",
      "ocp_awards",
      "zap_bbl",
      "zap_projects",
    ]);
    assert.equal(REFRESH_FRACTION, 0.5);
  });

  it("marks a serve lookup due once its stamp ages past half its max age", () => {
    const root = tempRoot();
    const contract = SERVE_LOOKUP_CONTRACTS.zap_bbl;
    const stamped = "2026-08-01T00:00:00.000Z";
    writeServeDoc(root, "site/data/zap_bbl_warehouse_lookup.json", canaryDoc(contract, stamped));
    const now = new Date(
      Date.parse(stamped) + (contract.max_age_days * REFRESH_FRACTION + 1) * 86_400_000,
    );
    const entry = WAREHOUSE_SERVE_LOOKUPS.find((row) => row.id === "zap_bbl");
    const verdict = isServeLookupDue(entry, { root, now });
    assert.equal(verdict.due, true);
    assert.equal(verdict.reason, "past_refresh_fraction");
    assert.ok(serveAgeDays(canaryDoc(contract, stamped), contract, now) > contract.max_age_days * REFRESH_FRACTION);
  });

  it("positive control: refresh path regenerates a lookup older than its max age", () => {
    const root = tempRoot();
    const contract = SERVE_LOOKUP_CONTRACTS.zap_bbl;
    const staleStamp = "2026-07-01T00:00:00.000Z";
    const freshStamp = "2026-10-05T12:00:00.000Z";
    const sitePath = "site/data/zap_bbl_warehouse_lookup.json";
    writeServeDoc(root, sitePath, canaryDoc(contract, staleStamp));

    const now = new Date("2026-10-05T12:00:00.000Z");
    assert.ok(
      servePublishFindings(canaryDoc(contract, staleStamp), contract, { now }).some((f) =>
        /exceeds max/.test(f),
      ),
      "precondition: stale stamp fails the serve-publish age gate",
    );

    const receipt = runServeLookupRefresh({
      root,
      now,
      force: false,
      runBuilder(entry) {
        if (entry.id === "zap_bbl") {
          writeServeDoc(root, sitePath, canaryDoc(contract, freshStamp));
          return { status: "succeeded", detail: "rewrote_stale_lookup" };
        }
        if (entry.kind === "digest") {
          return { status: "succeeded", detail: "dependency_digest_rebuild" };
        }
        return { status: "skipped", detail: "not_under_test" };
      },
    });

    assert.equal(receipt.status, "ok");
    const zap = receipt.commands.find((row) => row.id === "zap_bbl");
    assert.equal(zap.status, "succeeded");
    assert.equal(zap.reason, "over_max_age");
    const refreshed = JSON.parse(readFileSync(join(root, sitePath), "utf8"));
    assert.equal(refreshed.materialized_at, freshStamp);
    assert.equal(servePublishFindings(refreshed, contract, { now }).length, 0);

    const digests = receipt.commands.filter((row) =>
      row.id === "e_designation" || row.id === "later_housing_activity",
    );
    assert.ok(digests.every((row) => row.status === "succeeded"));
    assert.ok(digests.every((row) => row.reason === "dependency_refreshed"));
  });

  it("positive control: --check-equivalent serve gate still fails a stale stamp", () => {
    const contract = SERVE_LOOKUP_CONTRACTS.ocp_awards;
    const stale = canaryDoc(contract, "2026-08-01T00:00:00.000Z");
    const now = new Date("2026-10-05T00:00:00.000Z");
    assert.throws(
      () => assertServePublishLookup(stale, contract, { now }),
      /exceeds max/,
    );
  });

  it("plans digests only after a dependency refresh", () => {
    const root = tempRoot();
    const now = new Date("2026-10-05T12:00:00.000Z");
    for (const entry of WAREHOUSE_SERVE_LOOKUPS.filter((row) => row.kind === "serve")) {
      const contract = SERVE_LOOKUP_CONTRACTS[entry.contract_id];
      writeServeDoc(
        root,
        entry.site_path,
        canaryDoc(contract, "2026-10-05T00:00:00.000Z"),
      );
    }
    const idle = planServeLookupRefresh({ root, now });
    assert.equal(idle.due_count, 0);
    assert.ok(idle.lookups.every((row) => row.kind !== "digest" || row.reason === "digest_idle"));

    writeServeDoc(
      root,
      "site/data/zap_bbl_warehouse_lookup.json",
      canaryDoc(SERVE_LOOKUP_CONTRACTS.zap_bbl, "2026-07-01T00:00:00.000Z"),
    );
    const plan = planServeLookupRefresh({ root, now });
    const dueIds = plan.lookups.filter((row) => row.due).map((row) => row.id).sort();
    assert.deepEqual(dueIds, ["e_designation", "later_housing_activity", "zap_bbl"]);
  });
});
