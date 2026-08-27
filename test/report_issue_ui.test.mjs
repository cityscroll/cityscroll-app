import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContractReportTarget,
  buildContractVendorRelationshipReportTarget,
  buildProjectParcelRelationshipReportTarget,
  reportIssueAction,
  renderReportIssueAffordance,
  REPORT_CATEGORIES,
} from "../site/report_issue.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";

const contract = {
  procurement_id: "procurement:contract:CT123",
  canonical_href: "/procurements/procurement%3Acontract%3ACT123",
  short_title: "Street repair contract",
  vendor_name: "Acme Works",
  source_observation_refs: ["passport_public_contracts:row-1"],
};

test("Contract report affordance carries the exact Card 1 target", () => {
  const target = buildContractReportTarget(contract);
  assert.equal(target.claim_anchor.anchor, "contract:CT123#vendor");
  assert.equal(target.description, "Street repair contract: Acme Works");
  const html = renderReportIssueAffordance(target);
  assert.match(html, /data-report-target=/);
  assert.match(html, />Report an issue<\/button>/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /procurement%3Acontract%3ACT123/);
});

test("vendor anchors prune the report vocabulary and target construction fails closed", () => {
  assert.deepEqual(REPORT_CATEGORIES.map((item) => item.value), [
    "information_wrong", "connection_wrong", "same_thing", "different_things",
    "something_missing", "interpretation_wrong", "other",
  ]);
  assert.equal(buildContractReportTarget({
    procurement_id: "procurement:contract:CT123",
    canonical_href: "https://example.test/wrong-place",
    short_title: "Unanchored contract",
  }), null);
  assert.equal(renderReportIssueAffordance(null), "");
  assert.match(reportIssueAction(null).href, /about\.html#feedback/);
});

test("report target builders and markup stay total for incomplete rows", () => {
  for (const value of [null, undefined, "not a row", 42, {}, { procurement_id: null }]) {
    assert.doesNotThrow(() => buildContractReportTarget(value));
    assert.equal(buildContractReportTarget(value), null);
    assert.doesNotThrow(() => renderReportIssueAffordance(buildContractReportTarget(value)));
    assert.equal(renderReportIssueAffordance(buildContractReportTarget(value)), "");
  }
  assert.equal(buildContractReportTarget(contract, null).description, "Street repair contract: Acme Works");
  assert.equal(renderReportIssueAffordance({ bad: true }), "");
});

test("static Contract documents expose the same report target and browser module", () => {
  const html = renderProcurementDocument({
    ...contract,
    identity_keys: { contract_ids: ["CT123"] },
  }, [{
    source_observation_ref: "passport_public_contracts:row-1",
    source_system: "passport_public_contracts",
    snapshot: { title: contract.short_title, vendor_name: contract.vendor_name },
  }]);
  assert.match(html, /<script type="module" src="\/report_issue\.mjs"><\/script>/);
  assert.match(html, />Report an issue<\/button>/);
  assert.match(html, /data-report-target=/);
  assert.match(html, /contract:CT123#vendor/);
});

test("relationship affordances show both civic endpoints without exposing schema terms", () => {
  const contractTarget = buildContractVendorRelationshipReportTarget({
    procurement_id: "procurement:contract:CT123",
    canonical_href: "/procurements/procurement%3Acontract%3ACT123",
    short_title: "Street repair contract",
    vendor_name: "Acme Works",
  });
  const parcelTarget = buildProjectParcelRelationshipReportTarget({
    project_id: "2026M0258",
    project_name: "Avenue project",
  }, {
    ref: "bbl:1006440001",
    label: "Manhattan — Block 644, Lot 1",
    relation: "sited_on_parcel",
  });

  for (const [html, subject, object] of [
    [renderReportIssueAffordance(contractTarget), "Street repair contract", "Acme Works"],
    [renderReportIssueAffordance(parcelTarget), "Avenue project", "Manhattan — Block 644, Lot 1"],
  ]) {
    assert.match(html, />Report an issue<\/button>/);
    assert.doesNotMatch(html, /aria-label=/);
    assert.match(html, new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(object.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(contractTarget.description, /relation_type|subject_id|object_id/);
  assert.doesNotMatch(parcelTarget.description, /relation_type|subject_id|object_id/);
});

test("report module contains navigation teardown and submits the immutable target", async () => {
  const source = await import("../site/report_issue.mjs").then(() => null);
  assert.equal(source, null);
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(new URL("../site/report_issue.mjs", import.meta.url), "utf8");
  assert.match(text, /hashchange/);
  assert.match(text, /report_target: activeTarget/);
  assert.match(text, /form\.dataset\.targetId !== activeTarget\.target_id/);
});
