import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  mandateMatterEdgeFromRow,
  mandateReportsNavLabel,
  mandateReportsSectionTitle,
  mandateRulesNavLabel,
  mandateRulesSectionTitle,
  mandateRulesStatusParts,
  normalizeMandateGraphNeighbors,
  renderMandateRowGraphActions,
  renderMandateSectionNeighborActions,
} from "../site/mandate_graph_neighbors.mjs";
import {
  buildMandateRulesBridgeView,
  renderMandateRulesBridgeSection,
} from "../site/mandate_rules_bridge.mjs";
import {
  buildMandateReportsReceiptView,
  renderMandateReportsReceiptSection,
} from "../site/mandate_reports_receipt.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
  agencyCategoryBrowseHref,
} from "../site/agency_constellation.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARKS = "parks-and-recreation";

const intelligence = JSON.parse(
  readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"),
);
const certification = JSON.parse(
  readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"),
);
const obligations = existsSync(join(ROOT, "site/data/agency_obligations_lookup.json"))
  ? JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"))
  : null;
const processConformance = existsSync(join(ROOT, "site/data/process_conformance_lookup.json"))
  ? JSON.parse(readFileSync(join(ROOT, "site/data/process_conformance_lookup.json"), "utf8"))
  : null;

test("matter edge is exact matter_id + Gateway source-law URL only", () => {
  const edge = mandateMatterEdgeFromRow({
    matter_id: "60950",
    source: { legistar_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=60950" },
  });
  assert.equal(edge.relation, "source_law");
  assert.equal(edge.matter_id, "60950");
  assert.equal(edge.href, "https://nyc.legistar.com/Gateway.aspx?M=L&ID=60950");
  assert.equal(mandateMatterEdgeFromRow({}), null);
  // matter_id alone still builds Gateway URL — never invents GUID detail form.
  const fromId = mandateMatterEdgeFromRow({ matter_id: "52278" });
  assert.equal(fromId.href, "https://nyc.legistar.com/Gateway.aspx?M=L&ID=52278");
});

test("honest section titles drop edge-sounding copy when no public joins", () => {
  assert.equal(mandateRulesSectionTitle({ observed_links: 0 }), "Rulemaking mandates");
  assert.equal(
    mandateRulesSectionTitle({ observed_links: 2 }),
    "Rulemaking mandates · Rules activity",
  );
  assert.equal(mandateReportsSectionTitle({ filing_receipts: 0 }), "Report mandates");
  assert.equal(
    mandateReportsSectionTitle({ filing_receipts: 1 }),
    "Report mandates · Filing receipts",
  );
  assert.equal(mandateRulesNavLabel({ observed_links: 0 }), "Rulemaking mandates");
  assert.equal(mandateReportsNavLabel({ filing_receipts: 0 }), "Report mandates");
  assert.deepEqual(
    mandateRulesStatusParts({
      rulemaking_mandates: 4,
      rules_filings: 4,
      observed_links: 0,
    }),
    ["4 rulemaking mandates", "4 Rules filings"],
  );
});

test("per-row graph actions include Source law diamond Open-in scopes", () => {
  const neighbors = normalizeMandateGraphNeighbors({
    rules_browse_href: "/browse/rules/?agency=Parks",
    meetings_browse_href: "/browse/meetings/?agency=Parks",
    contracts_browse_href: "/browse/contracts/?agency=Parks",
  });
  const html = renderMandateRowGraphActions({
    source_href: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=60950",
    matter_id: "60950",
    graph_neighbors: neighbors,
    prefer: "rules",
  });
  assert.match(html, /Source law/);
  assert.match(html, /data-mandate-edge="source_law"/);
  assert.match(html, /data-matter-id="60950"/);
  assert.match(html, /Open in Rules/);
  assert.match(html, /Open in Meetings/);
  assert.match(html, /Open in Contracts/);
  assert.match(html, /ui-constellation-link/);
  assert.match(html, /ui-official-source-link/);
  // Prefer Rules first among open-in links.
  const rulesAt = html.indexOf("Open in Rules");
  const meetingsAt = html.indexOf("Open in Meetings");
  assert.ok(rulesAt >= 0 && meetingsAt > rulesAt);
  const chrome = renderMandateSectionNeighborActions({ graph_neighbors: neighbors });
  assert.match(chrome, /Open in Rules/);
  assert.match(chrome, /Open in Meetings/);
  assert.match(chrome, /Open in Contracts/);
});

test("Parks rules rows always open Source law + Open in Rules (zero observed links)", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const rulesBrowse = agencyCategoryBrowseHref(PARKS, "rules");
  const meetingsBrowse = agencyCategoryBrowseHref(PARKS, "meetings");
  const contractsBrowse = agencyCategoryBrowseHref(PARKS, "contracts");
  const view = buildMandateRulesBridgeView(PARKS, {
    obligationsLookup: obligations,
    rulesItems: [
      { id: "20260714029", label: "Demo rules filing", when: "2026-07-14" },
    ],
    rulesCount: 1,
    rulesBrowseHref: rulesBrowse,
    meetingsBrowseHref: meetingsBrowse,
    contractsBrowseHref: contractsBrowse,
  });
  assert.equal(view.status, "matched");
  assert.equal(view.counts.observed_links, 0);
  assert.equal(view.section_title, "Rulemaking mandates");
  assert.ok(view.mandates.every((m) => m.source_href && m.matter_id));
  assert.ok(view.graph_neighbors?.rules_browse_href);

  const html = renderMandateRulesBridgeSection(view);
  assert.match(html, /<h2>Rulemaking mandates /);
  assert.doesNotMatch(html, /Rulemaking mandates · Rules activity/);
  assert.doesNotMatch(html, /0 linked filing/);
  assert.match(html, /data-mandate-edges="co-located-only"/);
  // Every mandate row carries Source law + Open in Rules.
  const rows = html.match(/class="node-record mandate-rules-mandate"/g) || [];
  assert.ok(rows.length >= 1);
  const sourceLaw = html.match(/data-mandate-edge="source_law"/g) || [];
  const openRules = html.match(/data-mandate-graph-neighbor="rules"/g) || [];
  assert.ok(sourceLaw.length >= rows.length, "each row has Source law");
  assert.ok(openRules.length >= rows.length, "each row has Open in Rules");
  // Section chrome still exposes Meetings + Contracts scopes.
  assert.match(html, /data-mandate-graph-neighbor="meetings"/);
  assert.match(html, /data-mandate-graph-neighbor="contracts"/);
  assert.match(html, /Gateway\.aspx\?M=L&amp;ID=/);
});

