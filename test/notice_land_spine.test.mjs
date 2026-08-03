// Notice-level ZAP project spine: ULURP/project-id join + notice page mount.
//   node --test test/notice_land_spine.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractUlurpKeys,
  extractZapProjectIds,
  extractNoticeLandRefs,
  isNoticeLandSpineEligible,
  buildZapProjectJoinIndex,
  resolveZapProjectForNotice,
  noticeLandJoinReceipt,
  NOTICE_LAND_SPINE_SCHEMA_VERSION,
} from "../site/notice_land_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TIMBALE_NOTICE = {
  request_id: "20230912001",
  start_date: "2023-09-12T00:00:00.000",
  event_date: "2023-09-26T18:30:00.000",
  section_name: "Public Hearings and Meetings",
  agency_name: "City Planning",
  type_of_notice_description: "Public Hearings",
  short_title: "Timbale Terrace",
  additional_description_1:
    "Public hearing for ULURP Nos. C 240046 HAM and C 240047 PQM — Timbale Terrace.",
};

const PROPERTY_NOTICE = {
  request_id: "20241112003",
  section_name: "Property Disposition",
  short_title: "Manhattan Block 644 Lot 1",
  additional_description_1: "Disposition of property. Mentions C 240046 HAM by coincidence.",
};

test("extractUlurpKeys matches worker strict token rules", () => {
  assert.ok(extractUlurpKeys("C 240046 HAM").has("240046HAM"));
  assert.ok(extractUlurpKeys("C 240046 HAM").has("C240046HAM"));
  assert.equal(extractUlurpKeys("bare 240046").size, 0);
});

test("extractZapProjectIds accepts portal URLs and product ids", () => {
  const ids = extractZapProjectIds(
    "See https://zap.planning.nyc.gov/projects/2022M0258 and also 2019K0147 nearby.",
  );
  assert.ok(ids.has("2022M0258"));
  assert.ok(ids.has("2019K0147"));
});

test("Property Disposition is never notice-land-spine eligible (wrong universe)", () => {
  assert.equal(isNoticeLandSpineEligible(PROPERTY_NOTICE), false);
  assert.equal(isNoticeLandSpineEligible(TIMBALE_NOTICE), true);
  assert.equal(isNoticeLandSpineEligible({ section_name: "Procurement" }), false);
});

test("warehouse reverse index resolves Timbale Terrace by exact ULURP token", () => {
  const lookup = JSON.parse(
    readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"),
  );
  const index = buildZapProjectJoinIndex(lookup);
  const resolution = resolveZapProjectForNotice(TIMBALE_NOTICE, index);
  assert.equal(resolution.matched, true);
  assert.equal(resolution.method, "exact_ulurp_token");
  assert.equal(resolution.project_id, "2022M0258");
  assert.ok(resolution.keys.some((k) => /240046HAM/.test(k)));
  const receipt = noticeLandJoinReceipt(resolution);
  assert.equal(receipt.schema_version, NOTICE_LAND_SPINE_SCHEMA_VERSION);
  assert.equal(receipt.matched, true);
  assert.equal(receipt.project_id, "2022M0258");
});

test("explicit project id join beats bare text when stamped", () => {
  const lookup = JSON.parse(
    readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"),
  );
  const index = buildZapProjectJoinIndex(lookup);
  const notice = {
    request_id: "demo",
    section_name: "Public Hearings and Meetings",
    short_title: "Hearing",
    additional_description_1: "Project on file.",
    project_id: "2022M0258",
  };
  const resolution = resolveZapProjectForNotice(notice, index);
  assert.equal(resolution.matched, true);
  assert.equal(resolution.method, "exact_project_id");
  assert.equal(resolution.project_id, "2022M0258");
});

test("ULURP present but absent from warehouse stays unmatched (no invent)", () => {
  const index = buildZapProjectJoinIndex({ rows: [] });
  const resolution = resolveZapProjectForNotice(TIMBALE_NOTICE, index);
  assert.equal(resolution.matched, false);
  assert.equal(resolution.reason, "no_warehouse_match");
  assert.ok(resolution.refs.ulurp_keys.length >= 1);
});

