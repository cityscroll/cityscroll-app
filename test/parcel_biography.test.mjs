import assert from "node:assert/strict";
import test from "node:test";

import {
  buildParcelBiographyEdgeSummary,
  observedParcelBiographyHTML,
} from "../site/parcel_biography_ui.mjs";

const escape = (value) => String(value ?? "").replace(/[<>&'"]/g, (char) => ({
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&#39;",
  '"': "&quot;",
}[char]));

const view = {
  ok: true,
  bbl: "1020260015",
  parcel_ref: "bbl:1020260015",
  sections: {
    property: {
      status: "observed",
      items: [{
        subject_ref: "notice:20260101001",
        label: "Disposition notice",
        date: "2026-01-01",
        href: "#notice/20260101001",
      }],
      coverage: { vintage: "2026-08-12" },
    },
    land: { status: "not_observed", items: [], coverage: { vintage: "2026-08-12" } },
    tax_lien: { status: "unknown", items: [], coverage: { vintage: null } },
    ll48: { status: "not_observed", items: [], coverage: { vintage: "2025-09-17" } },
    cofo: {
      status: "observed",
      items: [{
        subject_ref: "cofo:320596262",
        label: "Final",
        date: "2019-05-13",
        href: "#property?facet=cofo",
      }],
      coverage: { vintage: "2026-08-05" },
    },
  },
};

const helpers = {
  escape,
  t: (key) => key,
  pivot: (_href, label) => `<a href="${escape(_href)}">${label}</a>`,
  parcelPivot: (_bbl, label) => label,
  formatDate: (value) => value,
  stageLabel: (value) => value || "stage",
  outcomeLabel: (value) => value || "outcome",
};

test("parcel biography summarizes every supported family and preserves typed detail targets", () => {
  const records = buildParcelBiographyEdgeSummary(view);
  assert.deepEqual(records.map((record) => record.state), ["matched", "empty", "unknown", "empty", "matched"]);
  assert.deepEqual(records.map((record) => record.count), [1, 0, null, 0, 1]);
  assert.ok(records.every((record) => record.schema === "cityscroll.edge_summary.v1"));
  assert.ok(records.every((record, index) => record.href === `#parcel-biography-${["property", "land", "tax_lien", "ll48", "cofo"][index]}`));

  const html = observedParcelBiographyHTML(view, helpers);
  assert.equal((html.match(/data-edge-summary-schema="cityscroll\.edge_summary\.v1"/g) || []).length, 1);
  assert.equal((html.match(/class="edge-summary-item"/g) || []).length, 5);
  assert.match(html, /data-edge-state="matched"[^>]*data-edge-availability="available"/);
  assert.match(html, /data-edge-state="empty"[^>]*data-edge-availability="empty-in-scope"/);
  assert.match(html, /data-edge-state="unknown"[^>]*data-edge-availability="unknown-unindexed"/);
  assert.match(html, /Available: 1 record/);
  assert.match(html, /Empty in this scoped materialization/);
  assert.match(html, /Unknown \/ not indexed/);
  for (const kind of ["property", "land", "tax_lien", "ll48", "cofo"]) {
    assert.match(html, new RegExp(`id="parcel-biography-${kind}"`));
  }
  for (const kind of ["property", "cofo"]) {
    assert.match(html, new RegExp(`href="#parcel-biography-${kind}"`));
  }
  for (const kind of ["land", "tax_lien", "ll48"]) {
    assert.doesNotMatch(html, new RegExp(`<a[^>]+href="#parcel-biography-${kind}"`));
  }
  assert.match(html, /href="https:\/\/a856-cityrecord\.nyc\.gov\/RequestDetail\/20260101001"/);
});
