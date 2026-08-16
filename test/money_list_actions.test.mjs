import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import actionRegistry from "../site/action_registry.js";
import { noticeDisplayTitle } from "../site/display_title.mjs";
import { solicitationResponseContextReady } from "../site/solicitation_response_context.mjs";
import {
  objectCardInteractionProjection,
  renderObjectCardActionRail,
  renderObjectCardPrimitives,
} from "../site/affordance_grammar.mjs";

const source = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");
const historySource = readFileSync(new URL("../site/app/money-history.mjs", import.meta.url), "utf8");
const openSnapshot = JSON.parse(readFileSync(new URL("./fixtures/money_action_field_cases.json", import.meta.url), "utf8"));
const awardSnapshot = JSON.parse(readFileSync(new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url), "utf8"));
const OPEN_SOLICITATION = openSnapshot.rows.find((row) => row.request_id === "20260624023");
const EXPIRED_SOLICITATION = openSnapshot.rows.find((row) => row.request_id === "20260624038");
const GUIDE_ONLY_SOLICITATION = openSnapshot.rows.find((row) => row.request_id === "20260603042");
const SOURCE_BACKED_AWARD = awardSnapshot.rows.find((row) => row.request_id === "20260723031");

function extractSourceFunction(contents, name) {
  const start = contents.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = contents.indexOf("{", start); i < contents.length; i += 1) {
    if (contents[i] === "{") { depth += 1; opened = true; }
    else if (contents[i] === "}" && opened && --depth === 0) return contents.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

function extractFunction(name) {
  return extractSourceFunction(source, name);
}

const {
  moneyListPrimaryAction,
  moneyListPrimaryActionHTML,
  moneyListInteractionProjection,
  moneyListCardInteractionsHTML,
} = new Function(
  "t", "todayISO", "escUiHtml", "noticeDisplayTitle", "solicitationResponseContextReady",
  "objectCardInteractionProjection", "renderObjectCardActionRail", "renderObjectCardPrimitives",
  `${extractFunction("moneyListPrimaryAction")}
   ${extractFunction("moneyListInteractionProjection")}
   ${extractFunction("moneyListPrimaryActionHTML")}
   ${extractFunction("moneyListCardInteractionsHTML")}
   return { moneyListPrimaryAction, moneyListPrimaryActionHTML, moneyListInteractionProjection, moneyListCardInteractionsHTML };`,
)(
  (key) => ({
    respond_lbl: "Respond",
    award_guide_heading: "Follow this award",
    untitled_notice: "Untitled notice",
    copy_link: "Copy link",
    next_action_heading: "What can I do now?",
    ext_link_new_tab_sr: "(opens in new tab)",
  })[key] || key,
  () => "2026-08-04",
  (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  noticeDisplayTitle,
  solicitationResponseContextReady,
  objectCardInteractionProjection,
  renderObjectCardActionRail,
  renderObjectCardPrimitives,
);

const priorActions = globalThis.CrolActions;
const priorMatter = globalThis.noticeActionMatter;

test.before(() => {
  globalThis.CrolActions = actionRegistry;
  globalThis.noticeActionMatter = (row) => ({
    kind: row.type_of_notice_description === "Solicitation" ? "solicitation"
      : row.type_of_notice_description === "Award" ? "award" : "notice",
    type_of_notice_description: row.type_of_notice_description,
    deadline: row.due_date || null,
    official_notice_url: `https://a856-cityrecord.nyc.gov/RequestDetail/${row.request_id}`,
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

test("open solicitation reuses the registry destination and exposes one named primary action", () => {
  assert.ok(OPEN_SOLICITATION, "committed open-money snapshot must retain the field case");
  const result = moneyListPrimaryAction(OPEN_SOLICITATION, "2026-08-04");
  assert.equal(result.kind, "solicitation");
  assert.equal(result.action.type, "official_application");
  assert.equal(result.action.delivery, "official_handoff");
  assert.equal(result.href, result.action.destination);
  assert.match(result.href, /passport|a0333-passportpublic/i);

  const html = moneyListPrimaryActionHTML(OPEN_SOLICITATION, "2026-08-04");
  assert.match(html, /<h3>What can I do now\?<\/h3>/);
  assert.match(html, /class="ui-external-action primary"/);
  assert.match(html, />Respond<span aria-hidden="true">↗<\/span>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test("expired solicitation omits the row action instead of presenting a dead response", () => {
  assert.ok(EXPIRED_SOLICITATION, "committed open-money snapshot must retain the field case");
  assert.equal(moneyListPrimaryAction(EXPIRED_SOLICITATION, "2026-08-04"), null);
  assert.equal(moneyListPrimaryActionHTML(EXPIRED_SOLICITATION, "2026-08-04"), "");
});

test("solicitation without named, actionable response context omits the row action", () => {
  assert.equal(moneyListPrimaryAction({
    request_id: "20260815001",
    type_of_notice_description: "Solicitation",
    selection_method_description: "Request for Proposals",
  }, "2026-08-04"), null);
});

test("source-backed award fields reuse award guidance and Checkbook classification", () => {
  assert.ok(SOURCE_BACKED_AWARD, "committed award warehouse snapshot must retain the field case");
  const result = moneyListPrimaryAction(SOURCE_BACKED_AWARD, "2026-08-04");
  assert.equal(result.kind, "award");
  assert.equal(result.action.guide.system, "award_lifecycle");
  assert.equal(result.action.type, "document");
  assert.equal(result.href, result.action.destination);
  assert.match(result.href, /checkbooknyc\.com/);
  assert.doesNotMatch(result.action.label_key, /bid|response/i);
});

test("guide-only actions open the exact notice detail", () => {
  assert.ok(GUIDE_ONLY_SOLICITATION, "committed open-money snapshot must retain the field case");
  const guide = moneyListPrimaryAction(GUIDE_ONLY_SOLICITATION, "2026-08-04");
  assert.equal(guide.action.type, "bid_checklist");
  assert.equal(guide.external, false);
  assert.equal(guide.href, "#notice/20260603042");
});

test("adapter delegates interpretation to noticeActionMatter and compileActionRail", () => {
  const adapter = extractFunction("moneyListPrimaryAction");
  assert.match(adapter, /globalThis\.noticeActionMatter\(r\)/);
  assert.match(adapter, /CrolActions\.compileActionRail\(matter/);
  assert.doesNotMatch(adapter, /passport|checkbook|isupplier|due_date|notice_text/i);
});

test("Money row keeps the whole row as a selector while shared controls remain native controls", () => {
  const rowSource = extractFunction("moneyRowHTML");
  assert.match(rowSource, /<article class="money-row-card">\s*<div class="row"/);
  assert.match(rowSource, /\$\{interactions\|\|/);
  assert.doesNotMatch(rowSource, /<a\b[^>]*class="money-row-card"/);
});

test("Contracts rows adopt the shared object-card interaction grammar", () => {
  const projection = moneyListInteractionProjection(OPEN_SOLICITATION, "2026-08-04");
  assert.equal(projection.target.href, "/notices/20260624023");
  assert.equal(projection.copy_target, "https://cityscroll.org/notices/20260624023");
  assert.deepEqual(projection.kinetic_actions.map((action) => action.label), ["Respond"]);

  const html = moneyListCardInteractionsHTML(OPEN_SOLICITATION, "<mark>Tub Grinder</mark>", "2026-08-04");
  assert.match(html, /class="ui-constellation-link ui-object-card-title rtitle"[^>]*href="\/notices\/20260624023"/);
  assert.match(html, /<span aria-hidden="true">◆<\/span><mark>Tub Grinder<\/mark>/);
  assert.match(html, /data-object-card-copy="https:\/\/cityscroll\.org\/notices\/20260624023"[^>]*>Copy link<\/button>/);
  assert.match(html, /<h3>What can I do now\?<\/h3>/);
  assert.match(html, />Respond<span aria-hidden="true">↗<\/span>/);
});

test("context-incomplete Contracts rows keep title and Copy but omit Respond and its rail", () => {
  const row = {
    request_id: "20260815001",
    short_title: "Neighborhood food services",
    type_of_notice_description: "Solicitation",
    selection_method_description: "Request for Proposals",
  };
  const html = moneyListCardInteractionsHTML(row, "Neighborhood food services", "2026-08-04");
  assert.match(html, /href="\/notices\/20260815001"/);
  assert.match(html, /data-object-card-copy="https:\/\/cityscroll\.org\/notices\/20260815001"/);
  assert.doesNotMatch(html, /Respond|ui-object-card-action-rail|What can I do now/);
});

test("the Contracts preview reuses the row projection for its linked title and canonical Copy target", () => {
  const heading = extractSourceFunction(historySource, "solicitationContextHeadingHTML");
  const detail = extractSourceFunction(historySource, "renderDetail");
  assert.match(heading, /globalThis\.moneyListInteractionProjection\?\.\(r\)/);
  assert.match(heading, /renderObjectCardTitle\(projection/);
  assert.match(detail, /detailProjection\?\.copy_target\|\|noticeLink\(r\.request_id\)/);
});
