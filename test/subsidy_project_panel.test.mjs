import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildSubsidyProjectPanelView,
  subsidyProjectPanelHTML,
} from "../site/subsidy_project_panel.mjs";

const lookup = JSON.parse(readFileSync(new URL("../site/data/subsidy_project_lookup.json", import.meta.url)));
const subsidyApp = readFileSync(new URL("../site/app/subsidy.mjs", import.meta.url), "utf8");

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const money = (value) => `$${Number(value).toLocaleString("en-US")}`;
const date = (value) => new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(`${value}T00:00:00Z`));

test("receipt-backed project panel exposes only accepted source fields", () => {
  const projects = lookup.by_notice["20251229015"];
  const view = buildSubsidyProjectPanelView({ project_identity: projects });

  assert.equal(view.show, true);
  assert.equal(view.count, 2);
  assert.equal(view.projects.length, 2, "count-equals-list");
  assert.equal(view.projects[0].project_name, "Grace Church School");
  assert.equal(view.projects[0].company, "Grace Church School");
  assert.equal(view.projects[0].address, "86 4th Avenue, New York, NY");
  assert.equal(view.projects[0].requested_benefit, 39200000);
  assert.equal(view.projects[0].estimated_public_cost, 2179198);
  assert.deepEqual(view.projects[0].lifecycle_dates, [
    { stage: "board_decision", date: "2026-01-27", outcome: "approved" },
  ]);
  assert.match(view.projects[0].official_documents_url, /^https:\/\/edc\.nyc\//);
});

test("project panel renders positive facts, lifecycle date chips, and exact list count", () => {
  const projects = lookup.by_notice["20251229015"];
  const html = subsidyProjectPanelHTML({ project_identity: projects }, { esc, money, date });

  assert.match(html, /data-subsidy-project-panel="1"/);
  assert.match(html, /data-project-count="2"/);
  assert.equal((html.match(/data-subsidy-project="1"/g) || []).length, 2);
  assert.match(html, /Grace Church School/);
  assert.match(html, /Xaverian High School/);
  assert.match(html, /Requested benefit/);
  assert.match(html, /Estimated public cost/);
  assert.match(html, /Board decision · Jan 27, 2026/);
  assert.match(html, /Official project documents/);
  assert.doesNotMatch(html, /possible project match|unmatched|below threshold|not available|unknown/i);
  assert.doesNotMatch(html, /\$Jan|\$Feb|\$Mar|\$Apr|\$May|\$Jun|\$Jul|\$Aug|\$Sep|\$Oct|\$Nov|\$Dec/);
});

test("unmatched and untrusted payloads preserve honest absence", () => {
  assert.equal(subsidyProjectPanelHTML(null, { esc, money, date }), "");
  assert.equal(subsidyProjectPanelHTML({ project_identity: [] }, { esc, money, date }), "");
  assert.equal(subsidyProjectPanelHTML({
    project_identity: [{
      receipt_backed: false,
      project_name: "Speculative project",
      company: "Speculative company",
    }],
  }, { esc, money, date }), "");
});

test("notice subsidy loader mounts the receipt-backed panel inside the existing lifecycle slot", () => {
  assert.match(subsidyApp, /ensureSubsidyProjectPanelTools/);
  assert.match(subsidyApp, /subsidyProjectPanelHTML\(data/);
  assert.match(subsidyApp, /timeZone:\s*["']UTC["']/);
  assert.doesNotMatch(subsidyApp, /getElementById\(["']nsubsidyproject/);
});
