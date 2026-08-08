import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Characterization: ZAP land outcomes (decision docs + disposition votes + DOB BBL).
//
// Real field cases from 2026-07-30 ZAP API / Open Data samples
// (test/fixtures/zap_outcomes/). Proves strict project_id join, document proxy URLs,
// useful-outcome detection, DOB exact-BBL side-car, and measured usefulness.
//
//   node --test test/zap_outcomes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  joinProjectId,
  joinOpenDataToZapOutcome,
  joinDobFilingsToBbls,
  parseZapApiProject,
  documentProxyUrl,
  normProjectId,
  outcomeIsFilled,
  ZAP_API_BASE,
} from "../worker/src/lib/zap_outcomes.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test/fixtures/zap_outcomes");
const cases = JSON.parse(readFileSync(join(FIX, "join_cases.json"), "utf8"));
const receipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/zap_outcome_sources/verification_receipts/zap_api_outcomes_2026-07-30.json",
    ),
    "utf8",
  ),
);

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}

test("join measurement topline clears usefulness threshold", () => {
  const m = cases.join_measurement_topline;
  assert.ok(m.ulurp_complete_useful_rate >= 0.3);
  assert.ok(m.mixed_any_documents_rate >= 0.3);
  assert.ok(m.dob_any_filing_rate >= 0.3);
  assert.equal(m.usefulness_threshold, 0.3);
});

test("normProjectId and exact project_id join", () => {
  assert.equal(normProjectId("2022M0258"), "2022M0258");
  assert.equal(normProjectId(" p2018x0210 "), "P2018X0210");
  assert.deepEqual(joinProjectId("2022M0258", "2022M0258"), {
    method: "exact_project_id",
    project_id: "2022M0258",
  });
  assert.equal(joinProjectId("2022M0258", "2022M0259"), null);
  assert.equal(joinProjectId("", "2022M0258"), null);
});

test("documentProxyUrl builds public ZAP document links", () => {
  const url = documentProxyUrl("disposition", "/01QY2C5KIBZCEY6GXBF5GYXG77TTQVOFUG");
  assert.equal(
    url,
    `${ZAP_API_BASE}/document/disposition/01QY2C5KIBZCEY6GXBF5GYXG77TTQVOFUG`,
  );
  assert.equal(documentProxyUrl("artifact", "../etc/passwd"), null);
  assert.equal(documentProxyUrl("", "abc"), null);
});

test("field-case fixtures: exact join, reject title-only, parse outcomes", () => {
  for (const c of cases.cases) {
    if (c.expect === "dob_joined" || c.expect === "dob_unjoined") continue;
    const payload = loadFixture(c.fixture);
    const record = joinOpenDataToZapOutcome(c.open_data, payload);
    if (c.expect === "joined") {
      assert.equal(record.join.matched, true, c.id);
      assert.equal(record.join.method, c.method, c.id);
      assert.equal(normProjectId(record.project_id), normProjectId(c.open_data.project_id), c.id);
      if (c.expect_min_documents) {
        assert.ok(record.n_documents >= c.expect_min_documents, c.id);
      }
      if (c.expect_approved_actions) {
        assert.ok(record.n_approved_actions >= 1, c.id);
      }
    } else {
      assert.equal(record.join.matched, false, c.id);
    }
  }
});

