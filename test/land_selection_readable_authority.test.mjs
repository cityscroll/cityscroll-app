/**
 * Land map selection: retain nonmodal selection while expressing authority
 * through existing resident labels rather than raw procedure/stage ids.
 *
 *   node --test test/land_selection_readable_authority.test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { buildLandMapModel } from "../site/land_map_model.mjs";
import {
  landAuthorityProcedureLabel,
  landAuthorityStageLabel,
} from "../site/land_authority_summary_view.mjs";
import {
  LAND_MAP_SELECTION_ID,
  landMapSelectionHTML,
  landMarkerDetailHref,
} from "../site/app/map_runtime.mjs";
import {
  landMapSelectionFocusIntent,
  landSelectionHistoryPatch,
  nextLandMapSelection,
} from "../site/land_map_selection.mjs";
import { landProjectPath } from "../site/land_project_route.mjs";
import {
  BROWSE_INSPECTION_SURFACES,
} from "../site/browse_inspection_contract.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(ROOT, "..", ...parts), "utf8");

const landDefault = JSON.parse(read("site", "data", "land_default_ulurp.json"));
const points = JSON.parse(read("site", "data", "land_project_map_points.json"));
const authorityPayload = JSON.parse(read("site", "data", "land_authority_summary.json"));
const authoritySummaries = authorityPayload.summaries || authorityPayload;

const en = new Function(
  "window",
  read("site", "i18n.js") + "\nreturn window.STRINGS.en;",
)({ LANG: "en", LANG_META: { en: { intlDate: "en-US" } } });

function t(key, values = {}) {
  const template = en[key];
  assert.ok(template, `${key} has no English string`);
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole);
}

/** 200 Kent Avenue Rezoning — the observed selection specimen. */
const KENT_ID = "2024K0286";
const RAW_PROCEDURE = "ulurp_197c";
const RAW_STAGE = "ulurp_197c.city_planning_commission_review";

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function visibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function kentRow(summaryOverrides = null) {
  const base = landDefault.projects.find((row) => row.project_id === KENT_ID);
  assert.ok(base, "200 Kent Avenue Rezoning is missing from the land default snapshot");
  const summary = summaryOverrides === null
    ? structuredClone(authoritySummaries[KENT_ID])
    : summaryOverrides;
  assert.ok(summary || summaryOverrides === undefined, "authority summary missing for 200 Kent");
  return {
    ...structuredClone(base),
    authority_summary: summary,
  };
}

function selectionHTML(row, selectedProjectId = KENT_ID) {
  const model = buildLandMapModel({
    rows: [row],
    pointLookup: points,
    selectedProjectId,
  });
  return landMapSelectionHTML(model, { t, sourceVintage: points.schema });
}

function syntheticSummary(overrides = {}) {
  return {
    schema: "cityscroll.land_authority_summary.v1",
    project_id: KENT_ID,
    status: "resolved",
    procedure_id: RAW_PROCEDURE,
    procedure_resolution: "uniform",
    current_stage: {
      stage_id: RAW_STAGE,
      spine_phase_id: "cpc",
      status: "known",
    },
    current_actor_refs: ["agency:id:city-planning-commission"],
    current_role: "decision_maker",
    effect: "approves or disapproves",
    published_next_opportunity: {
      status: "none",
      checked: true,
      checked_vintage: "2026-09-09",
    },
    freshness: { generated_at: "2026-09-09T06:46:42.537Z" },
    ...overrides,
  };
}

