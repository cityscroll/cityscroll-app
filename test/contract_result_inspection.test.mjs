// Give notice and source-native contract rows the same inspection behavior.
//
// Public alias: c175322a83f02
//
// Contracts rows used to diverge: title links navigated, trusted row clicks
// assigned inspect_href or source-native canonical_href destinations, and
// detail selection assumed notice-oriented fields for other shapes. After this
// change every supported row shares a title-sized inspect control, an explicit
// full-record link, and the same `#detail` host projection.
//
//   A1 notice-backed and source-native rows inspect consistently through
//      pointer and keyboard input, with correct record destinations and enough
//      contract context to compare opportunities
//   A2 open, expired, guide-only and award fixtures retain lifecycle and
//      action rules; missing notice identities never become fabricated joins
//   A3 positive and negative fixtures distinguish the prior diverging click
//      branches from the intended unified inspection outcome
//   A4 trusted browser clicks plus unit fixtures cover rapid selection, detail
//      failure, preserved filtering, and explicit record navigation followed
//      by Back; journey evidence recorded
//
//   node --test test/contract_result_inspection.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

import {
  BROWSE_INSPECTION_LEGACY_BASELINE,
  BROWSE_INSPECTION_SURFACES,
} from "../site/browse_inspection_contract.mjs";
import {
  CONTRACT_RESULT_FULL_RECORD_CLASS,
  CONTRACT_RESULT_INSPECT_ATTRIBUTE,
  CONTRACT_RESULT_INSPECT_CLASS,
  CONTRACT_RESULT_READY_ATTRIBUTE,
  CONTRACT_RESULT_TITLE_LINK_CLASS,
  bindContractResultInspection,
  contractResultDetailFailureStatus,
  contractResultFullRecordHref,
  contractResultInteractionProjection,
  contractResultUsesSharedDetail,
  projectContractResultInspection,
  renderContractResultInspectionDetailHTML,
  renderContractResultInteractionsHTML,
  renderContractResultTitleClusterHTML,
} from "../site/contract_result_inspection.mjs";
import { solicitationResponseContextReady } from "../site/solicitation_response_context.mjs";
import { click, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const require = createRequire(import.meta.url);
const CrolActions = require("../site/action_registry.js");

const ROOT = process.cwd();
const EVIDENCE_PATH = join("docs", "evidence", "contract-result-inspection", "acceptance-manifest.json");
const MONEY_LIST_SOURCE = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");
const BRAND_CSS = readFileSync(new URL("../site/brand.css", import.meta.url), "utf8");
const OPEN_SNAPSHOT = JSON.parse(readFileSync(new URL("./fixtures/money_action_field_cases.json", import.meta.url), "utf8"));
const AWARD_SNAPSHOT = JSON.parse(readFileSync(new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url), "utf8"));

const OPEN_SOLICITATION = Object.freeze(
  OPEN_SNAPSHOT.rows.find((row) => row.request_id === "20260624023"),
);
const EXPIRED_SOLICITATION = Object.freeze(
  OPEN_SNAPSHOT.rows.find((row) => row.request_id === "20260624038"),
);
const GUIDE_ONLY_SOLICITATION = Object.freeze(
  OPEN_SNAPSHOT.rows.find((row) => row.request_id === "20260603042"),
);
const SOURCE_BACKED_AWARD = Object.freeze(
  AWARD_SNAPSHOT.rows.find((row) => row.request_id === "20260723031"),
);

const SOURCE_NATIVE = Object.freeze({
  procurement_id: "procurement:07122P0012063",
  canonical_href: "/procurements/procurement%3A07122P0012063",
  short_title: "SHELTER FACILITIES FOR HOMELESS SINGLE ADULTS",
  agency_name: "Department of Homeless Services",
  vendor_name: null,
  primary_stage: "solicitation",
  procurement_stages: Object.freeze(["solicitation"]),
  source_observation_refs: Object.freeze(["notice:20260818019"]),
  additional_description_1: "Procurement for shelter facilities serving homeless single adults.",
  source_system: "passport",
  pin: "07122P0012063",
  start_date: "2026-08-18",
});

