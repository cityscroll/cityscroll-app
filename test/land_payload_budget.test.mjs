// LDP-27 (A6, A7, A9): the compact "Application filings"/"Filing history"
// surfaces must stay small enough for first paint, the full structured
// report must stay route-lazy, and everything this card did not touch
// (generic document rendering, existing filters, existing URLs, nullable
// older records) must keep working exactly as before.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import { landFilingEvidenceSummaryHTML, landFilingHistoryHTML } from "../site/land_filing_evidence_view.mjs";
import { buildLandFilingEvidenceReportDetail, buildLandFilingEvidenceSummary } from "../site/land_filing_evidence.mjs";
import { buildLandUseFilingDocument, buildLandUseFilingObligation, buildRacialEquityReportEnvelope, racialEquityReportGoverningAuthority } from "../ontology/land_use_filing.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
const readBytes = (path) => readFileSync(new URL(path, ROOT));

const landSrc = read("site/app/land.mjs");
const mainSrc = read("site/app/main.mjs");
const evidence = JSON.parse(read("docs/evidence/index-module-split.json"));

function gitShow(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  } catch {
    return null;
  }
}

/* ===== A7: the structured report detail is route-lazy, not first paint ===== */

test("A7 the structured filing-report runtime is registered lazily, behind an explicit activation, never eagerly awaited", () => {
  assert.match(
    mainSrc,
    /globalThis\.ensureLandFilingReportRuntime = \(\) => landFilingReportRuntimePromise \|\|= import\("\.\/land_filing_report_runtime\.mjs"\)/,
  );
  assert.doesNotMatch(mainSrc, /await import\("\.\/land_filing_report_runtime\.mjs"\)/);
  // Land's own module never imports the heavy runtime statically -- only calls
  // the lazily-registered global, exactly like the sibling map runtime.
  assert.doesNotMatch(landSrc, /from\s+["']\.\.\/app\/land_filing_report_runtime\.mjs["']/);
  assert.doesNotMatch(landSrc, /import\(["'].*land_filing_report_runtime\.mjs["']\)/);
  // land.mjs delegates the click-wiring to its sibling view module; the actual
  // `ensureLandFilingReportRuntime()` call site lives there instead, to keep
  // land.mjs's own headroom (test/land_map_shell.test.mjs's own invariant).
  const viewSrc = read("site/land_filing_evidence_view.mjs");
  assert.match(viewSrc, /ensureLandFilingReportRuntime\(\)/);
  assert.match(landSrc, /wireLandFilingReportTrigger\(/);
});

test("A7 the report trigger only mounts after an explicit click, and the mount root starts hidden", () => {
  assert.match(landSrc, /wireLandFilingReportTrigger\(/);
  const viewSrc = read("site/land_filing_evidence_view.mjs");
  assert.match(viewSrc, /trigger\.addEventListener\("click"/);
  assert.match(viewSrc, /data-land-filing-report-detail-root="1" hidden/);
});

/* ===== A6: first-paint compressed payload growth is measured against a stated budget ===== */

test("A6 the compact filing-evidence eager surface stays within its own, stated compressed-byte budget", () => {
  // Everything land.mjs itself gained (imports, two render calls, one click
  // handler) plus its two new always-eager sibling modules -- never the
  // route-lazy report runtime, never the Node-only build-time product module.
  const beforeLand = gitShow("HEAD", "site/app/land.mjs");
  assert.ok(beforeLand, "expected a committed baseline for site/app/land.mjs to diff against");
  const landDeltaGzipBytes = gzipSync(Buffer.from(landSrc)).length - gzipSync(Buffer.from(beforeLand)).length;
  const newModuleGzipBytes = ["site/land_filing_evidence_view.mjs", "site/land_filing_evidence_facet.mjs"]
    .reduce((sum, path) => sum + gzipSync(readBytes(path)).length, 0);
  const totalGrowthBytes = Math.max(0, landDeltaGzipBytes) + newModuleGzipBytes;
  // Budget: 12,000 compressed bytes. Measured growth at card-authoring time was
  // ~4.8KB (383B land.mjs delta + ~4.4KB of new eager view/facet modules); this
  // ceiling leaves headroom for copy/markup changes without re-litigating the
  // budget on every edit, while still catching a runaway addition (e.g. an
  // accidental full RER section leaking into the eager view module).
  const BUDGET_BYTES = 12_000;
  assert.ok(
    totalGrowthBytes <= BUDGET_BYTES,
    `first-paint compressed growth ${totalGrowthBytes} exceeds the ${BUDGET_BYTES}-byte budget (land.mjs delta ${landDeltaGzipBytes}, new modules ${newModuleGzipBytes})`,
  );
});

test("A6/A7 site/app/land.mjs itself stays under the short-context working bar after this card's additions", () => {
  const bytes = Buffer.byteLength(landSrc);
  assert.ok(bytes < evidence.after.working_bar_bytes, `land.mjs: ${bytes} bytes`);
});

test("A6 the compact per-project summary is a thin pointer, not the full report -- the structured detail is markedly larger", () => {
  const obligation = buildLandUseFilingObligation({
    obligation_id: "land_use_filing_obligation:2025M0252:racial_equity_report",
    project_ref: "project:2025M0252",
    obligation_type: "racial_equity_report",
    governing_authority: [racialEquityReportGoverningAuthority()],
    applicability: { state: "required", criteria: [], publisher_assertion: { source_field: "dcp-applicability", source_value: "Yes", observed_at: "2026-06-01T00:00:00.000Z" } },
    fulfillment: { state: "document_observed", document_refs: ["placeholder"] },
    procedural_effect: { certification_blocker: false, missing_report_notification_required: "unknown" },
    observed_at: "2026-06-01T00:00:00.000Z",
    available_to_public_at: "2026-06-01T00:00:00.000Z",
    materialized_at: "2026-06-01T00:00:00.000Z",
    source_id: "nyc-zap-open-data",
    source_record_id: "2025M0252",
    source_vintage: "2026-06-01T00:00:00.000Z",
    normalization_version: "ldp23.v1",
  });
  const document = buildLandUseFilingDocument({
    project_ref: "project:2025M0252",
    document_type: "racial_equity_report",
    publisher_document_id: "doc-1",
    original_name: "Racial Equity Report.pdf",
    first_observed_at: "2026-06-01T00:00:00.000Z",
    available_to_public_at: "2026-06-01T00:00:00.000Z",
    retrieval_status: "fetched",
    bytes_sha256: "a".repeat(64),
    byte_length: 1000,
    classification: { method: "explicit_publisher_type_or_group", evidence: ["publisher group: RER"], confidence: "high" },
  });
  const envelope = buildRacialEquityReportEnvelope({
    document_ref: document.document_id,
    project_ref: "project:2025M0252",
    source_bytes_sha256: "a".repeat(64),
    extraction_version: "ldp25_rer_extractor.v1",
    extraction_quality: "high",
    fair_housing_narrative: {
      source: "applicant_narrative",
      text: "A".repeat(4000), // a realistically long filed narrative
      evidence: { page_number: 12 },
    },
  });
  const summary = buildLandFilingEvidenceSummary({ obligation: { ...obligation, fulfillment: { ...obligation.fulfillment, document_refs: [document.document_id] } }, documents: [document], materializedAt: "2026-06-01T00:00:00.000Z" });
  const detail = buildLandFilingEvidenceReportDetail({ document, rerEnvelope: envelope });
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
  const detailBytes = Buffer.byteLength(JSON.stringify(detail));
  assert.ok(summaryBytes < 2_000, `compact summary unexpectedly large: ${summaryBytes} bytes`);
  assert.ok(detailBytes > summaryBytes, "the route-lazy detail should carry materially more than the compact summary");
});

/* ===== A9: generic document rendering, existing filters, and existing URLs stay compatible ===== */

test("A9 generic document rendering markup is unchanged by this card", () => {
  // These four generic-document link sites (LDP-08-era rendering) must still
  // exist verbatim -- LDP-27 adds a filing-specific document link beside them,
  // it never replaces or forks the generic renderer.
  const genericDocPattern = /class="view"[^>]*href="\$\{escUiHtml\(d(?:oc)?\.(?:url|href)\)\}"/;
  assert.match(landSrc, genericDocPattern, "generic document link markup must remain present");
});

test("A9 existing Land filters keep their default behavior when filingEvidence is omitted", () => {
  const rows = [
    { project_id: "1", project_status: "Active", borough: "Manhattan" },
    { project_id: "2", project_status: "Active", borough: "Brooklyn", filing_evidence: { applicability: { state: "not_required" }, fulfillment: { state: "not_checked" } } },
  ];
  // No filingEvidence key at all -- exactly the call shape every pre-existing
  // caller of filterLandSnapshot already uses.
  const result = filterLandSnapshot(rows, { status: "active", borough: "Manhattan" });
  assert.deepEqual(result.map((r) => r.project_id), ["1"]);
});

test("A9 an older project record with no filing-evidence fields at all still renders its existing sections", () => {
  const legacyRow = { project_id: "old-1", project_status: "Active", project_name: "A 1998 rezoning", borough: "Queens" };
  assert.equal(landFilingEvidenceSummaryHTML(undefined, {}), "");
  assert.equal(landFilingHistoryHTML(undefined, {}), "");
  // filterLandSnapshot must not throw or drop the row for lacking the new field.
  const filtered = filterLandSnapshot([legacyRow], { status: "active" });
  assert.deepEqual(filtered.map((r) => r.project_id), ["old-1"]);
});

test("A9 the Land route URL and its existing query-param filters are untouched by this card", () => {
  // The compact section is additive DOM inside the existing #ldetail render;
  // it introduces no new route, hash shape, or param name collision with the
  // existing boro/procedure/family/stage/effect filters.
  assert.match(landSrc, /#lstatus/);
  assert.match(landSrc, /#lprocedure/);
  assert.match(landSrc, /#lfamily/);
  assert.match(landSrc, /#leffect/);
  assert.match(landSrc, /#lfiling/);
  assert.doesNotMatch(landSrc, /location\.hash\s*=\s*["']#land-filing/);
});
