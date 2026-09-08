import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as traversal from "../site/traversal_path.mjs";
import "../site/app/entities.mjs";

// Frozen synthetic publisher rows; no named live record is a release prerequisite.
Object.assign(globalThis, {
  cleanText: (value) => String(value || ""),
  fdate: (value) => value,
  money: () => "",
  t: (key) => key,
  tSection: (value) => value,
});
const award = { request_id: "example-award", title: "Shelter services", date: "2026-01-01", notice_type: "Award", kind: "notice" };

test("vendor award links opt into traversal in expanded dates, single rows and chronological fallback", () => {
  const single = globalThis.vendorPhaseYearAggHTML({ count: 1, members: [award] }, "award", 0);
  const expanded = globalThis.vendorPhaseYearAggHTML({ count: 2, members: [award, { ...award, request_id: "other-award" }] }, "award", 0);
  const chrono = globalThis.vendorChronoRowHTML(award);
  const flat = globalThis.vendorTimelineFlatHTML([{ ...award, start_date: award.date, type_of_notice_description: "Award" }]);
  for (const html of [single, expanded, chrono, flat]) {
    assert.match(html, /href="#notice\/example-award"[^>]*data-pivot-schema="cityscroll.edge_summary.v1"/);
    assert.match(html, /data-pivot-relation-label="Award"/);
    assert.match(html, /data-pivot-target-kind="notice"/);
    assert.match(html, /data-pivot-target-id="example-award"/);
    assert.match(html, /data-pivot-target-name="Shelter services"/);
  }
});

test("a non-award vendor record does not assert that an award was received", () => {
  const html = globalThis.vendorChronoRowHTML({ ...award, notice_type: "Public Hearings" });
  assert.doesNotMatch(html, /data-pivot-relation-label="Award"/);
  assert.match(html, /data-pivot-relation-label="Public Hearings"/);
  assert.equal(globalThis.vendorTimelineFlatHTML([]), "");
});

test("a restored trail follows the notice when hydration replaces the initial active pane", () => {
  let existing = null;
  let removals = 0;
  const host = () => ({
    insertAdjacentHTML(_position, markup) {
      existing = { parentElement: this, outerHTML: markup, remove() { existing = null; removals++; } };
    },
  });
  const initialPane = host();
  const noticePane = host();
  let active = initialPane;
  const href = traversal.appendTraversalHop("/notices/example-award", {
    source: { href: "/vendors/example/", name: "Example vendor" },
    relation: "received award",
    destination: { href: "/notices/example-award", name: "Example award" },
  }).href;
  const context = {
    ...traversal,
    location: new URL(href, "https://cityscroll.org"),
    document: {
      body: null,
      querySelectorAll: () => [],
      querySelector(selector) {
        if (selector === ".traversal-path") return existing;
        if (selector === ".tabpane.active") return { querySelector: (id) => id === "#noticeview" ? active : null };
        return null;
      },
    },
  };
  const source = readFileSync(new URL("../site/app/traversal.mjs", import.meta.url), "utf8");
  runInNewContext(source.replace(/^import\s*\{[\s\S]*?\}\s*from[^;]+;/, ""), context);
  context.CrolTraversal.render();
  assert.equal(existing.parentElement, initialPane);
  active = noticePane;
  context.CrolTraversal.render();
  assert.equal(existing.parentElement, noticePane);
  assert.match(existing.outerHTML, /Example award/);
  assert.equal(removals, 1);
  context.CrolTraversal.render();
  assert.equal(removals, 1, "settled renders retain one trail without remounting it");
});