const HYBRID = Object.freeze({
  ...SOURCE_NATIVE,
  request_id: "20260818019",
});

const ANALYTICAL = Object.freeze({
  id: "CT107120258801626",
  short_title: "Registered analytics contract CT107120258801626",
  type_of_notice_description: "Award",
  agency_name: "Department of Design and Construction",
  inspect_href: "/browse/contracts/?mode=award&ap_inspect=CT107120258801626",
  analytics_projection: true,
  procurement_stages: Object.freeze(["registered"]),
  primary_stage: "registered",
  source_system: "analytics_registered_contracts",
});

const MISSING_NOTICE = Object.freeze({
  short_title: "Untitled without destinations",
  agency_name: "Fixture Agency",
});

function translate(key) {
  return ({
    respond_lbl: "Respond",
    award_guide_heading: "Follow this award",
    untitled_notice: "Untitled notice",
    copy_link: "Copy link",
    next_action_heading: "What can I do now?",
    ext_link_new_tab_sr: "(opens in new tab)",
  })[key] || key;
}

function moneyListPrimaryAction(r, today = "2026-08-04") {
  if (!globalThis.CrolActions || typeof CrolActions.compileActionRail !== "function") return null;
  if (typeof globalThis.noticeActionMatter !== "function") return null;
  try {
    const matter = globalThis.noticeActionMatter(r);
    if (!matter || (matter.kind !== "solicitation" && matter.kind !== "award")) return null;
    if (matter.kind === "solicitation" && !solicitationResponseContextReady(r)) return null;
    const action = (CrolActions.compileActionRail(matter, { today }) || [])[0] || null;
    if (!action || action.delivery === "unavailable") return null;
    if (matter.kind === "solicitation" && action.type !== "official_application" && action.type !== "bid_checklist") return null;
    if (matter.kind === "award" && (!action.guide || action.guide.system !== "award_lifecycle")) return null;
    const external = action.delivery === "official_handoff" && !!action.destination;
    return {
      kind: matter.kind,
      action,
      external,
      href: external ? action.destination : `#notice/${encodeURIComponent(r.request_id)}`,
      label_key: matter.kind === "solicitation" ? "respond_lbl" : "award_guide_heading",
    };
  } catch {
    return null;
  }
}

function rowArticle(row, index = 0, titleMarkup = null) {
  const interactions = renderContractResultInteractionsHTML(row, {
    titleMarkup,
    today: "2026-08-04",
    primaryAction: (candidate, day) => moneyListPrimaryAction(candidate, day),
    translate,
    copyLabel: "Copy link",
    actionHeading: "What can I do now?",
    newTabLabel: "(opens in new tab)",
  });
  return `<article class="money-row-card"><div class="row" data-i="${index}" tabindex="0" role="group">${interactions}</div></article>`;
}

function mountContractsList(rows, { onInspect } = {}) {
  const html = `<div id="list">${rows.map((row, index) => rowArticle(row, index)).join("")}</div>
    <div id="detail"></div>`;
  const { doc, container } = mountDocument(html, { containerClass: "contracts-host" });
  const list = container.querySelector("#list");
  const detail = container.querySelector("#detail");
  const selected = { index: null, count: 0, events: [] };
  const controller = bindContractResultInspection(list, {
    onInspect: (index, el, event) => {
      selected.index = index;
      selected.count += 1;
      selected.events.push({ index, trusted: event?.isTrusted !== false, type: event?.type || "click" });
      const row = rows[index];
      const facts = projectContractResultInspection(row);
      detail.innerHTML = renderContractResultInspectionDetailHTML(facts);
      if (typeof onInspect === "function") onInspect(index, el, event, row);
    },
  });
  return { doc, container, list, detail, controller, selected };
}

function inspectButton(list, uid) {
  return [...list.querySelectorAll(`[${CONTRACT_RESULT_INSPECT_ATTRIBUTE}]`)]
    .find((node) => node.getAttribute(CONTRACT_RESULT_INSPECT_ATTRIBUTE) === uid);
}

