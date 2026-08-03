/**
 * Context-carrying alert entry: notice/lens → #alerts hash + natural scope.
 * Exemplar: Dining Out NYC Public Hearing (20260716009) — meetings + Transportation.
 *
 *   node --test test/alerts_context_carry.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  alertScopeFromNotice,
  alertScopeFromLandProject,
  alertScopeFromLensState,
  alertsHref,
  parseAlertsEntryParams,
  digKindForNotice,
  alertScopeDescriptor,
  isContextAlertsHash,
} from "../site/alerts_context_carry.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Owner-report exemplar (Transportation public hearing).
const DINING_OUT = {
  request_id: "20260716009",
  agency_name: "Transportation",
  type_of_notice_description: "Public Hearings",
  short_title: "Dining Out NYC Public Hearing",
  section_name: "Public Hearings and Meetings",
  event_date: "2026-08-06T00:00:00.000",
  additional_description_1:
    "NOTICE IS HEREBY GIVEN... public hearing will be held remotely via Zoom, commencing on August 6th, 2026, at 11:00 am",
};

test("exemplar notice scopes to meetings + agency, digKind meetings", () => {
  const scope = alertScopeFromNotice(DINING_OUT);
  assert.equal(scope.lens, "meetings");
  assert.equal(scope.filter.agency, "Transportation");
  assert.equal(scope.digKind, "meetings");
  assert.equal(scope.noticeId, "20260716009");
});

test("alertsHref for exemplar is hash-param (same pattern as health fix path)", () => {
  const href = alertsHref(alertScopeFromNotice(DINING_OUT));
  assert.match(href, /^#alerts\?/);
  const p = parseAlertsEntryParams(href);
  assert.equal(p.lens, "meetings");
  assert.equal(p.filter.agency, "Transportation");
  assert.equal(p.noticeId, "20260716009");
  assert.ok(isContextAlertsHash(href));
  assert.equal(isContextAlertsHash("#alerts"), false);
});

test("solicitation notice → money + noticeType solicitation + rfp digKind", () => {
  const scope = alertScopeFromNotice({
    request_id: "20250101001",
    agency_name: "Parks and Recreation",
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
    short_title: "Tree pruning",
  });
  assert.equal(scope.lens, "money");
  assert.equal(scope.filter.noticeType, "solicitation");
  assert.equal(scope.digKind, "rfp");
});

test("agency rules notice → rules lens", () => {
  const scope = alertScopeFromNotice({
    request_id: "20260714029",
    agency_name: "Consumer and Worker Protection",
    section_name: "Agency Rules",
    type_of_notice_description: "Notice of Adoption",
  });
  assert.equal(scope.lens, "rules");
  assert.equal(scope.digKind, "rules");
});

test("land project scope carries place keywords + project id", () => {
  const scope = alertScopeFromLandProject({
    project_id: "2022M0258",
    project_name: "SoHo/NoHo Neighborhood Plan",
    borough: "Manhattan",
  });
  assert.equal(scope.lens, "land");
  assert.equal(scope.projectId, "2022M0258");
  assert.ok(scope.filter.keywords.length >= 1);
  const href = alertsHref(scope);
  assert.match(href, /project=2022M0258/);
});

test("lens list state → matching filter prefill (meetings with boro)", () => {
  const scope = alertScopeFromLensState("meetings", {
    agency: "Transportation",
    borough: "Brooklyn",
    q: "dining",
  });
  assert.equal(scope.lens, "meetings");
  assert.equal(scope.filter.agency, "Transportation");
  assert.equal(scope.filter.borough, "Brooklyn");
  assert.deepEqual(scope.filter.keywords, ["dining"]);
});

test("descriptor exposes seed title for plain-language lead", () => {
  const scope = alertScopeFromNotice(DINING_OUT);
  const d = alertScopeDescriptor(scope, DINING_OUT);
  assert.equal(d.agency, "Transportation");
  assert.match(d.seedTitle, /Dining Out NYC/i);
  assert.equal(d.digKind, "meetings");
});

test("digKindForNotice maps hearing types", () => {
  assert.equal(digKindForNotice(DINING_OUT), "meetings");
  assert.equal(digKindForNotice({ type_of_notice_description: "Solicitation" }), "rfp");
});

test("site wires context-carry into alerts entry + prefill path", () => {
  const src = SITE_SOURCE;
  assert.match(src, /alerts_context_carry\.mjs/);
  assert.match(src, /prefillAlertFromLink/);
  assert.match(src, /noticeWatchSeed|applyNoticeWatchSeed|seedNoticePreview/);
  assert.match(src, /syncAlertsEntryHrefs|currentAlertsEntryHref/);
  // Watch CTA destinations must not be bare #alerts only when a notice is known.
  assert.match(src, /alertsHref|alertScopeFromNotice/);
});

test("action_registry watch destinations carry notice context when matter has ids", () => {
  const ar = readFileSync(join(ROOT, "site/action_registry.js"), "utf8");
  assert.match(ar, /watchDestination|alertsHref|notice=/);
  // Still a local watch type.
  assert.match(ar, /next_action_watch/);
});

test("preview-vs-template drift: digItemHTML awareness is the shared email module", () => {
  // Same contract as digest_preview_awareness: worker re-exports site module;
  // seeded preview must call digItemHTML (not a separate mock renderer).
  const workerReexport = readFileSync(
    join(ROOT, "worker/src/lib/digest_item_awareness.mjs"),
    "utf8",
  );
  assert.match(workerReexport, /site\/digest_item_awareness\.mjs/);
  const src = SITE_SOURCE;
  assert.match(src, /function digItemHTML\(/);
  assert.match(src, /itemAwarenessHtml|digest_item_awareness/);
  // Seed path must force the real dig item HTML for the carried notice.
  assert.match(src, /noticeWatchSeed/);
  assert.match(src, /digItemHTML\(/);
});
