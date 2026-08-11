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
  mandateScopedLinksFromRecord,
  normalizeMandateGraphNeighbors,
  normalizeMandateScopedLinks,
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
const EPA = "environmental-protection";

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

test("per-row actions keep Source law and ignore agency-wide graph_neighbors", () => {
  const neighbors = normalizeMandateGraphNeighbors({
    rules_browse_href: "/browse/rules/?agency=Parks",
    meetings_browse_href: "/browse/meetings/?agency=Parks",
    contracts_browse_href: "/browse/contracts/?agency=Parks",
  });
  // Agency-wide browse must NOT appear on the mandate row.
  const hollow = renderMandateRowGraphActions({
    source_href: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=60950",
    matter_id: "60950",
    graph_neighbors: neighbors,
    prefer: "rules",
  });
  assert.match(hollow, /Source law/);
  assert.match(hollow, /data-mandate-edge="source_law"/);
  assert.match(hollow, /data-matter-id="60950"/);
  assert.doesNotMatch(hollow, /Open in Rules|Browse agency Rules/);
  assert.doesNotMatch(hollow, /Open in Meetings|Browse agency Meetings/);
  assert.doesNotMatch(hollow, /Open in Contracts|Browse agency Contracts/);
  assert.doesNotMatch(hollow, /data-mandate-graph-neighbor/);
  assert.match(hollow, /ui-official-source-link/);

  // Real per-mandate edge is painted when provided.
  const scoped = renderMandateRowGraphActions({
    source_href: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=60950",
    matter_id: "60950",
    mandate_links: [{
      key: "rules",
      href: "/notices/20260605008",
      label: "Linked Rules filing",
      relation: "mandate_rule_filing",
    }],
    prefer: "rules",
  });
  assert.match(scoped, /Source law/);
  assert.match(scoped, /Linked Rules filing/);
  assert.match(scoped, /data-mandate-scoped="1"/);
  assert.match(scoped, /href="\/notices\/20260605008"/);
  assert.match(scoped, /data-mandate-graph-neighbor="rules"/);
  assert.doesNotMatch(scoped, /Browse agency Rules/);

  // Section chrome keeps agency browse, labeled honestly as agency-wide.
  const chrome = renderMandateSectionNeighborActions({ graph_neighbors: neighbors });
  assert.match(chrome, /Browse agency Rules/);
  assert.match(chrome, /Browse agency Meetings/);
  assert.match(chrome, /Browse agency Contracts/);
  assert.match(chrome, /data-scope="agency"/);
  assert.doesNotMatch(chrome, /Open in Rules/);
});

test("normalizeMandateScopedLinks drops empty hrefs and dedupes", () => {
  assert.deepEqual(normalizeMandateScopedLinks([
    { key: "rules", href: "", label: "x" },
    { key: "rules", href: "/notices/1", label: "First" },
    { key: "rules", href: "/notices/1", label: "Dup" },
    { key: "contracts", href: "/notices/2" },
  ]), [
    {
      key: "rules",
      href: "/notices/1",
      label: "First",
      relation: "rules",
    },
    {
      key: "contracts",
      href: "/notices/2",
      label: "Linked contract",
      relation: "contracts",
    },
  ]);
  assert.deepEqual(mandateScopedLinksFromRecord(null), []);
  assert.deepEqual(mandateScopedLinksFromRecord({ label: "no href" }), []);
  const fromObs = mandateScopedLinksFromRecord(
    { href: "/notices/20251001039", signal_kind: "report_or_study" },
    { kind: "report" },
  );
  assert.equal(fromObs.length, 1);
  assert.equal(fromObs[0].key, "report");
  assert.equal(fromObs[0].href, "/notices/20251001039");
});

test("Parks rules rows keep Source law and drop hollow agency Open-in chips", () => {
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

  const rows = html.match(/class="node-record mandate-rules-mandate"/g) || [];
  assert.ok(rows.length >= 1);
  const sourceLaw = html.match(/data-mandate-edge="source_law"/g) || [];
  assert.ok(sourceLaw.length >= rows.length, "each row has Source law");

  // Hollow per-row agency chips are gone: every Open-in / Browse agency link is
  // section chrome with data-scope="agency", never repeated on each card.
  const rowBlockMatch = html.match(
    /data-bridge-side="mandates">([\s\S]*?)<\/ul>/,
  );
  assert.ok(rowBlockMatch, "mandate list present");
  const rowBlock = rowBlockMatch[1];
  assert.doesNotMatch(rowBlock, /data-mandate-graph-neighbor/);
  assert.doesNotMatch(rowBlock, /Browse agency |Open in /);
  // Distinct Source law targets across rows (not one agency filter).
  const matterIds = [...rowBlock.matchAll(/data-matter-id="(\d+)"/g)].map((m) => m[1]);
  assert.ok(new Set(matterIds).size >= Math.min(2, rows.length) || rows.length === 1);

  // Section chrome still exposes honest agency-wide scopes once.
  assert.match(html, /data-mandate-graph-neighbor="rules"[^>]*data-scope="agency"/);
  assert.match(html, /data-mandate-graph-neighbor="meetings"[^>]*data-scope="agency"/);
  assert.match(html, /data-mandate-graph-neighbor="contracts"[^>]*data-scope="agency"/);
  assert.match(html, /Browse agency Rules/);
  assert.match(html, /Gateway\.aspx\?M=L&amp;ID=/);
});

test("Parks reports rows keep Source law without repeating agency-wide chips", () => {
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
  assert.match(html, /data-mandate-edges="co-located-only"/);

  const rowBlockMatch = html.match(
    /data-bridge-side="report-mandates">([\s\S]*?)<\/ul>/,
  );
  assert.ok(rowBlockMatch);
  assert.doesNotMatch(rowBlockMatch[1], /data-mandate-graph-neighbor/);
  // Section chrome is agency-wide and labeled as such.
  assert.match(html, /Browse agency Rules|Browse agency Meetings|Browse agency Contracts/);
  assert.match(html, /data-scope="agency"/);
});

test("EPA and Parks mandate cards no longer share identical agency-wide Open-in chips", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  for (const agencyId of [EPA, PARKS]) {
    const view = buildAgencyConstellationView(agencyId, {
      intelligence,
      certification,
      obligations,
      process_conformance: processConformance,
    });
    const html = renderAgencyConstellationDocument(view);
    // Extract mandate row lists across rules / reports / predictions.
    const rowBlocks = [
      ...html.matchAll(/data-bridge-side="(?:mandates|report-mandates|predicted-events)">([\s\S]*?)<\/ul>/g),
    ].map((m) => m[1]);
    assert.ok(rowBlocks.length >= 1, `${agencyId} has mandate row lists`);
    for (const block of rowBlocks) {
      // No hollow agency Open-in chips on cards.
      assert.doesNotMatch(
        block,
        /Browse agency |Open in (Rules|Meetings|Contracts)/,
        `${agencyId} mandate rows must not carry agency-wide browse chips`,
      );
      assert.doesNotMatch(block, /data-mandate-graph-neighbor/);
    }
    // Source law remains and differs by matter when multiple mandates exist.
    assert.match(html, /data-mandate-edge="source_law"/);
  }
});

test("Parks constellation document wires honest section-level agency neighbors", () => {
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
  // Agency-wide browse lives in section chrome with honest labels.
  assert.match(html, /data-mandate-graph-neighbor="rules"[^>]*data-scope="agency"/);
  assert.match(html, /Browse agency Rules/);
  assert.match(html, /data-mandate-edge="source_law"/);
  assert.deepEqual(detectNodePageCruft(html), []);
});