function fullRecordLink(list, uid) {
  return [...list.querySelectorAll(`.${CONTRACT_RESULT_FULL_RECORD_CLASS}`)]
    .find((node) => node.getAttribute("data-browse-return-uid") === uid);
}

const priorActions = globalThis.CrolActions;
const priorMatter = globalThis.noticeActionMatter;

test.before(() => {
  globalThis.CrolActions = CrolActions;
  globalThis.noticeActionMatter = (row) => ({
    kind: row.type_of_notice_description === "Solicitation" ? "solicitation"
      : row.type_of_notice_description === "Award" ? "award" : "notice",
    type_of_notice_description: row.type_of_notice_description,
    deadline: row.due_date || null,
    official_notice_url: row.request_id
      ? `https://a856-cityrecord.nyc.gov/RequestDetail/${row.request_id}`
      : null,
    request_id: row.request_id,
    agency_name: row.agency_name,
    pin: row.pin,
    vendor_name: row.vendor_name || null,
    contract_amount: row.contract_amount || null,
    title: row.short_title,
    notice_text: row.additional_description_1 || "",
    rolling_deadline: false,
  });
});

test.after(() => {
  globalThis.CrolActions = priorActions;
  globalThis.noticeActionMatter = priorMatter;
});

/* ---------- A3: positive vs prior negative hierarchy ---------- */

test("A3 negative fixture: trusted-click navigation branches and legacy projection marker are gone", () => {
  assert.doesNotMatch(MONEY_LIST_SOURCE, /moneyListInteractionProjection/);
  assert.doesNotMatch(MONEY_LIST_SOURCE, /event\.isTrusted&&row\?\.inspect_href/);
  assert.doesNotMatch(MONEY_LIST_SOURCE, /event\.isTrusted&&!row\?\.request_id&&row\?\.canonical_href/);
  assert.doesNotMatch(MONEY_LIST_SOURCE, /location\.assign\(row\.inspect_href\)/);
  assert.doesNotMatch(MONEY_LIST_SOURCE, /location\.assign\(row\.canonical_href\)/);
  // Planning-surface gating still keys off trusted reader input; only navigation
  // branches were removed from the primary inspect path.
  assert.match(MONEY_LIST_SOURCE, /event\.isTrusted/);
  assert.match(MONEY_LIST_SOURCE, /planningDetailRequested/);
  assert.match(MONEY_LIST_SOURCE, /contractResultUsesSharedDetail/);
  assert.match(MONEY_LIST_SOURCE, /bindContractResultInspection/);
});

test("A3 positive fixture: static title link, title-sized inspect, named full-record link", () => {
  const noticeHtml = renderContractResultInteractionsHTML(OPEN_SOLICITATION);
  const nativeHtml = renderContractResultInteractionsHTML(SOURCE_NATIVE);
  for (const html of [noticeHtml, nativeHtml]) {
    assert.match(html, new RegExp(`class="${CONTRACT_RESULT_TITLE_LINK_CLASS}`));
    assert.match(html, new RegExp(`class="${CONTRACT_RESULT_INSPECT_CLASS}`));
    assert.match(html, new RegExp(`class="${CONTRACT_RESULT_FULL_RECORD_CLASS}`));
    assert.match(html, />Open the full record</);
    assert.doesNotMatch(html, /onclick=/);
  }
  assert.match(noticeHtml, /href="\/notices\/20260624023"/);
  assert.match(nativeHtml, /href="\/procurements\/procurement%3A07122P0012063"/);
});

test("A3: contracts-money-list is conforming and the diverging-click baseline is gone", () => {
  const surface = BROWSE_INSPECTION_SURFACES.find((row) => row.surface_id === "contracts-money-list");
  assert.ok(surface);
  assert.equal(surface.classification, "conforming");
  assert.equal(surface.baseline_id, null);
  assert.equal(surface.detail_host, "inline_detail");
  assert.equal(surface.domain_adapter, "site/contract_result_inspection.mjs");
  assert.equal(surface.detail_host_module, "site/contract_result_inspection.mjs");
  assert.equal(surface.journey_owner, "test/contract_result_inspection.test.mjs");
  assert.equal(
    BROWSE_INSPECTION_LEGACY_BASELINE.some((row) => row.id === "contracts-row-click-diverges"),
    false,
  );
});

