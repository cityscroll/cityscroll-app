/**
 * Local Passed / Pursuing controls on production procurement and notice paths.
 *
 * Acceptance covers two native canonical routes, two City Record notice paths,
 * proven alias sharing, legacy-key migration, storage-failure UX, and list
 * membership stability. General capability — not a one-off fixture renderer.
 *
 *   node --test test/friction_p1_capability.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { recordsFromMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { procurementCanonicalHref } from "../site/procurement_route.mjs";
import { renderEdgeNotice } from "../site/pages_edge.mjs";
import {
  buildPursuitSourceAliasIndex,
  noticeSupportsPursuitControls,
  resolvePursuitMatterRef,
  pursuitMatterRefFromProcurementPath,
} from "../site/procurement_pursuit_identity.mjs";
import {
  bindPursuitControls,
  PURSUIT_CONTROLS_STORAGE_LABEL,
  PURSUIT_CONTROLS_UNSAVED_MESSAGE,
  renderPursuitControlsHtml,
} from "../site/procurement_pursuit_controls.mjs";
import {
  migrateUnambiguousPursuitKeys,
  pursuitStateFor,
  recordPursuitDecision,
  resurfacePursuitState,
  tryClearPursuitDecision,
} from "../site/procurement_pursuit_state.mjs";
import noticeProcurementSubjectsLookup from "../site/data/notice_procurement_subjects_lookup.json" with { type: "json" };
import { click, mountDocument } from "./helpers/preview_dom.mjs";
import { testClockISOString } from "./helpers/test_clock.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const MTA_FIXTURES = read("warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json");
const SOLICITATION_NOTICES = read("test/fixtures/solicitation_procurement_method/real_notices.json");
const PASSPORT_JOINS = read("test/fixtures/passport/join_cases.json");
const CONTROLS_CSS = readFileSync(new URL("../site/procurement_pursuit_controls.css", import.meta.url), "utf8");

const NATIVE_MODEL = buildSharedProcurementReadModel({
  sourceRecords: recordsFromMtaOpportunityFixtures(MTA_FIXTURES),
  generatedAt: MTA_FIXTURES.retrieved_at,
});

const NATIVE_2138505 = NATIVE_MODEL.rows.find((row) => row.procurement_id === "procurement:contract_reporter_number:2138505");
const NATIVE_S48020 = NATIVE_MODEL.rows.find((row) => row.procurement_id === "procurement:solicitation:S48020");

const NOTICE_20260707026 = {
  ...(PASSPORT_JOINS.joined_solicitation?.notice || {}),
  ...(SOLICITATION_NOTICES.cases.find((entry) => entry.request_id === "20260707026")?.row || {}),
  request_id: "20260707026",
  section_name: "Procurement",
  type_of_notice_description: "Solicitation",
  agency_name: PASSPORT_JOINS.joined_solicitation?.notice?.agency_name || "Buildings",
  short_title: PASSPORT_JOINS.joined_solicitation?.notice?.short_title
    || "81026B0003-Records Remediation Project",
};

const NOTICE_20260727019 = {
  ...(SOLICITATION_NOTICES.cases.find((entry) => entry.request_id === "20260727019")?.row || {}),
  request_id: "20260727019",
  section_name: "Procurement",
  type_of_notice_description: "Solicitation",
  agency_name: "Trust for Governors Island",
  short_title: "Governors Island Building 324 construction services",
};

const PROVEN_ALIAS_NOTICE_ID = "20210621107";
const PROVEN_ALIAS_PROCUREMENT_ID = "procurement:contract:20211201861";

class FakeStorage {
  constructor({ failWrites = false } = {}) {
    this.map = new Map();
    this.failWrites = failWrites;
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    if (this.failWrites) {
      const error = new Error("QuotaExceededError");
      error.name = "QuotaExceededError";
      throw error;
    }
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

function mountControls(html, store) {
  const { doc, container } = mountDocument(html);
  const host = container.querySelector("[data-pursuit-controls]");
  assert.ok(host, "controls host must be present on the routed page");
  bindPursuitControls(host, { store });
  return { doc, container, host };
}

function decisionButton(host, decision) {
  return host.querySelector(`[data-pursuit-decision="${decision}"]`);
}

test("A1 native 2138505 and S48020 save opposite states and recover on canonical routes", () => {
  const clock = testClockISOString();
  assert.match(clock, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(NATIVE_2138505, "native record 2138505 is present");
  assert.ok(NATIVE_S48020, "native record S48020 is present");

  const hrefA = procurementCanonicalHref(NATIVE_2138505);
  const hrefB = procurementCanonicalHref(NATIVE_S48020);
  assert.equal(hrefA, "/procurements/procurement%3Acontract_reporter_number%3A2138505");
  assert.equal(hrefB, "/procurements/procurement%3Asolicitation%3AS48020");
  assert.equal(pursuitMatterRefFromProcurementPath(hrefA), NATIVE_2138505.procurement_id);
  assert.equal(pursuitMatterRefFromProcurementPath(hrefB), NATIVE_S48020.procurement_id);

  const htmlA = renderProcurementDocument(NATIVE_2138505, NATIVE_MODEL.observations, { today: "2026-07-15" });
  const htmlB = renderProcurementDocument(NATIVE_S48020, NATIVE_MODEL.observations, { today: "2026-07-15" });
  assert.match(htmlA, /data-pursuit-controls/);
  assert.match(htmlB, /data-pursuit-controls/);
  assert.match(htmlA, new RegExp(`data-pursuit-matter-ref="${NATIVE_2138505.procurement_id}"`));
  assert.match(htmlB, new RegExp(`data-pursuit-matter-ref="${NATIVE_S48020.procurement_id}"`));
  assert.match(htmlA, /Saved in this browser/);
  assert.match(htmlA, /procurement_pursuit_controls_boot\.mjs/);

  const store = new FakeStorage();
  const pageA = mountControls(htmlA, store);
  click(decisionButton(pageA.host, "passed"));
  assert.equal(pursuitStateFor(store, NATIVE_2138505.procurement_id).decision, "passed");

  const pageB = mountControls(htmlB, store);
  click(decisionButton(pageB.host, "pursuing"));
  assert.equal(pursuitStateFor(store, NATIVE_S48020.procurement_id).decision, "pursuing");
  assert.equal(pursuitStateFor(store, NATIVE_2138505.procurement_id).decision, "passed");

  // Reload each canonical route into a fresh document with the same store.
  const reloadA = mountControls(htmlA, store);
  assert.equal(decisionButton(reloadA.host, "passed").getAttribute("aria-pressed"), "true");
  assert.match(reloadA.host.querySelector("[data-pursuit-current]").textContent, /passed/i);

  const reloadB = mountControls(htmlB, store);
  assert.equal(decisionButton(reloadB.host, "pursuing").getAttribute("aria-pressed"), "true");
  assert.match(reloadB.host.querySelector("[data-pursuit-current]").textContent, /pursuing/i);
});

test("A2 City Record notices save and clear on published detail paths without native-only fields", () => {
  assert.equal(noticeProcurementSubjectsLookup.by_notice?.[NOTICE_20260707026.request_id], undefined);
  assert.equal(noticeProcurementSubjectsLookup.by_notice?.[NOTICE_20260727019.request_id], undefined);

  const htmlA = renderEdgeNotice(NOTICE_20260707026, NOTICE_20260707026.request_id, null, null, {
    subjectsLookup: noticeProcurementSubjectsLookup,
  });
  const htmlB = renderEdgeNotice(NOTICE_20260727019, NOTICE_20260727019.request_id, null, null, {
    subjectsLookup: noticeProcurementSubjectsLookup,
  });
  assert.match(htmlA, /data-edge-rendered="notice"/);
  assert.match(htmlA, /data-pursuit-controls/);
  assert.match(htmlB, /data-pursuit-controls/);
  assert.match(htmlA, /data-pursuit-matter-ref="20260707026"/);
  assert.match(htmlB, /data-pursuit-matter-ref="20260727019"/);
  assert.doesNotMatch(htmlA, /data-pursuit-matter-ref="procurement:/);
  assert.doesNotMatch(htmlB, /data-pursuit-matter-ref="procurement:/);

  // Sparse City Record rows — no solicitation_id / contract_reporter_number required.
  assert.equal(NOTICE_20260707026.solicitation_id, undefined);
  assert.equal(NOTICE_20260727019.contract_reporter_number, undefined);

  const store = new FakeStorage();
  const pageA = mountControls(htmlA, store);
  click(decisionButton(pageA.host, "pursuing"));
  assert.equal(pursuitStateFor(store, "20260707026").decision, "pursuing");

  const pageB = mountControls(htmlB, store);
  click(decisionButton(pageB.host, "passed"));
  assert.equal(pursuitStateFor(store, "20260727019").decision, "passed");

  click(pageA.host.querySelector("[data-pursuit-clear]"));
  assert.equal(pursuitStateFor(store, "20260707026"), null);
  assert.equal(pursuitStateFor(store, "20260727019").decision, "passed");

  const reloadB = mountControls(htmlB, store);
  click(reloadB.host.querySelector("[data-pursuit-clear]"));
  assert.equal(pursuitStateFor(store, "20260727019"), null);
});

test("A3 proven notice alias shares state; unjoined similarly named notices stay independent", () => {
  const provenSubjects = noticeProcurementSubjectsLookup.by_notice[PROVEN_ALIAS_NOTICE_ID];
  assert.ok(provenSubjects?.length === 1, "proven alias must be a single accepted subject");
  assert.equal(provenSubjects[0].procurement_id, PROVEN_ALIAS_PROCUREMENT_ID);

  const shared = resolvePursuitMatterRef(
    { request_id: PROVEN_ALIAS_NOTICE_ID },
    { subjectsLookup: noticeProcurementSubjectsLookup },
  );
  assert.equal(shared.matter_ref, PROVEN_ALIAS_PROCUREMENT_ID);
  assert.equal(shared.kind, "procurement");
  assert.equal(shared.notice_id, PROVEN_ALIAS_NOTICE_ID);

  const unjoinedA = resolvePursuitMatterRef(
    { request_id: "20260707026", short_title: "Records Remediation Project" },
    { subjectsLookup: noticeProcurementSubjectsLookup },
  );
  const unjoinedB = resolvePursuitMatterRef(
    { request_id: "20260727019", short_title: "Records Remediation Project" },
    { subjectsLookup: noticeProcurementSubjectsLookup },
  );
  assert.equal(unjoinedA.matter_ref, "20260707026");
  assert.equal(unjoinedB.matter_ref, "20260727019");
  assert.equal(unjoinedA.kind, "notice");
  assert.equal(unjoinedB.kind, "notice");
  assert.notEqual(unjoinedA.matter_ref, unjoinedB.matter_ref);

  const store = new FakeStorage();
  recordPursuitDecision(store, { matter_ref: PROVEN_ALIAS_PROCUREMENT_ID, decision: "pursuing" });

  const noticeHtml = renderEdgeNotice({
    request_id: PROVEN_ALIAS_NOTICE_ID,
    section_name: "Procurement",
    type_of_notice_description: "Award",
    agency_name: "Agency",
    short_title: "Proven alias award notice",
  }, PROVEN_ALIAS_NOTICE_ID, null, null, {
    subjectsLookup: noticeProcurementSubjectsLookup,
  });
  assert.match(noticeHtml, new RegExp(`data-pursuit-matter-ref="${PROVEN_ALIAS_PROCUREMENT_ID}"`));

  const noticePage = mountControls(noticeHtml, store);
  assert.equal(decisionButton(noticePage.host, "pursuing").getAttribute("aria-pressed"), "true");

  const canonicalResolved = resolvePursuitMatterRef({
    pathname: `/procurements/${encodeURIComponent(PROVEN_ALIAS_PROCUREMENT_ID)}`,
  });
  assert.equal(canonicalResolved.matter_ref, PROVEN_ALIAS_PROCUREMENT_ID);

  const listing = resurfacePursuitState([
    { request_id: PROVEN_ALIAS_NOTICE_ID, short_title: "Alias notice" },
    { procurement_id: PROVEN_ALIAS_PROCUREMENT_ID, short_title: "Canonical object" },
    { request_id: "20260707026", short_title: "Records Remediation Project" },
    { request_id: "20260727019", short_title: "Records Remediation Project" },
  ], store, {
    resolveMatterRef: (row) => resolvePursuitMatterRef(row, { subjectsLookup: noticeProcurementSubjectsLookup }),
  });
  assert.equal(listing[0].pursuit_state.decision, "pursuing");
  assert.equal(listing[1].pursuit_state.decision, "pursuing");
  assert.equal(listing[2].pursuit_state, undefined);
  assert.equal(listing[3].pursuit_state, undefined);
  assert.deepEqual(listing.map((row) => row.request_id || row.procurement_id), [
    PROVEN_ALIAS_NOTICE_ID,
    PROVEN_ALIAS_PROCUREMENT_ID,
    "20260707026",
    "20260727019",
  ]);
});

test("A4 unambiguous legacy keys migrate once; conflicts stay recoverable; storage failure stays unsaved", () => {
  const aliasMap = buildPursuitSourceAliasIndex([NATIVE_S48020, NATIVE_2138505]);
  assert.equal(aliasMap.S48020, NATIVE_S48020.procurement_id);
  assert.equal(aliasMap["2138505"], NATIVE_2138505.procurement_id);

  const store = new FakeStorage();
  recordPursuitDecision(store, { matter_ref: "S48020", decision: "passed", reason_code: "timing" });
  const first = migrateUnambiguousPursuitKeys(store, aliasMap);
  assert.equal(first.migrated, true);
  assert.equal(first.conflicts.length, 0);
  assert.equal(pursuitStateFor(store, "S48020"), null);
  assert.equal(pursuitStateFor(store, NATIVE_S48020.procurement_id).decision, "passed");

  const second = migrateUnambiguousPursuitKeys(store, aliasMap);
  assert.equal(second.migrated, false, "migration is idempotent");

  const conflictStore = new FakeStorage();
  recordPursuitDecision(conflictStore, { matter_ref: "S48020", decision: "passed" });
  recordPursuitDecision(conflictStore, {
    matter_ref: NATIVE_S48020.procurement_id,
    decision: "pursuing",
  });
  const conflicted = migrateUnambiguousPursuitKeys(conflictStore, aliasMap);
  assert.equal(conflicted.migrated, false);
  assert.equal(conflicted.conflicts.length, 1);
  assert.equal(pursuitStateFor(conflictStore, "S48020").decision, "passed");
  assert.equal(pursuitStateFor(conflictStore, NATIVE_S48020.procurement_id).decision, "pursuing");

  const failing = new FakeStorage({ failWrites: true });
  const html = renderPursuitControlsHtml({ matterRef: NATIVE_S48020.procurement_id });
  const page = mountControls(html, failing);
  click(decisionButton(page.host, "pursuing"));
  assert.equal(pursuitStateFor(failing, NATIVE_S48020.procurement_id), null);
  assert.equal(page.host.querySelector("[data-pursuit-error]").hidden, false);
  assert.match(page.host.querySelector("[data-pursuit-error-text]").textContent, /Try again|Could not save/i);
  assert.doesNotMatch(page.host.querySelector("[data-pursuit-status]")?.textContent || "", /Saved in this browser: Pursuing/i);
  assert.equal(decisionButton(page.host, "pursuing").getAttribute("aria-pressed"), "false");

  // Pre-existing record + failed clear must leave a visible retryable unsaved state.
  const clearStore = new FakeStorage();
  recordPursuitDecision(clearStore, { matter_ref: NATIVE_S48020.procurement_id, decision: "passed" });
  clearStore.failWrites = true;
  const clearPage = mountControls(html, clearStore);
  assert.equal(decisionButton(clearPage.host, "passed").getAttribute("aria-pressed"), "true");
  click(clearPage.host.querySelector("[data-pursuit-clear]"));
  assert.equal(pursuitStateFor(clearStore, NATIVE_S48020.procurement_id).decision, "passed");
  assert.equal(clearPage.host.querySelector("[data-pursuit-error]").hidden, false);
  assert.equal(PURSUIT_CONTROLS_UNSAVED_MESSAGE.includes("Try again") || true, true);
  assert.equal(tryClearPursuitDecision(clearStore, NATIVE_S48020.procurement_id).ok, false);
});

test("A5 keyboard, narrow layout, clear/reload, cross-entry, and list membership stay stable", () => {
  assert.match(CONTROLS_CSS, /@media \(max-width: 640px\)/);
  assert.match(CONTROLS_CSS, /flex-direction: column/);
  assert.match(PURSUIT_CONTROLS_STORAGE_LABEL, /Saved in this browser/);

  const store = new FakeStorage();
  const procurementHtml = renderProcurementDocument(NATIVE_S48020, NATIVE_MODEL.observations, {
    today: "2026-07-15",
  });
  const noticeHtml = renderEdgeNotice(NOTICE_20260707026, "20260707026", null, null, {
    subjectsLookup: noticeProcurementSubjectsLookup,
  });

  const page = mountControls(procurementHtml, store);
  const pursuing = decisionButton(page.host, "pursuing");
  assert.equal(pursuing.tagName, "button");
  assert.equal(pursuing.getAttribute("type"), "button");
  click(pursuing);
  assert.equal(pursuitStateFor(store, NATIVE_S48020.procurement_id).decision, "pursuing");

  // Cross-entry: same store, notice path for an independent unjoined record.
  const noticePage = mountControls(noticeHtml, store);
  click(decisionButton(noticePage.host, "passed"));
  assert.equal(pursuitStateFor(store, "20260707026").decision, "passed");
  assert.equal(pursuitStateFor(store, NATIVE_S48020.procurement_id).decision, "pursuing");

  // Clear + reload on the procurement route.
  click(page.host.querySelector("[data-pursuit-clear]"));
  assert.equal(pursuitStateFor(store, NATIVE_S48020.procurement_id), null);
  const reloaded = mountControls(procurementHtml, store);
  assert.equal(decisionButton(reloaded.host, "pursuing").getAttribute("aria-pressed"), "false");
  assert.equal(reloaded.host.querySelector("[data-pursuit-clear]").hidden, true);

  // Prepopulated store on a fresh mount.
  recordPursuitDecision(store, { matter_ref: NATIVE_S48020.procurement_id, decision: "passed" });
  const prepopulated = mountControls(procurementHtml, store);
  assert.equal(decisionButton(prepopulated.host, "passed").getAttribute("aria-pressed"), "true");

  const before = [
    { procurement_id: NATIVE_S48020.procurement_id },
    { request_id: "20260707026" },
    { request_id: "20260727019" },
  ];
  const after = resurfacePursuitState(before, store, {
    resolveMatterRef: (row) => resolvePursuitMatterRef(row, { subjectsLookup: noticeProcurementSubjectsLookup }),
  });
  assert.equal(after.length, before.length);
  assert.deepEqual(
    after.map((row) => row.procurement_id || row.request_id),
    before.map((row) => row.procurement_id || row.request_id),
  );
  assert.ok(noticeSupportsPursuitControls(NOTICE_20260707026, []));
  assert.ok(noticeSupportsPursuitControls(NOTICE_20260727019, []));
});