test("Timbale Terrace demo frame has docs, approvals, and filled outcome", () => {
  const payload = loadFixture("joined_timbale_terrace.json");
  const record = parseZapApiProject(payload);
  assert.equal(record.join.matched, true);
  assert.equal(record.project_id, "2022M0258");
  assert.ok(record.n_documents >= 1);
  assert.ok(record.n_approved_actions >= 1);
  assert.ok(record.dispositions.some((d) => d.vote_date || d.community_board));
  assert.ok(outcomeIsFilled(record));
  for (const doc of record.documents.slice(0, 5)) {
    if (doc.url) {
      assert.match(doc.url, /^https:\/\/zap-api-production\.herokuapp\.com\/document\//);
    }
  }
});

test("field case groups identical Community Board votes and carries action chips", () => {
  const disposition = (name, url) => ({
    type: "dispositions",
    id: name,
    attributes: {
      "dcp-name": name,
      "dcp-representing": "Community Board",
      "dcp-dateofvote": "2026-04-14T04:00:00.000Z",
      "dcp-communityboardrecommendation": "Conditional Favorable",
      "dcp-votinginfavorrecommendation": 28,
      "dcp-votingagainstrecommendation": 0,
      "dcp-votingabstainingonrecommendation": 0,
      documents: [{ name: "CB recommendation.pdf", serverRelativeUrl: url }],
    },
  });
  const payload = {
    data: { type: "projects", id: "2024K0286", attributes: { "dcp-publicstatus": "In Public Review" } },
    included: [
      disposition("2024K0286_ZM_BK CB1", "/01QY2C5KJNEC3DOODTZZDIMXZ2NFCQGPZ6"),
      disposition("2024K0286_ZR_BK CB1", "/01QY2C5KKS5KY2LWJ3MFBIPW6RRITGVFMV"),
    ],
  };
  const record = parseZapApiProject(payload);
  assert.equal(record.dispositions.length, 1);
  const board = record.dispositions.find((d) => d.representing === "Community Board");
  assert.deepEqual(board.action_codes, ["ZM", "ZR"]);
  assert.equal(board.n_source_rows, 2);
  assert.equal(board.n_documents, 2);
  assert.equal(record.documents.length, 1);
});

test("DOB exact BBL side-car accepts and rejects correctly", () => {
  for (const c of cases.cases) {
    if (c.expect === "dob_joined") {
      const hit = joinDobFilingsToBbls(c.filings, c.bbls);
      assert.equal(hit.matched, true, c.id);
      assert.equal(hit.method, "exact_bbl");
      const nums = hit.filings.map((f) => f.job_filing_number);
      for (const n of c.expect_filing_numbers) assert.ok(nums.includes(n), c.id);
    }
    if (c.expect === "dob_unjoined") {
      const hit = joinDobFilingsToBbls(c.filings, c.bbls);
      assert.equal(hit.matched, false, c.id);
      assert.equal(hit.filings.length, 0, c.id);
    }
  }
});

test("verification receipt records rates above usefulness and curl-verified sources", () => {
  const jm = receipt.join_measurement;
  assert.equal(jm.usefulness_threshold, 0.3);
  assert.ok(jm.rates.ulurp_complete_useful_outcome.rate >= 0.3);
  assert.ok(jm.rates.mixed_sample_any_documents.rate >= 0.3);
  assert.match(jm.verdict, /Above usefulness/i);
  assert.equal(receipt.curl_verified.zap_api_project.http, 200);
  assert.equal(receipt.curl_verified.zap_api_document.http, 200);
  assert.match(receipt.curl_verified.zap_api_project.sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.curl_verified.zap_api_document.sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.field_cases.demo_frame.project_id, "2022M0258");
  assert.equal(receipt.field_cases.demo_frame.deep_link, "#land/2022M0258");
});

test("source contract is inline-at-build with join_measurement", () => {
  const registry = loadSourceContracts();
  const contract = registry.contracts.find((c) => c.id === "zap-api-outcomes");
  assert.ok(contract, "zap-api-outcomes contract missing");
  assert.equal(contract.status, "live");
  assert.equal(contract.delivery_tier, "inline-at-build");
  assert.equal(contract.kind, "html");
  assert.ok(contract.join_measurement);
  assert.ok(contract.join_measurement.rates.ulurp_complete_useful_outcome.rate >= 0.3);
  assert.match(contract.join_measurement.verdict, /Above usefulness/i);
  assert.ok(contract.code_references.some((r) => r.path.includes("zap_outcomes")));
});

test("annotated outcome screenshots are present and sha-pinned when captured", () => {
  const dir = join(ROOT, "docs/screenshots/zap-outcomes");
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    // Capture script may run after this test in local flows; skip soft.
    assert.ok(true);
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 4);
  for (const file of manifest.files) {
    const path = join(dir, file.name);
    assert.ok(existsSync(path), file.name);
    const buf = readFileSync(path);
    const sha = createHash("sha256").update(buf).digest("hex");
    assert.equal(sha, file.sha256, file.name);
    assert.equal(buf.length, file.bytes, file.name);
  }
});

test("index land detail loads outcomes from worker path only", () => {
  const src = SITE_SOURCE;
  assert.match(src, /\/zap-outcomes\?id=/);
  assert.doesNotMatch(src, /zap-api-production\.herokuapp\.com\/projects/);
  assert.match(src, /landOutcomesHTML|loadZapOutcomes/);
  // Write-ahead prewarm + session prefetch: list paints, then warms visible project ids
  // so first select does not pay the multi-second cold materialization spinner.
  assert.match(src, /prefetchZapOutcomesForList/);
  assert.match(src, /ZAP_OUTCOMES_MEM/);
});

test("default Land outcomes omit an absent daily snapshot without spinner-to-empty", () => {
  const src = SITE_SOURCE;
  assert.match(src, /landOutcomeFirstPaintHTML/);
  assert.match(src, /data-zap-outcomes-first-paint/);
  assert.doesNotMatch(src, /data-zap-outcomes-state="absent"/);
  assert.match(src, /record\.snapshot_state==="absent"\) return ""/);
  assert.doesNotMatch(
    src,
    /id="land-outcomes"[^>]*><div class="note"><span class="loading"><\/span>/,
  );
  assert.doesNotMatch(src, /if\(!data \|\| data\.ok === false \|\| !data\.record\)\{\s*el\.innerHTML = ""/);
});
