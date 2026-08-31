import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgencyConstellationClaimReportTarget,
  buildAgencyConstellationReportTarget,
  buildLandRegulatoryEffectReportTarget,
  buildMeetingGroupingReportTarget,
  buildRulemakingLifecycleReportTarget,
  buildContractReportTarget,
  buildContractVendorRelationshipReportTarget,
  buildProjectParcelRelationshipReportTarget,
  reportIssueAction,
  renderReportIssueAffordance,
  REPORT_CATEGORIES,
} from "../site/report_issue.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULEMAKING_LIFECYCLE_FIXTURES = JSON.parse(readFileSync(
  join(ROOT, "test/fixtures/report_target/rulemaking_lifecycle.json"),
  "utf8",
));
const AGENCY_CLAIM_FIXTURES = JSON.parse(readFileSync(
  join(ROOT, "test/fixtures/report_target/agency_claim_deep_link.json"),
  "utf8",
));

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

test("grouping and derived-meaning affordances render the durable target", () => {
  const meetingTarget = buildMeetingGroupingReportTarget({
    kind: "event",
    notice_count: 2,
    primary: { meeting_id: "meeting:city_record:20260814001", title: "Public hearing" },
    members: [
      { request_id: "20260814001", source_url: "https://example.test/1" },
      { request_id: "20260814002", source_url: "https://example.test/2" },
    ],
  });
  const landTarget = buildLandRegulatoryEffectReportTarget({
    project_id: "2026K0123",
    project_name: "1550 Bedford Avenue Rezoning",
    regulatory_effect: "upzone",
    regulatory_effect_confidence: "high",
    regulatory_effect_basis: {
      existing: { districts: [{ citation: { url: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-21" } }] },
      proposed: { districts: [{ citation: { url: "https://zr.planning.nyc.gov/article-ii/chapter-3/23-22" } }] },
    },
  });
  const rulesTarget = buildRulemakingLifecycleReportTarget(RULEMAKING_LIFECYCLE_FIXTURES.eligible);

  for (const [target, anchor] of [
    [meetingTarget, "meeting:city_record:20260814001#collapsed_notices"],
    [landTarget, "landuse:2026K0123#regulatory-effect"],
    [rulesTarget, "rulemaking:hpd:natural-gas-detectors#lifecycle"],
  ]) {
    const html = renderReportIssueAffordance(target);
    assert.match(html, />Report an issue<\/button>/);
    assert.match(html, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(target.description, /\S/);
    assert.ok(target.constituent_object_ids.length);
  }
  for (const { name, entry } of RULEMAKING_LIFECYCLE_FIXTURES.ineligible) {
    assert.equal(
      renderReportIssueAffordance(buildRulemakingLifecycleReportTarget(entry)),
      "",
      `${name} must omit the contextual report action`,
    );
  }
});

test("higher-inference cards use the shared report target affordance", async () => {
  const fs = await import("node:fs/promises");
  const [meetings, land, rules, index] = await Promise.all([
    fs.readFile(new URL("../site/app/feed-actions.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../site/app/land.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../site/app/rules.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../site/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(meetings, /buildMeetingGroupingReportTarget/);
  assert.match(meetings, /renderReportIssueAffordance/);
  assert.match(land, /buildLandRegulatoryEffectReportTarget/);
  assert.match(land, /renderReportIssueAffordance/);
  assert.match(rules, /buildRulemakingLifecycleReportTarget/);
  assert.match(rules, /renderReportIssueAffordance/);
  assert.match(rules, /function rulesExplorerCardHTML/);
  const cardTemplate = rules.slice(
    rules.indexOf("function rulesExplorerCardHTML"),
    rules.indexOf("let rulesActionBandToolsPromise"),
  );
  assert.match(cardTemplate, /buildRulemakingLifecycleReportTarget\(entry\)/);
  assert.match(cardTemplate, /ui-object-card-report/);
  assert.match(index, /data-i18n="footer_feedback">Feedback/);
  assert.match(reportIssueAction(null).href, /about\.html#feedback/);
  const agency = await fs.readFile(new URL("../site/agency_constellation.mjs", import.meta.url), "utf8");
  assert.match(agency, /buildAgencyConstellationClaimReportTarget/);
  assert.match(agency, /activeClaimId/);
  const claimHtml = renderReportIssueAffordance(buildAgencyConstellationClaimReportTarget({
    ...AGENCY_CLAIM_FIXTURES.profile,
    claim: AGENCY_CLAIM_FIXTURES.staffing_claim,
    activeClaimId: AGENCY_CLAIM_FIXTURES.staffing_claim.claim_id,
  }));
  assert.match(claimHtml, />Report an issue<\/button>/);
  assert.match(claimHtml, /staffing:exam:6306/);
  assert.doesNotMatch(claimHtml, /agency:id:police-department#identity/);
  assert.equal(
    renderReportIssueAffordance(buildAgencyConstellationReportTarget({
      ...AGENCY_CLAIM_FIXTURES.profile,
      activeClaimId: "staffing:exam:6306",
    })),
    "",
  );
  const eligibleHtml = renderReportIssueAffordance(
    buildRulemakingLifecycleReportTarget(RULEMAKING_LIFECYCLE_FIXTURES.eligible),
  );
  assert.match(eligibleHtml, />Report an issue<\/button>/);
  assert.doesNotMatch(eligibleHtml, />Feedback</);
});

test("report module contains navigation teardown and submits the immutable target", async () => {
  const source = await import("../site/report_issue.mjs").then(() => null);
  assert.equal(source, null);
  const fs = await import("node:fs/promises");
  const [text, styles] = await Promise.all([
    fs.readFile(new URL("../site/report_issue.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../site/brand.css", import.meta.url), "utf8"),
  ]);
  assert.match(text, /hashchange/);
  assert.match(text, /report_target: activeTarget/);
  assert.match(text, /form\.dataset\.targetId !== activeTarget\.target_id/);
  assert.match(text, /Which existing profile is this report about\?/);
  assert.match(text, /Find a profile/);
  assert.match(text, /data-report-identity/);
  assert.match(text, /const comparisonAvailable = hasIdentityComparisonCandidates/);
  assert.match(text, /identityPicker\.hidden = !comparisonAvailable/);
  assert.match(text, /if \(isIdentity\) loadIdentityCandidates\(target\)/);
  assert.match(styles, /\.report-identity-picker/);
  assert.match(text, /activeTarget = buildReportTarget\(/);
});