test("Parks reports H2 is Report mandates when filing_receipts is zero", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const view = buildMandateReportsReceiptView(PARKS, {
    obligationsLookup: obligations,
    rulesBrowseHref: agencyCategoryBrowseHref(PARKS, "rules"),
    meetingsBrowseHref: agencyCategoryBrowseHref(PARKS, "meetings"),
    contractsBrowseHref: agencyCategoryBrowseHref(PARKS, "contracts"),
  });
  assert.equal(view.status, "matched");
  assert.equal(view.counts.filing_receipts, 0);
  assert.equal(view.section_title, "Report mandates");
  const html = renderMandateReportsReceiptSection(view);
  assert.match(html, /<h2>Report mandates /);
  assert.doesNotMatch(html, /Report mandates · Filing receipts/);
  assert.match(html, /Source law/);
  assert.match(html, /Open in Contracts|Open in Rules|Open in Meetings/);
  assert.match(html, /data-mandate-edges="co-located-only"/);
});

test("Parks constellation document wires co-located mandate graph neighbors", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const view = buildAgencyConstellationView(PARKS, {
    intelligence,
    certification,
    obligations,
    process_conformance: processConformance,
  });
  assert.equal(view.mandates_rules?.counts?.observed_links || 0, 0);
  assert.equal(view.mandates_reports?.counts?.filing_receipts || 0, 0);
  assert.ok(view.mandates_rules?.graph_neighbors?.rules_browse_href);
  assert.ok(view.mandates_rules?.graph_neighbors?.meetings_browse_href);
  assert.ok(view.mandates_rules?.graph_neighbors?.contracts_browse_href);

  const html = renderAgencyConstellationDocument(view);
  // Honest nav + H2: no edge-sounding labels when joins are empty.
  assert.doesNotMatch(html, /Report mandates · Filing receipts/);
  assert.doesNotMatch(html, /Rulemaking mandates · Rules activity/);
  assert.match(html, /Report mandates/);
  assert.match(html, /Rulemaking mandates/);
  // Diamond constellation styling retained for graph neighbors.
  assert.match(html, /ui-constellation-link[^>]*data-mandate-graph-neighbor="rules"/);
  assert.match(html, /data-mandate-edge="source_law"/);
  assert.deepEqual(detectNodePageCruft(html), []);
});