/* ---------- A1: unified inspection ---------- */

test("A1: notice-backed and source-native rows inspect through the same host without navigating", () => {
  const { list, detail, selected } = mountContractsList([OPEN_SOLICITATION, SOURCE_NATIVE]);
  assert.ok(list.hasAttribute(CONTRACT_RESULT_READY_ATTRIBUTE));

  const noticeUid = projectContractResultInspection(OPEN_SOLICITATION).uid;
  const nativeUid = projectContractResultInspection(SOURCE_NATIVE).uid;
  click(inspectButton(list, noticeUid));
  assert.equal(selected.index, 0);
  assert.match(detail.textContent, /Tub Grinder/i);
  assert.equal(
    detail.querySelector("[data-contract-result-detail]")?.getAttribute("data-contract-result-shape"),
    "notice_backed",
  );
  assert.equal(
    detail.querySelector(`.${CONTRACT_RESULT_FULL_RECORD_CLASS}`)?.getAttribute("href"),
    "/notices/20260624023",
  );

  click(inspectButton(list, nativeUid));
  assert.equal(selected.index, 1);
  assert.match(detail.textContent, /SHELTER FACILITIES FOR HOMELESS SINGLE ADULTS/);
  assert.match(detail.textContent, /Department of Homeless Services/);
  assert.match(detail.textContent, /procurement:07122P0012063/);
  assert.equal(
    detail.querySelector("[data-contract-result-detail]")?.getAttribute("data-contract-result-shape"),
    "source_native",
  );
  assert.equal(
    detail.querySelector(`.${CONTRACT_RESULT_FULL_RECORD_CLASS}`)?.getAttribute("href"),
    "/procurements/procurement%3A07122P0012063",
  );
  assert.equal(list.querySelectorAll(".money-row-card").length, 2);
});

test("A1: keyboard activation of inspect reaches the same selection behavior", () => {
  const { list, detail, selected } = mountContractsList([SOURCE_NATIVE]);
  const button = inspectButton(list, projectContractResultInspection(SOURCE_NATIVE).uid);
  keydown(button, "Enter");
  assert.equal(selected.count, 1);
  assert.match(detail.textContent, /SHELTER FACILITIES/);
  keydown(button, " ");
  assert.equal(selected.count, 2);
});

test("A1: explicit full-record destinations stay grounded for each shape", () => {
  assert.equal(contractResultFullRecordHref(OPEN_SOLICITATION), "/notices/20260624023");
  assert.equal(contractResultFullRecordHref(SOURCE_NATIVE), "/procurements/procurement%3A07122P0012063");
  assert.equal(
    contractResultFullRecordHref(ANALYTICAL),
    "/browse/contracts/?mode=award&ap_inspect=CT107120258801626",
  );
  const { list } = mountContractsList([OPEN_SOLICITATION, SOURCE_NATIVE, ANALYTICAL]);
  assert.equal(
    fullRecordLink(list, projectContractResultInspection(OPEN_SOLICITATION).uid).getAttribute("href"),
    "/notices/20260624023",
  );
  assert.equal(
    fullRecordLink(list, projectContractResultInspection(SOURCE_NATIVE).uid).getAttribute("href"),
    "/procurements/procurement%3A07122P0012063",
  );
  assert.equal(
    fullRecordLink(list, projectContractResultInspection(ANALYTICAL).uid).getAttribute("href"),
    "/browse/contracts/?mode=award&ap_inspect=CT107120258801626",
  );
});

/* ---------- A2: lifecycle and identity boundaries ---------- */

