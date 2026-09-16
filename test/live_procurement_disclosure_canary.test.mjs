// Post-deploy / production-only canary for complete procurement disclosure
// reader-proof obligations. Explicit opt-in keeps the required offline glob
// free of live network reads.
//
//   LIVE_PROCUREMENT_DISCLOSURE_CANARY=1 \
//   CITYSCROLL_DISCLOSURE_BROWSER=1 \
//   node --test test/live_procurement_disclosure_canary.test.mjs
//
// Or collect and require readiness:
//   node tools/capture_procurement_disclosure_production_proof.mjs --production --require-ready

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionReadback,
  collectProductionReadback,
} from "../tools/capture_procurement_disclosure_production_proof.mjs";

if (process.env.LIVE_PROCUREMENT_DISCLOSURE_CANARY !== "1") {
  test("production disclosure canary skipped without LIVE_PROCUREMENT_DISCLOSURE_CANARY=1", () => {});
} else {
  test("production disclosure read-back collects required obligations and reports readiness", async () => {
    const site = (process.env.CITYSCROLL_PROCUREMENT_BASE_URL || "https://cityscroll.org").replace(/\/$/, "");
    const api = (process.env.CITYSCROLL_PROCUREMENT_API_BASE_URL || "https://api.cityscroll.org").replace(/\/$/, "");
    const envelope = await collectProductionReadback({
      site,
      api,
      pagesDeploy: process.env.CITYSCROLL_PAGES_DEPLOY_COMMIT
        ? {
          head_sha: process.env.CITYSCROLL_PAGES_DEPLOY_COMMIT,
          updated_at: process.env.CITYSCROLL_PAGES_DEPLOY_COMPLETED_AT || null,
          html_url: process.env.CITYSCROLL_PAGES_DEPLOY_URL || null,
        }
        : null,
      collectBrowser: process.env.CITYSCROLL_DISCLOSURE_BROWSER !== "0",
    });
    assertProductionReadback(envelope, { requireReady: false });
    assert.ok(envelope.failure_reasons || envelope.production_readiness.failure_reasons);
    assert.equal(typeof envelope.production_readiness.ready, "boolean");
    assert.ok(envelope.served_identity.observer_revision);
    // Promotional readiness is gated separately from structural collection.
    if (process.env.CITYSCROLL_DISCLOSURE_REQUIRE_READY === "1") {
      assertProductionReadback(envelope, { requireReady: true });
    }
  });
}
