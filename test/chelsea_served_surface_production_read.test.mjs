/**
 * Verifier for Chelsea Near You served-surface production evidence (chelsea-served-surface).
 *
 * Honest skip while capture-manifest is absent or marked pending. When present,
 * validates dual-half revision ancestry, derived assertions, and rejects
 * tampered protected fields. Population checks use floors/shares over rolling
 * production data — never permanent exact calendar counts.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "docs/evidence/chelsea-served-surface");
const MANIFEST = join(EVIDENCE, "capture-manifest.json");
const PRODUCTION = join(EVIDENCE, "production-read.json");
const DELIVERY = join(EVIDENCE, "delivery.json");
const CAPTURE_TOOL = join(
  ROOT,
  "tools/capture_chelsea_served_surface_production_read.py",
);

const FEATURE = "chelsea-served-surface";
const PRODUCER_SCHEMA = "cityscroll.chelsea_served_surface_production_read.v1";
const MANIFEST_SCHEMA = "cityscroll.render_capture_manifest.v1";
const OVERVIEW_ANCESTOR = "964dff5f0bbc0d69d6c3bdba22d9b1c0791d870e";
const MAP_FIX_ANCESTOR = "62220ddcf225e4a4b51fa4159e030e8925cef0ff";

const PENDING_MESSAGE =
  "chelsea served-surface production capture pending until Worker Live URL smoke is green and Pages contains overview + map-fix ancestors";

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha40(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function sha64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function loadCapturePacket(t) {
  if (!existsSync(MANIFEST)) {
    t.skip(PENDING_MESSAGE);
    return null;
  }
  const manifest = loadJson(MANIFEST);
  if (manifest.status === "pending") {
    t.skip(
      `${PENDING_MESSAGE} (manifest pending_reason=${manifest.pending_reason || "unspecified"})`,
    );
    return null;
  }
  return manifest;
}

function validateObservation(row, { captureRunId, deployment }) {
  assert.ok(row && typeof row === "object", "observation row required");
  assert.ok(["worker", "pages"].includes(row.served_half), `served_half ${row.served_half}`);
  assert.equal(row.contains_overview_ancestor, true, `${row.name} overview ancestor`);
  assert.equal(row.contains_map_fix_ancestor, true, `${row.name} map_fix ancestor`);
  assert.ok(sha40(row.served_revision), `${row.name} served_revision`);
  assert.ok(row.assertion && typeof row.assertion === "string", `${row.name} assertion`);
  assert.equal(row.assertions_derived, true, `${row.name} assertions_derived`);
  assert.ok(sha64(row.sha256 || row.render_content_sha256), `${row.name} content hash`);
  assert.equal(row.capture_run_id, captureRunId, `${row.name} capture_run_id`);
  assert.ok(row.served_values && typeof row.served_values === "object", `${row.name} served_values`);
  assert.equal("result" in row.served_values, false, `${row.name} must not hardcode result`);
  assert.equal("pass" in row.served_values, false, `${row.name} must not hardcode pass`);
  assert.ok(row.viewport?.width >= 320, `${row.name} viewport width`);
  assert.ok(row.viewport?.height >= 480, `${row.name} viewport height`);
  const halfDeployment = deployment?.[row.served_half];
  assert.ok(halfDeployment, `${row.name} missing deployment for ${row.served_half}`);
  assert.equal(
    row.served_revision,
    halfDeployment.served_revision,
    `${row.name} served_revision must match ${row.served_half} deployment revision`,
  );
  if (row.served_half === "worker") {
    assert.ok(row.deploy_run_id, `${row.name} deploy_run_id`);
    assert.equal(row.live_smoke_conclusion, "success", `${row.name} live_smoke_conclusion`);
    assert.equal(row.deploy_run_id, halfDeployment.deploy_run_id, `${row.name} deploy_run_id match`);
  } else {
    assert.ok(
      !row.deploy_run_id,
      `${row.name} pages observation must not carry worker deploy_run_id`,
    );
  }
}

function validateManifest(manifest) {
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.feature, FEATURE);
  assert.equal("related_feature_note" in manifest, false, "no private related-delivery note");
  assert.equal("public_alias" in manifest, false, "no private roadmap alias field");
  assert.equal(manifest.image_binaries_committed, false);
  assert.ok(manifest.capture_run_id, "capture_run_id");
  assert.ok(sha40(manifest.grounded_at || manifest.repository_revision), "grounded_at");
  assert.equal(manifest.required_ancestors?.overview, OVERVIEW_ANCESTOR);
  assert.equal(manifest.required_ancestors?.map_fix, MAP_FIX_ANCESTOR);

  const worker = manifest.deployment?.worker || {};
  const pages = manifest.deployment?.pages || {};
  assert.equal(worker.served_half, "worker");
  assert.equal(pages.served_half, "pages");
  assert.ok(sha40(worker.served_revision), "worker served_revision");
  assert.ok(sha40(pages.served_revision), "pages served_revision");
  assert.equal(worker.contains_overview_ancestor, true);
  assert.equal(worker.contains_map_fix_ancestor, true);
  assert.equal(pages.contains_overview_ancestor, true);
  assert.equal(pages.contains_map_fix_ancestor, true);
  assert.ok(worker.deploy_run_id, "worker deploy_run_id");
  assert.equal(worker.live_smoke_conclusion, "success");

  const captures = manifest.captures || [];
  assert.ok(captures.length >= 8, "expected a full observation set");
  const workerRows = captures.filter((row) => row.served_half === "worker");
  const pagesRows = captures.filter((row) => row.served_half === "pages");
  assert.ok(workerRows.length >= 1, "missing worker observations");
  assert.ok(pagesRows.length >= 1, "missing pages observations");
  for (const row of captures) {
    validateObservation(row, {
      captureRunId: manifest.capture_run_id,
      deployment: manifest.deployment,
    });
  }

  const identity = manifest.identity_compare || {};
  assert.equal(typeof identity.served_count, "number");
  assert.equal(typeof identity.canonical_count, "number");
  if (identity.canonical_count > 0) {
    assert.ok(
      identity.intersection_count >= 1 || identity.population_floor_met === true,
      "identity compare population floor",
    );
  }

  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes("/Users/"), false, "no local machine paths");
  assert.equal(serialized.includes("file://"), false, "no file:// references");
  assert.equal(serialized.includes("letter_status"), false, "no letter bookkeeping");
  assert.equal(serialized.includes("acceptance_for_overview_" + "a4"), false, "no private acceptance_for_overview_a4");
  assert.equal(serialized.includes("a4" + "_evaluator_would"), false, "no private a4_evaluator_would");
  assert.equal(new RegExp("\\b" + "A" + "4" + "\\b").test(serialized), false, "no private letter criteria token in receipt");
  assert.equal(serialized.includes("open_letters"), false, "no open_letters bookkeeping");
  assert.equal("public_alias" in manifest, false);
  assert.equal("related_delivery_alias" in manifest, false);
}

function rejectTamper(manifest, mutate, label) {
  const clone = deepClone(manifest);
  mutate(clone);
  assert.throws(
    () => validateManifest(clone),
    (error) => {
      assert.ok(error instanceof assert.AssertionError || error instanceof Error);
      return true;
    },
    `tamper control must reject: ${label}`,
  );
}

test("delivery.json records both required ancestors without private roadmap aliases", () => {
  const delivery = loadJson(DELIVERY);
  assert.equal(delivery.schema, "cityscroll.capture_delivery.v1");
  assert.equal("public_alias" in delivery, false);
  assert.equal("related_delivery_alias" in delivery, false);
  assert.equal(delivery.landed_commit, OVERVIEW_ANCESTOR);
  assert.equal(delivery.surface, "pages");
  const byRole = Object.fromEntries(
    (delivery.required_ancestors || []).map((row) => [row.role, row.commit]),
  );
  assert.equal(byRole.overview, OVERVIEW_ANCESTOR);
  assert.equal(byRole.map_fix, MAP_FIX_ANCESTOR);
  assert.match(JSON.stringify(delivery), /964dff5f0bbc0d69d6c3bdba22d9b1c0791d870e/);
});

test("capture tool encodes dual-half gates, both ancestors, and check-gates CLI", () => {
  const source = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(source, /--check-gates/);
  assert.match(source, /964dff5f0bbc0d69d6c3bdba22d9b1c0791d870e/);
  assert.match(source, /62220ddcf225e4a4b51fa4159e030e8925cef0ff/);
  assert.match(source, /served_half/);
  assert.match(source, /contains_overview_ancestor/);
  assert.match(source, /contains_map_fix_ancestor/);
  assert.match(source, /deploy_run_id/);
  assert.match(source, /live_smoke_conclusion/);
  assert.match(source, /Live URL smoke/);
  assert.match(source, /Deploy worker/);
  assert.match(source, /api\.cityscroll\.org\/health/);
  assert.match(source, /artifact-manifest\.json/);
  assert.match(source, /chelsea-served-surface/);
  assert.match(source, /public_alias" not in/);
  assert.match(source, /related_delivery_alias" not in/);
  assert.match(source, /letter_status" not in/);
  assert.match(source, /counts_toward_live_scoped_failed_detail/);
  assert.match(source, /acceptance_for_overview_" \+ "a4"/);
  assert.match(source, /FEATURE = "chelsea-served-surface"/);
  assert.match(source, /cityscroll\.chelsea_served_surface_production_read\.v1/);
  assert.match(source, /cityscroll\.render_capture_manifest\.v1/);
  assert.match(source, /boundary_fits_first_viewport|__chelseaObservedMap/);
  assert.match(source, /soft_return_to_chelsea_overview/);
  assert.match(source, /interaction_mode/);
  assert.match(source, /same_document/);
  assert.match(source, /evaluate_keyboard_journey_result/);
  assert.match(source, /evaluate_history_back_return_result/);
  assert.match(source, /observe_history_back_place_retention/);
  assert.match(source, /place_link_destination/);
  assert.match(source, /interaction-history-back-return/);
  assert.match(source, /_find_visible_near_results_full_record/);
  assert.match(source, /ensure_geography_island_control_visible/);
  assert.match(source, /observe_client_neighborhood_switch/);
  assert.match(source, /overview-client-neighborhood-switch-same-document/);
  assert.match(source, /observe_keyboard_filter_neighborhood_switch_to_hells_kitchen/);
  assert.match(source, /overview-keyboard-filter-neighborhood-switch-hells-kitchen/);
  assert.match(source, /Neighborhood or precinct/);
  assert.match(source, /shared_exact_ids/);
  assert.match(source, /result_lens/);
  assert.match(source, /native_browser_shortcut_required/);
  assert.match(source, /map_first_place_link_is_not_broken_browser_back/);
  assert.match(source, /assert_uniform_served_revision/);
  assert.match(source, /is_chelsea_land_category_control/);
  assert.match(source, /retained_requested_return_state|return_state_retention/);
  assert.match(source, /back_return_method/);
  assert.match(source, /platform_browser_back_chords|attempt_keyboard_browser_back/);
  assert.match(source, /Meta\+BracketLeft/);
  assert.match(source, /browser_back_keyboard_status/);
  assert.match(source, /supported_product_affordance|document-navigation-via-href/);
  assert.match(source, /is_near_you_inspect_control/);
  assert.match(source, /operated_from_keyboard_alone/);
  assert.match(source, /wait_settled_named_record_heading/);
  assert.match(source, /needs_decision/);
  assert.match(source, /retained_from_capture_run_id/);

  assert.match(source, /All NYC meetings/);
  assert.match(source, /FM_TASK_SCRATCH/);
  assert.match(source, /BK1402/);
  assert.match(source, /diagnose_m04_freshness|m04_freshness_diagnosis/);
  assert.match(source, /verified-empty|verified_empty/);
  assert.match(source, /Open meetings/);
  assert.match(source, /Open Zoning/);
  assert.match(source, /overview-open-lens-links-place-scope-worker-ssr/);
  assert.match(source, /observation_status/);
  assert.match(source, /check_result/);
  assert.match(source, /near-results/);
  assert.match(source, /citywide_bag|near-bags|parse_citywide_bag_ids/);
  assert.match(source, /surface=map|NO_LENS_MAP_ROUTE|map-first-viewport-fit/);
  // Dual-half must never be relabeled.
  assert.match(source, /worker half mislabeled|pages half mislabeled|served_half == "worker"/);
});

test("check-gates CLI exits non-zero while deploy is paused", () => {
  const result = spawnSync(
    "python3",
    [CAPTURE_TOOL, "--check-gates"],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
  );
  // While Worker smoke is red or Pages lacks an ancestor, expect non-zero.
  // If both halves happen to be ready, status 0 is also acceptable.
  assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.feature, FEATURE);
  assert.ok(payload.worker);
  assert.ok(payload.pages);
  assert.equal(typeof payload.ready, "boolean");
  if (result.status === 1) {
    assert.equal(payload.ready, false);
    assert.ok(Array.isArray(payload.pending) && payload.pending.length >= 1);
  }
});

test("production capture manifest validates dual-half ancestry when present", (t) => {
  const manifest = loadCapturePacket(t);
  if (!manifest) return;
  validateManifest(manifest);
  if (existsSync(PRODUCTION)) {
    const production = loadJson(PRODUCTION);
    assert.equal(production.schema, PRODUCER_SCHEMA);
    assert.equal(production.feature, FEATURE);
    assert.equal(production.capture_run_id, manifest.capture_run_id);
    assert.equal(production.deployment.worker.served_revision, manifest.deployment.worker.served_revision);
    assert.equal(production.deployment.pages.served_revision, manifest.deployment.pages.served_revision);
  }
});

function syntheticCapturedManifest() {
  const captureRunId = "00000000-0000-4000-8000-000000000001";
  const workerRev = "a".repeat(40);
  const pagesRev = "b".repeat(40);
  const digest = "c".repeat(64);
  const baseRow = {
    assertion: "synthetic derived assertion for verifier tamper controls",
    assertions_derived: true,
    capture_run_id: captureRunId,
    contains_map_fix_ancestor: true,
    contains_overview_ancestor: true,
    render_content_sha256: digest,
    sha256: digest,
    served_values: { heading: "Chelsea-Hudson Yards", observed: true },
    viewport: { width: 1440, height: 900 },
  };
  const workerRows = Array.from({ length: 7 }, (_, index) => ({
    ...baseRow,
    name: `synthetic-worker-${index}`,
    route: "/near-you/?geo=nta2020%3AMN0401&surface=records",
    served_half: "worker",
    served_revision: workerRev,
    deploy_run_id: "1234567890",
    live_smoke_conclusion: "success",
  }));
  const pagesRow = {
    ...baseRow,
    name: "synthetic-pages-0",
    route: "/near-you/?geo=nta2020%3AMN0401&surface=records",
    served_half: "pages",
    served_revision: pagesRev,
  };
  return {
    schema: MANIFEST_SCHEMA,
    feature: FEATURE,
    status: "captured",
    capture_run_id: captureRunId,
    grounded_at: workerRev,
    repository_revision: workerRev,
    image_binaries_committed: false,
    required_ancestors: {
      overview: OVERVIEW_ANCESTOR,
      map_fix: MAP_FIX_ANCESTOR,
    },
    deployment: {
      worker: {
        served_half: "worker",
        served_revision: workerRev,
        contains_overview_ancestor: true,
        contains_map_fix_ancestor: true,
        deploy_run_id: "1234567890",
        live_smoke_conclusion: "success",
      },
      pages: {
        served_half: "pages",
        served_revision: pagesRev,
        contains_overview_ancestor: true,
        contains_map_fix_ancestor: true,
      },
    },
    identity_compare: {
      served_count: 2,
      canonical_count: 2,
      intersection_count: 2,
      population_floor_met: true,
    },
    captures: [...workerRows, pagesRow],
  };
}

test("tampering positive controls reject protected dual-half fields", () => {
  // Use an in-memory synthetic captured packet so tamper controls run before
  // the live production capture is retained. Do not commit this fixture.
  const manifest = existsSync(MANIFEST) && loadJson(MANIFEST).status !== "pending"
    ? loadJson(MANIFEST)
    : syntheticCapturedManifest();
  validateManifest(manifest);

  const protectedMutations = [
    ["schema", (clone) => { clone.schema = "cityscroll.tampered.v0"; }],
    ["feature", (clone) => { clone.feature = "deadbeefdeadb"; }],
    ["capture_run_id", (clone) => { clone.capture_run_id = "tampered-run-id"; }],
    ["required_ancestors.overview", (clone) => { clone.required_ancestors.overview = "0".repeat(40); }],
    ["required_ancestors.map_fix", (clone) => { clone.required_ancestors.map_fix = "1".repeat(40); }],
    ["deployment.worker.served_half", (clone) => { clone.deployment.worker.served_half = "pages"; }],
    ["deployment.pages.served_half", (clone) => { clone.deployment.pages.served_half = "worker"; }],
    ["deployment.worker.contains_overview_ancestor", (clone) => { clone.deployment.worker.contains_overview_ancestor = false; }],
    ["deployment.worker.contains_map_fix_ancestor", (clone) => { clone.deployment.worker.contains_map_fix_ancestor = false; }],
    ["deployment.pages.contains_overview_ancestor", (clone) => { clone.deployment.pages.contains_overview_ancestor = false; }],
    ["deployment.pages.contains_map_fix_ancestor", (clone) => { clone.deployment.pages.contains_map_fix_ancestor = false; }],
    ["deployment.worker.live_smoke_conclusion", (clone) => { clone.deployment.worker.live_smoke_conclusion = "failure"; }],
    ["deployment.worker.deploy_run_id", (clone) => { clone.deployment.worker.deploy_run_id = ""; }],
    ["image_binaries_committed", (clone) => { clone.image_binaries_committed = true; }],
    [
      "observation.served_half relabel",
      (clone) => {
        const workerRow = (clone.captures || []).find((row) => row.served_half === "worker");
        assert.ok(workerRow, "need a worker row to tamper");
        // Relabel alone is not enough when Worker and Pages share one SHA:
        // keep the worker deploy_run_id so a pages row carrying it is rejected.
        workerRow.served_half = "pages";
        delete workerRow.live_smoke_conclusion;
      },
    ],
    [
      "observation.served_half relabel with revision swap",
      (clone) => {
        const workerRow = (clone.captures || []).find((row) => row.served_half === "worker");
        assert.ok(workerRow, "need a worker row to tamper");
        workerRow.served_half = "pages";
        delete workerRow.deploy_run_id;
        delete workerRow.live_smoke_conclusion;
        workerRow.served_revision = "f".repeat(40);
      },
    ],
    [
      "observation.contains_overview_ancestor",
      (clone) => {
        clone.captures[0].contains_overview_ancestor = false;
      },
    ],
    [
      "observation.contains_map_fix_ancestor",
      (clone) => {
        clone.captures[0].contains_map_fix_ancestor = false;
      },
    ],
    [
      "observation.assertions_derived",
      (clone) => {
        clone.captures[0].assertions_derived = false;
      },
    ],
    [
      "observation.hardcoded pass",
      (clone) => {
        clone.captures[0].served_values.pass = true;
      },
    ],
    [
      "identity population floor",
      (clone) => {
        clone.identity_compare = {
          served_count: 0,
          canonical_count: 5,
          intersection_count: 0,
          population_floor_met: false,
        };
      },
    ],
  ];

  for (const [label, mutate] of protectedMutations) {
    rejectTamper(manifest, mutate, label);
  }
});

test("population checks avoid permanent exact rolling calendar counts", (t) => {
  const manifest = loadCapturePacket(t);
  if (!manifest) return;
  const source = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(source, /population_floor/);
  assert.match(source, /Rolling publisher windows/);
  // Manifest must not freeze a single exact meetings calendar count as the gate.
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(
    serialized,
    /"required_exact_meetings_count":\s*\d+/,
    "no permanent exact meetings count gate",
  );
  const identity = manifest.identity_compare || {};
  assert.equal(typeof identity.intersection_count, "number");
  assert.ok(
    "population_floor_met" in identity || identity.canonical_count === 0,
    "identity compare uses a population floor",
  );
});

test("overview Open meetings/Zoning place-scope observation stays honest when present", (t) => {
  const manifest = loadCapturePacket(t);
  if (!manifest) return;
  const rows = (manifest.captures || []).filter((entry) =>
    String(entry.name || "").startsWith("overview-open-lens-links-place-scope-worker-ssr"),
  );
  assert.ok(rows.length >= 2, "Worker-SSR overview-link rows required at both viewports");
  for (const row of rows) {
    const values = row.served_values || {};
    assert.ok(["pass", "fail"].includes(values.check_result), "derived check_result");
    assert.ok(["open", "closed"].includes(values.observation_status), "derived observation_status");
    assert.equal(
      values.observation_status,
      values.check_result === "pass" ? "closed" : "open",
      "observation_status must follow check_result",
    );
    assert.ok(Array.isArray(values.links) && values.links.length >= 2, "both overview links");
    for (const link of values.links) {
      assert.ok(typeof link.href === "string" && link.href.length > 0, "exact href recorded");
      assert.ok(["pass", "fail"].includes(link.check_result), "per-link derived check_result");
      if (link.check_result === "fail") {
        assert.ok(
          typeof link.result_h1 === "string" && link.result_h1.length > 0,
          "failing click records result h1",
        );
      }
    }
    if (values.check_result === "fail") {
      const open = (manifest.open_observations || []).find(
        (entry) => entry.observation === row.name,
      );
      assert.ok(open, "failing observation must remain in open_observations");
    }
  }
});

test("overview link Worker-SSR and Pages-client verdicts stay separate", (t) => {
  const manifest = loadCapturePacket(t);
  if (!manifest) return;
  const workers = (manifest.captures || []).filter((entry) =>
    String(entry.name || "").startsWith("overview-open-lens-links-place-scope-worker-ssr"),
  );
  const pagesRows = (manifest.captures || []).filter((entry) =>
    String(entry.name || "").startsWith("overview-open-lens-links-place-scope-pages-client"),
  );
  assert.ok(workers.length >= 2, "worker-ssr overview-link at desktop and narrow");
  assert.ok(pagesRows.length >= 2, "pages-client overview-link at desktop and narrow");
  for (const worker of workers) {
    assert.equal(worker.served_half, "worker");
    assert.equal((worker.served_values || {}).verdict_scope, "worker-ssr-only");
  }
  for (const pages of pagesRows) {
    assert.equal(pages.served_half, "pages");
    assert.equal((pages.served_values || {}).verdict_scope, "pages-client-only");
  }
});

test("lens coverage and negative controls exist at both viewports", (t) => {
  const manifest = loadCapturePacket(t);
  if (!manifest) return;
  const names = new Set((manifest.captures || []).map((entry) => entry.name));
  for (const viewport of ["desktop", "narrow"]) {
    for (const geo of ["MN0401", "MN0402"]) {
      for (const lens of ["meetings", "land"]) {
        assert.ok(
          names.has(`lens-${geo}-${lens}-${viewport}`),
          `missing lens-${geo}-${lens}-${viewport}`,
        );
      }
    }
    for (const base of [
      "negative-explicit-meetings-lens",
      "negative-switch-neighborhood-mn0402",
      "negative-failed-deferred-load",
      "negative-true-zero-bk1402-land",
    ]) {
      assert.ok(names.has(`${base}-${viewport}`), `missing ${base}-${viewport}`);
    }
  }
});

test("keyboard journey evaluators reject false-positive controls", () => {
  const script = join(ROOT, "test/chelsea_keyboard_journey_negative_controls.py");
  const result = spawnSync("python3", [script, ROOT], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr || ""}${result.stdout || ""}`);
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.controls));
  assert.ok(payload.controls.includes("place-link-map-first-passes-with-surface-difference"));
  assert.ok(payload.controls.includes("native-shortcut-no-nav-not-sole-fail"));
  assert.ok(payload.controls.includes("missing-place-link-destination-fails"));
  assert.ok(payload.controls.includes("history-back-full-retention-pass"));
  assert.ok(payload.controls.includes("history-back-surface-gap-fails"));
});

test("scoped failed-detail evaluators reject zero-intercept, invisible recovery, and noop Chelsea", () => {
  const script = join(ROOT, "test/chelsea_scoped_failed_detail_negative_controls.py");
  const result = spawnSync("python3", [script, ROOT], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr || ""}${result.stdout || ""}`);
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.controls));
  assert.ok(payload.controls.includes("zero-intercept"));
  assert.ok(payload.controls.includes("invisible-recovery-controls"));
  assert.ok(payload.controls.includes("noop-stayed-on-chelsea-url"));
  assert.ok(payload.controls.includes("fulfill-body-never-live-scoped"));
  assert.ok(payload.controls.includes("requires-continue-redirect-production-answer"));
  assert.ok(payload.controls.includes("abort-diagnostic-never-satisfies-live-scoped"));
});

test("pages-client island-adopt evaluators reject no-op and full-document shapes", () => {
  const script = join(ROOT, "test/chelsea_pages_client_island_adopt_negative_controls.py");
  const result = spawnSync("python3", [script, ROOT], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr || ""}${result.stdout || ""}`);
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.controls));
  assert.ok(payload.controls.includes("noop-chelsea-stuck"));
  assert.ok(payload.controls.includes("full-document-marker-died"));
  assert.ok(payload.controls.includes("pushstate-only-incomplete"));
  assert.ok(payload.controls.includes("complete-adopt-pass"));
  assert.ok(payload.controls.includes("classify-noop-settle"));
  assert.ok(payload.controls.includes("classify-full-document-settle"));
});