test("A2: open, expired, guide-only and award fixtures retain action rules", () => {
  assert.ok(OPEN_SOLICITATION && EXPIRED_SOLICITATION && GUIDE_ONLY_SOLICITATION && SOURCE_BACKED_AWARD);
  const open = moneyListPrimaryAction(OPEN_SOLICITATION, "2026-08-04");
  assert.equal(open?.action?.type, "official_application");
  assert.equal(moneyListPrimaryAction(EXPIRED_SOLICITATION, "2026-08-04"), null);
  const guide = moneyListPrimaryAction(GUIDE_ONLY_SOLICITATION, "2026-08-04");
  assert.equal(guide?.action?.type, "bid_checklist");
  assert.equal(guide?.href, "#notice/20260603042");
  const award = moneyListPrimaryAction(SOURCE_BACKED_AWARD, "2026-08-04");
  assert.equal(award?.action?.guide?.system, "award_lifecycle");

  const openHtml = renderContractResultInteractionsHTML(OPEN_SOLICITATION, {
    primaryAction: (row, day) => moneyListPrimaryAction(row, day),
    translate,
    today: "2026-08-04",
  });
  assert.match(openHtml, />Respond</);
  const expiredHtml = renderContractResultInteractionsHTML(EXPIRED_SOLICITATION, {
    primaryAction: (row, day) => moneyListPrimaryAction(row, day),
    translate,
    today: "2026-08-04",
  });
  assert.doesNotMatch(expiredHtml, /Respond|ui-object-card-action-rail/);
});

test("A2: missing notice identities never fabricate joins or successful empty details", () => {
  assert.equal(projectContractResultInspection(MISSING_NOTICE), null);
  assert.equal(contractResultUsesSharedDetail(MISSING_NOTICE), false);
  assert.equal(renderContractResultTitleClusterHTML(null), "");
  assert.equal(renderContractResultInspectionDetailHTML(null), "");
  const hybrid = projectContractResultInspection(HYBRID);
  assert.equal(hybrid.request_id, "20260818019");
  assert.equal(hybrid.procurement_id, "procurement:07122P0012063");
  assert.notEqual(hybrid.request_id, hybrid.procurement_id);
  assert.equal(contractResultUsesSharedDetail(SOURCE_NATIVE), true);
  assert.equal(contractResultUsesSharedDetail(OPEN_SOLICITATION), false);
  assert.equal(contractResultUsesSharedDetail(ANALYTICAL), true);
});

/* ---------- A4: journey variants ---------- */

test("A4: CSS keeps the title link until ready, then reveals inspect", () => {
  assert.match(BRAND_CSS, new RegExp(`\\.${CONTRACT_RESULT_INSPECT_CLASS}\\{[^}]*display:\\s*none`));
  assert.match(
    BRAND_CSS,
    new RegExp(`\\[${CONTRACT_RESULT_READY_ATTRIBUTE}\\] \\.${CONTRACT_RESULT_TITLE_LINK_CLASS}\\{[^}]*display:\\s*none`),
  );
  assert.match(
    BRAND_CSS,
    new RegExp(`\\[${CONTRACT_RESULT_READY_ATTRIBUTE}\\] \\.${CONTRACT_RESULT_INSPECT_CLASS}\\{[^}]*display:\\s*block`),
  );
});

test("A4: no-JavaScript keeps the grounded title link", () => {
  const html = renderContractResultInteractionsHTML(SOURCE_NATIVE);
  assert.match(
    html,
    new RegExp(`class="${CONTRACT_RESULT_TITLE_LINK_CLASS}[^"]*" href="/procurements/procurement%3A07122P0012063"`),
  );
  const { container } = mountDocument(`<div>${html}</div>`);
  const title = container.querySelector(`.${CONTRACT_RESULT_TITLE_LINK_CLASS}`);
  assert.equal(title.getAttribute("href"), "/procurements/procurement%3A07122P0012063");
  assert.equal(container.hasAttribute(CONTRACT_RESULT_READY_ATTRIBUTE), false);
});

