import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import actionRegistry from "../site/action_registry.js";
import { noticeDisplayTitle } from "../site/display_title.mjs";

const source = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");
const openSnapshot = JSON.parse(readFileSync(new URL("./fixtures/money_action_field_cases.json", import.meta.url), "utf8"));
const awardSnapshot = JSON.parse(readFileSync(new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url), "utf8"));
const OPEN_SOLICITATION = openSnapshot.rows.find((row) => row.request_id === "20260624023");
const EXPIRED_SOLICITATION = openSnapshot.rows.find((row) => row.request_id === "20260624038");
const GUIDE_ONLY_SOLICITATION = openSnapshot.rows.find((row) => row.request_id === "20260603042");
const SOURCE_BACKED_AWARD = awardSnapshot.rows.find((row) => row.request_id === "20260723031");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") { depth += 1; opened = true; }
    else if (source[i] === "}" && opened && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

const { moneyListPrimaryAction, moneyListPrimaryActionHTML } = new Function(
  "t", "todayISO", "cleanText", "escUiHtml", "EXT_ATTRS", "extSR", "noticeDisplayTitle",
  `${extractFunction("moneyListPrimaryAction")}
   ${extractFunction("moneyListPrimaryActionHTML")}
   return { moneyListPrimaryAction, moneyListPrimaryActionHTML };`,
)(
  (key) => ({ respond_lbl: "Respond", award_guide_heading: "Follow this award", untitled_notice: "Untitled notice" })[key] || key,
  () => "2026-08-04",
  (value) => String(value || "").replace(/<[^>]*>/g, "").trim(),
  (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  'target="_blank" rel="noopener noreferrer"',
  () => '<span class="sr-only"> (opens in new tab)</span>',
  noticeDisplayTitle,
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
  assert.equal((html.match(/data-money-row-action=/g) || []).length, 1);
  assert.match(html, />Respond<span class="sr-only"[^>]*> — 85726B0060-2600042 - Tub Grinder - Parks<\/span>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test("expired solicitation omits the row action instead of presenting a dead response", () => {
  assert.ok(EXPIRED_SOLICITATION, "committed open-money snapshot must retain the field case");
  assert.equal(moneyListPrimaryAction(EXPIRED_SOLICITATION, "2026-08-04"), null);
  assert.equal(moneyListPrimaryActionHTML(EXPIRED_SOLICITATION, "2026-08-04"), "");
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

test("Money row keeps action and detail selector as sibling controls in action-first order", () => {
  const rowSource = extractFunction("moneyRowHTML");
  assert.match(rowSource, /<article class="money-row-card">\s*\$\{primaryAction\}\s*<div class="row"/);
  assert.doesNotMatch(rowSource, /<div class="row"[^>]*>\s*\$\{primaryAction\}/);
});