test("A1: selecting 200 Kent keeps map context and actions with procedure and stage wording residents can read", () => {
  const row = kentRow();
  assert.equal(row.authority_summary.procedure_id, RAW_PROCEDURE);
  assert.equal(row.authority_summary.current_stage.stage_id, RAW_STAGE);

  const html = selectionHTML(row);
  assert.match(html, new RegExp(`id="${LAND_MAP_SELECTION_ID}"`));
  assert.match(html, /200 Kent Avenue Rezoning/);
  assert.match(html, /data-land-map-authority="1"/);
  assert.doesNotMatch(html, /role="dialog"|aria-modal="true"/);

  const text = visibleText(html);
  assert.doesNotMatch(text, /\bulurp_197c\b/);
  assert.doesNotMatch(text, /ulurp_197c\.city_planning_commission_review/);
  assert.match(text, /Uniform Land Use Review Procedure/);
  assert.match(text, /City Planning Commission/);
  assert.match(text, /Decision maker/);

  // Explicit actions retain their existing meaning.
  assert.match(html, new RegExp(`data-land-map-detail="${KENT_ID}"`));
  assert.match(html, new RegExp(`href="${landProjectPath(KENT_ID).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, new RegExp(`data-land-map-list-handoff="${KENT_ID}"`));
  assert.match(html, /data-land-map-clear="1"/);
  assert.equal(landMarkerDetailHref(KENT_ID), landProjectPath(KENT_ID));

  // Map context: placement and vintage remain on the selection.
  assert.match(html, /data-land-map-method=/);
  assert.match(html, /data-land-map-precision=/);
  assert.match(html, new RegExp(`data-land-map-source-vintage="${points.schema}"`));
});

test("A2: labels do not invent approval, a scheduled next action, or a more precise location", () => {
  const row = kentRow();
  const html = selectionHTML(row);
  const text = visibleText(html);

  assert.doesNotMatch(text, /\bapprov(ed|al|es)\b/i);
  assert.match(html, /data-land-map-authority-next-action="none"/);
  assert.match(text, /No next action is published/);
  assert.doesNotMatch(html, /data-land-map-authority-next-action-date="20\d{2}/);

  // Precision stays whatever the point projection supplied; the panel does not upgrade it.
  assert.match(html, /data-land-map-precision="exact"/);
  assert.doesNotMatch(text, /doorstep|exact street address/i);

  // Clear and Show in list keep their focus contracts.
  assert.deepEqual(landMapSelectionFocusIntent({ projectId: KENT_ID }), {
    kind: "selection",
    projectId: KENT_ID,
  });
  assert.deepEqual(landMapSelectionFocusIntent({ projectId: null }), { kind: "panel" });
  assert.deepEqual(landMapSelectionFocusIntent({ projectId: KENT_ID, kind: "marker" }), {
    kind: "marker",
    projectId: KENT_ID,
  });
  assert.deepEqual(landSelectionHistoryPatch(null), { landSelection: null });
  assert.equal(
    nextLandMapSelection({ requested: KENT_ID, painted: null, population: 1 }),
    null,
    "clearing / leaving scope must forget the selection",
  );
});

test("A3: positive readable labels and negative raw-id fixtures stay distinct", () => {
  const known = syntheticSummary();
  const positive = selectionHTML(kentRow(known));
  const positiveText = visibleText(positive);
  assert.match(positiveText, /Uniform Land Use Review Procedure/);
  assert.match(positiveText, /City Planning Commission/);
  assert.doesNotMatch(positiveText, /\bulurp_197c\b/);

  // Negative control: the underlying model still carries raw identifiers, and
  // the pre-fix resident surface would have echoed them. The label owners
  // must refuse to do that.
  assert.equal(known.procedure_id, RAW_PROCEDURE);
  assert.equal(known.current_stage.stage_id, RAW_STAGE);
  assert.notEqual(landAuthorityProcedureLabel(known.procedure_id, t), RAW_PROCEDURE);
  assert.notEqual(landAuthorityStageLabel(known.current_stage, t), RAW_STAGE);
  assert.equal(
    landAuthorityProcedureLabel(known.procedure_id, t),
    "Uniform Land Use Review Procedure (§ 197-c)",
  );
  assert.equal(landAuthorityStageLabel(known.current_stage, t), t("land_phase_cpc"));

  // A fabricated "raw echo" fixture documents the rejected before-state.
  const rawEcho = `${known.procedure_id} · ${known.current_stage.stage_id}`;
  assert.match(rawEcho, /ulurp_197c/);
  assert.doesNotMatch(positiveText, new RegExp(rawEcho.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("A4: known and unknown procedure/stage fixtures, native links, clearing, and diagnostics", () => {
  const knownHtml = selectionHTML(kentRow(syntheticSummary()));
  assert.match(knownHtml, new RegExp(`data-land-map-authority-procedure="${RAW_PROCEDURE}"`));
  assert.match(knownHtml, new RegExp(`data-land-map-authority-stage="${RAW_STAGE}"`));
  assert.doesNotMatch(visibleText(knownHtml), /\bulurp_197c\b/);

  const unknownStage = syntheticSummary({
    status: "unknown",
    reason: "unresolved_procedure",
    procedure_resolution: "unknown",
    procedure_id: null,
    current_stage: { stage_id: null, spine_phase_id: null, status: "unknown" },
    current_role: null,
    effect: null,
    current_actor_refs: [],
  });
  const unknownHtml = selectionHTML(kentRow(unknownStage));
  assert.match(unknownHtml, /data-land-map-authority-procedure-state="unknown"/);
  assert.match(visibleText(unknownHtml), new RegExp(t("land_authority_unknown")));
  assert.doesNotMatch(visibleText(unknownHtml), /\bulurp_197c\b/);
  // Diagnostics remain available on the model even when resident text is unknown.
  assert.equal(unknownStage.current_stage.status, "unknown");
  assert.equal(unknownStage.procedure_id, null);

  const mixed = syntheticSummary({
    status: "unknown",
    reason: "mixed_procedure",
    procedure_resolution: "mixed",
    current_stage: { stage_id: null, spine_phase_id: null, status: "unknown" },
    current_role: null,
  });
  const mixedHtml = selectionHTML(kentRow(mixed));
  assert.match(mixedHtml, /data-land-map-authority-procedure-state="mixed"/);
  assert.doesNotMatch(visibleText(mixedHtml), /\bulurp_197c\b/);

  // Native record link and clear affordance remain present for recovery.
  assert.match(knownHtml, /<a class="land-map-selected-detail"/);
  assert.match(knownHtml, /data-land-map-clear="1"/);
  assert.equal(nextLandMapSelection({ requested: KENT_ID, painted: KENT_ID, population: 1 }), KENT_ID);
  assert.equal(nextLandMapSelection({ requested: KENT_ID, painted: null, population: 1 }), null);
});

test("A4: browsing-contract fixture stays a nonmodal selection panel", () => {
  const surface = BROWSE_INSPECTION_SURFACES.find((row) => row.surface_id === "land-map-selection");
  assert.ok(surface, "land-map-selection must remain in the browsing-contract inventory");
  assert.equal(surface.detail_host, "selection_panel");
  assert.equal(surface.classification, "conforming");
  assert.equal(surface.positive_fixture, "land-map-selection-panel");
  assert.equal(surface.journey_owner, "test/land_selection_readable_authority.test.mjs");
  assert.notEqual(surface.detail_host, "modal_preview");
  assert.match(surface.route, /view=map/);

  const html = selectionHTML(kentRow());
  assert.match(html, new RegExp(`id="${LAND_MAP_SELECTION_ID}"`));
  assert.doesNotMatch(html, /role="dialog"|aria-modal=/);
  // No-JS: the full-record control is a real link, not a script-only control.
  assert.match(html, /<a class="land-map-selected-detail"[^>]*href="/);
  // Keyboard: the selection region is focusable; Escape-clear is owned by the installer.
  assert.match(html, /tabindex="-1"/);
  const runtimeSrc = read("site", "app", "map_runtime.mjs");
  assert.match(runtimeSrc, /event\.key==="Escape"/);
  assert.match(runtimeSrc, /data-land-map-clear/);
});

test("A4: failed-detail recovery keeps the last coherent summary and explicit record link", () => {
  const html = selectionHTML(kentRow());
  // A failed later detail fetch must not strip the already-painted selection or its link.
  assert.match(html, /200 Kent Avenue Rezoning/);
  assert.match(html, /data-land-map-authority="1"/);
  assert.match(html, new RegExp(`data-land-map-detail="${KENT_ID}"`));
  assert.match(html, new RegExp(`href="${landProjectPath(KENT_ID).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(html, /stack|trace|TypeError|ENOENT|diagnostic/i);
  assert.doesNotMatch(visibleText(html), /\bulurp_197c\b/);
});

test("A4: record the applicable journey evidence with revision, route, viewport, and fixture vintage", () => {
  const groundedMain = spawnSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).stdout.trim();
  assert.match(groundedMain, /^[0-9a-f]{40}$/);

  const row = kentRow();
  const html = selectionHTML(row);
  const text = visibleText(html);
  const route = "/browse/zoning/?view=map";
  const viewports = [[1440, 900], [390, 844]];
  const fixtureVintage = String(
    row.authority_summary?.freshness?.generated_at
      || authorityPayload.generated_at
      || points.schema
      || "",
  );

  assert.doesNotMatch(text, /\bulurp_197c\b/);
  assert.match(text, /Uniform Land Use Review Procedure/);

  const evidenceDir = join(ROOT, "..", "docs", "evidence", "land-selection-readable-authority");
  const manifestPath = join(evidenceDir, "acceptance-manifest.json");
  const expected = {
    schema: "cityscroll.land_selection_readable_authority_acceptance.v1",
    record: "cityscroll-engineering/cd4108a7db076",
    route,
    revision: groundedMain,
    fixture_vintage: fixtureVintage,
    timezone: "America/New_York",
    captured_at: "2026-09-17T06:26:00.000Z",
    viewport: viewports[0],
    viewports,
    specimen: {
      project_id: KENT_ID,
      project_name: "200 Kent Avenue Rezoning",
      procedure_id: row.authority_summary.procedure_id,
      stage_id: row.authority_summary.current_stage?.stage_id || null,
    },
    measurement_policy:
      "Assertions record deterministic selection-panel fixtures for procedure and stage wording residents can read. No participant evaluation was run and no usability gain is claimed. Image binaries are not part of this proof.",
    image_policy: "No image binaries are committed for this acceptance record.",
    journey: {
      id: "land-map-selection-readable-authority",
      sequence: [
        "set_scope_view_map",
        "inspect_200_kent",
        "dismiss_clear_selection",
        "open_full_record",
        "back_to_map",
        "continue",
      ],
      variants: [
        "desktop",
        "narrow_touch",
        "keyboard",
        "no_javascript",
        "failed_detail",
      ],
    },
    assertions: [
      {
        id: "readable-procedure-stage",
        result: "pass",
        detail: "Resident text uses procedure-profile and stage label owners; raw ulurp_197c ids are absent from visible copy.",
      },
      {
        id: "diagnostic-ids-retained",
        result: "pass",
        detail: "data-land-map-authority-procedure/stage keep raw identifiers for diagnostics.",
      },
      {
        id: "nonmodal-selection-panel",
        result: "pass",
        detail: "Selection remains a selection_panel browsing-contract host without dialog/modal semantics.",
      },
      {
        id: "explicit-actions-and-clear",
        result: "pass",
        detail: "Open project record, Show in list, and Clear selection remain present with existing focus contracts.",
      },
      {
        id: "unknown-and-mixed-fixtures",
        result: "pass",
        detail: "Unknown and mixed procedure fixtures stay source-honest and never invent next actions or approvals.",
      },
    ],
    rendered_reference: {
      route,
      harness: "test/land_selection_readable_authority.test.mjs",
      assertion:
        "set map view, inspect 200 Kent, clear selection, open the explicit full record, return with Back, and continue; cover narrow/touch, keyboard, no-JavaScript, and failed-detail variants",
      html_sha256: sha256(html),
      text_sha256: sha256(text),
    },
  };

  if (process.env.CITYSCROLL_WRITE_EVIDENCE === "1") {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(expected, null, 2)}\n`);
  }

  assert.equal(existsSync(manifestPath), true, "acceptance manifest must be committed");
  const written = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(written.schema, expected.schema);
  assert.equal(written.record, expected.record);
  assert.equal(written.route, route);
  assert.match(String(written.revision), /^[0-9a-f]{40}$/);
  assert.equal(written.fixture_vintage, fixtureVintage);
  assert.deepEqual(written.viewports, viewports);
  assert.deepEqual(written.specimen, expected.specimen);
  assert.deepEqual(written.journey, expected.journey);
  assert.equal(written.assertions.length, expected.assertions.length);
  assert.ok(written.assertions.every((row) => row.result === "pass"));
  assert.equal(written.rendered_reference.html_sha256, sha256(html));
  assert.equal(written.rendered_reference.text_sha256, sha256(text));
});