test("ambiguous multi-project ULURP stays unresolved", () => {
  const index = buildZapProjectJoinIndex({
    rows: [
      { project_id: "AAAAA0001", ulurp_numbers: "240046HAM", project_name: "A" },
      { project_id: "BBBBB0002", ulurp_numbers: "C240046HAM", project_name: "B" },
    ],
  });
  // Both rows share the same core token via extractUlurpKeys.
  const resolution = resolveZapProjectForNotice(TIMBALE_NOTICE, index);
  // May match one or ambiguous depending on key intersection — assert no silent invent
  // when two distinct project ids are indexed under the same token.
  const byCore = index.byUlurp.get("240046HAM") || [];
  assert.ok(byCore.length >= 2);
  if (byCore.length >= 2) {
    // Force ambiguous by sharing the exact keys both projects carry.
    const forced = resolveZapProjectForNotice(
      {
        ...TIMBALE_NOTICE,
        additional_description_1: "ULURP 240046HAM only",
      },
      index,
    );
    assert.equal(forced.matched, false);
    assert.equal(forced.reason, "ambiguous_project");
    assert.ok(forced.candidates.length >= 2);
  } else {
    assert.ok(resolution.matched || resolution.reason);
  }
});

test("extractNoticeLandRefs prefers body ULURP over inventing from agency alone", () => {
  const refs = extractNoticeLandRefs({
    agency_name: "City Planning",
    section_name: "Public Hearings and Meetings",
    short_title: "Monthly calendar",
    additional_description_1: "No application numbers listed.",
  });
  assert.deepEqual(refs.ulurp_keys, []);
  assert.deepEqual(refs.zap_project_ids, []);
});

test("notice page mounts #nland and loadNoticeLandSpine", () => {
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(index, /id="nland"/);
  assert.match(index, /function loadNoticeLandSpine/);
  assert.match(index, /function noticeLandSpineHTML/);
  assert.match(index, /loadNoticeLandSpine\(\s*r,\s*\$\("#nland"\)\s*\)/);
  assert.match(index, /notice_land_spine\.mjs/);
  assert.match(index, /zap_projects_warehouse_lookup\.json/);
  // Reuses phase-grouped land spine + edge outcomes (no live ZAP API from browser).
  assert.match(index, /landSpineHTML\(record\.spine/);
  assert.match(index, /fetchZapOutcomesPayload/);
  assert.match(index, /bindLandSpineUI/);
  // Statutory / statistics path stays on landSpineHTML (no regression fork).
  assert.match(index, /landZoningStatisticsHTML|landStatutoryDeadlineHTML/);
});

test("i18n ships notice-land spine strings", () => {
  const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
  for (const key of [
    "notice_land_spine_heading",
    "notice_land_join_matched_html",
    "notice_land_open_land_detail",
    "notice_land_no_match_html",
    "notice_land_ambiguous_html",
    "notice_land_provenance_html",
  ]) {
    assert.match(i18n, new RegExp(`${key}:`));
  }
});

test("demo link and capture evidence are pinned when present", () => {
  const demos = JSON.parse(readFileSync(join(ROOT, "site/demo/demo-links.json"), "utf8"));
  const entry = demos.entries.find((e) => e.id === "notice-land-zap-spine");
  assert.ok(entry, "demo entry notice-land-zap-spine");
  assert.equal(entry.url, "#notice/20230912001");
  assert.equal(entry.feature, "notice-land-zap-spine");
  assert.ok(
    entry.expectations?.visible?.some(
      (v) => v.selector && /nland|notice-land-spine|land-phase-stepper/.test(v.selector),
    ),
  );

  const dir = join(ROOT, "docs/screenshots/notice-land-zap-spine");
  assert.ok(existsSync(dir), "screenshot directory");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.feature, "notice-land-zap-spine");
  assert.equal(manifest.notice_id, "20230912001");
  assert.equal(manifest.project_id, "2022M0258");
  for (const file of manifest.files) {
    const bytes = readFileSync(join(dir, file.name));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
});