test("A4: opening inspection never fetches a publisher and preserves the collection filter set", () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    requests.push(args);
    return Promise.reject(new Error("no request expected"));
  };
  try {
    const rows = [OPEN_SOLICITATION, SOURCE_NATIVE];
    const { list, detail } = mountContractsList(rows);
    assert.equal(list.querySelectorAll(".money-row-card").length, 2);
    click(inspectButton(list, projectContractResultInspection(SOURCE_NATIVE).uid));
    assert.match(detail.textContent, /SHELTER FACILITIES/);
    assert.equal(list.querySelectorAll(".money-row-card").length, 2);
    assert.equal(requests.length, 0);
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test("A4: rapid selection and failed detail keep the coherent summary and record link", () => {
  const { list, detail, selected } = mountContractsList([SOURCE_NATIVE, ANALYTICAL]);
  click(inspectButton(list, projectContractResultInspection(SOURCE_NATIVE).uid));
  click(inspectButton(list, projectContractResultInspection(ANALYTICAL).uid));
  assert.equal(selected.index, 1);
  assert.equal(selected.count, 2);
  assert.match(detail.textContent, /Registered analytics contract/);
  assert.equal(
    detail.querySelector("[data-contract-result-detail]")?.getAttribute("data-contract-result-shape"),
    "analytical",
  );

  const failed = renderContractResultInspectionDetailHTML(
    projectContractResultInspection(SOURCE_NATIVE),
    { failed: true },
  );
  assert.match(failed, /SHELTER FACILITIES FOR HOMELESS SINGLE ADULTS/);
  assert.match(failed, /Department of Homeless Services/);
  assert.match(failed, new RegExp(contractResultDetailFailureStatus().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(failed, /href="\/procurements\/procurement%3A07122P0012063"/);
  assert.match(failed, />Open the full record</);
});

test("A4: Copy and Respond stay distinct from inspect and full-record meanings", () => {
  const projection = contractResultInteractionProjection(OPEN_SOLICITATION, {
    today: "2026-08-04",
    primaryAction: (row, day) => moneyListPrimaryAction(row, day),
    translate,
  });
  assert.equal(projection.target.href, "/notices/20260624023");
  assert.equal(projection.copy_target, "https://cityscroll.org/notices/20260624023");
  assert.deepEqual(projection.kinetic_actions.map((action) => action.label), ["Respond"]);
  const html = renderContractResultInteractionsHTML(OPEN_SOLICITATION, {
    primaryAction: (row, day) => moneyListPrimaryAction(row, day),
    translate,
    today: "2026-08-04",
  });
  assert.match(html, /data-object-card-copy="https:\/\/cityscroll\.org\/notices\/20260624023"/);
  assert.match(html, />Respond</);
  assert.match(html, new RegExp(CONTRACT_RESULT_INSPECT_CLASS));
  assert.match(html, new RegExp(CONTRACT_RESULT_FULL_RECORD_CLASS));
});

test("A4: acceptance manifest records the journey with revision, route, viewport, and fixture vintage", () => {
  assert.equal(existsSync(EVIDENCE_PATH), true);
  const manifest = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.contract_result_inspection_acceptance.v1");
  assert.equal(manifest.record, "cityscroll-engineering/c175322a83f02");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.route, "/browse/contracts/");
  assert.ok(Array.isArray(manifest.viewport) && manifest.viewport.length === 2);
  assert.ok(manifest.fixture_vintage);
  assert.deepEqual(manifest.journey.sequence, [
    "set_scope_or_view",
    "inspect",
    "dismiss",
    "open_full_record",
    "return_with_back",
    "continue",
  ]);
  for (const variant of ["desktop", "narrow_touch", "keyboard", "no_javascript", "failed_detail"]) {
    assert.ok(manifest.journey.variants.includes(variant), variant);
  }
  assert.ok(manifest.assertions.some((row) => row.id === "reject-trusted-click-navigation" && row.result === "rejected"));
  assert.ok(manifest.assertions.some((row) => row.id === "primary-inspect-notice-and-source-native" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "failed-detail-keeps-summary-and-record-link" && row.result === "accepted"));
  for (const banned of ["needs_james", "card_standard", "richness_profile", "autodispatch", "realization_gate"]) {
    assert.equal(JSON.stringify(manifest).includes(banned), false, banned);
  }
  const digest = createHash("sha256").update(JSON.stringify(manifest.assertions) + "\n").digest("hex");
  assert.equal(manifest.assertions_sha256, digest);
});
