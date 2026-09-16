/**
 * Contextual discovery of existing research utilities.
 *
 *   node --test test/research_discovery.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MORE_TOOLS_LABEL,
  MORE_TOOLS_REGION_ATTR,
  RESEARCH_CAPABILITY_FAMILIES,
  RESEARCH_TASK_ENTRANCES_ID,
  asOfContextHref,
  comparativeAnalysisHref,
  evidenceContextHref,
  projectResearchTools,
  renderMoreToolsRegion,
  renderRecordActionRegions,
  renderResearchNavigation,
  renderResearchTaskEntrances,
  researchFamilyIds,
} from "../site/research_discovery.mjs";
import { GUIDE_HELP } from "../site/guide_contextual_links.mjs";
import { CAPABILITY_DISCOVERY_MATRIX } from "../site/ai_discovery.mjs";

const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
const noticeSubjectClient = readFileSync(new URL("../site/notice_subject_client.mjs", import.meta.url), "utf8");
const moneyHistory = readFileSync(new URL("../site/app/money-history.mjs", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../site/app/workspace.mjs", import.meta.url), "utf8");
const entities = readFileSync(new URL("../site/app/entities.mjs", import.meta.url), "utf8");
const agencyConstellation = readFileSync(new URL("../site/agency_constellation.mjs", import.meta.url), "utf8");
const apiHtml = readFileSync(new URL("../site/api.html", import.meta.url), "utf8");
const guideHome = readFileSync(new URL("../site/guide/index.html", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const functional = readFileSync(new URL("../test/functional/resident_document_presentation.py", import.meta.url), "utf8");

test("research capability families cover the census research utilities", () => {
  assert.deepEqual(researchFamilyIds(), [
    "evidence",
    "asOf",
    "comparative",
    "share",
    "saveSearch",
    "collection",
    "export",
    "print",
  ]);
  for (const name of ["Evidence", "As-of", "Comparative analysis", "Saved searches", "Collection/export"]) {
    assert.ok(CAPABILITY_DISCOVERY_MATRIX.some(([label]) => label === name), name);
  }
  assert.equal(RESEARCH_CAPABILITY_FAMILIES.evidence.guideTopic, "connection");
  assert.equal(RESEARCH_CAPABILITY_FAMILIES.asOf.guideTopic, "asOf");
  assert.equal(RESEARCH_CAPABILITY_FAMILIES.collection.guideTopic, "emptyCollection");
});

test("each capability family has one eligible and one ineligible fixture", () => {
  const eligible = projectResearchTools({
    surface: "notice",
    evidencePath: "/agencies/parks-and-recreation/",
    evidenceClaimId: "claim-1",
    asOfSupported: true,
    asOfPath: "/agencies/parks-and-recreation/",
    asOfDay: "2026-01-15",
    comparativeAgency: "Department of Parks and Recreation",
    comparativeFiscalYear: 2026,
    comparativeMeasure: "current",
    hasShareHandler: true,
    hasSaveSearchHandler: true,
    hasCollectionHandler: true,
    hasExportHandler: true,
    hasPrintHandler: true,
  });
  assert.deepEqual(eligible.eligible.map((tool) => tool.id), researchFamilyIds());
  assert.equal(eligible.ineligible.length, 0);
  assert.match(eligible.eligible.find((tool) => tool.id === "comparative").href, /ap_agency=Department\+of\+Parks\+and\+Recreation/);
  assert.match(eligible.eligible.find((tool) => tool.id === "comparative").href, /ap_fy=2026/);
  assert.match(eligible.eligible.find((tool) => tool.id === "comparative").href, /ap_measure=current/);
  assert.match(eligible.eligible.find((tool) => tool.id === "evidence").href, /claim=claim-1/);
  assert.match(eligible.eligible.find((tool) => tool.id === "asOf").href, /as_of=2026-01-15/);

  const ineligible = projectResearchTools({
    surface: "notice",
    requireEvidence: true,
    requireAsOf: true,
    requireComparative: true,
    hasShareHandler: false,
    hasSaveSearchHandler: false,
    hasCollectionHandler: false,
    hasExportHandler: false,
    hasPrintHandler: false,
    requireShare: true,
    requireSaveSearch: true,
    requireCollection: true,
    requireExport: true,
    requirePrint: true,
  });
  assert.equal(ineligible.eligible.length, 0);
  assert.deepEqual(ineligible.ineligible.map((tool) => tool.id), researchFamilyIds());
});

test("optional missing data creates no empty More tools panel or fabricated success", () => {
  assert.equal(renderMoreToolsRegion({ content: "" }), "");
  assert.equal(renderMoreToolsRegion({ content: "   " }), "");
  assert.equal(renderResearchNavigation(projectResearchTools({ surface: "notice" })), "");
  assert.equal(comparativeAnalysisHref({}), null);
  assert.equal(evidenceContextHref({}), null);
  assert.equal(asOfContextHref({ path: "/agencies/x/", asOfDay: "not-a-day" }), null);

  const html = renderMoreToolsRegion({
    content: `<button type="button" id="nqr">QR</button><button type="button" id="nxlsx">Export</button>`,
    id: "notice-more-tools",
  });
  assert.match(html, new RegExp(`${MORE_TOOLS_REGION_ATTR}="1"`));
  assert.match(html, /<details class="[^"]*more-tools/);
  assert.doesNotMatch(html, /\sopen/);
  assert.match(html, />More tools</);
  assert.match(html, /id="nqr"/);
  assert.match(html, /id="nxlsx"/);
  assert.match(html, /id="notice-more-tools"/);
});

test("record action regions keep civic actions primary and compose the More tools region", () => {
  const html = renderRecordActionRegions({
    primaryHtml: `<button id="ncopy">Copy link</button><a class="notice-source-link" href="https://example.test">Official</a>`,
    moreToolsHtml: `<button id="nqr">QR</button><button id="nxlsx">Export</button><button id="nprint">Print</button><button data-pin="1">Pin</button>`,
    researchHtml: renderResearchNavigation(projectResearchTools({
      surface: "notice",
      evidencePath: "/agencies/parks-and-recreation/",
      asOfSupported: true,
      asOfPath: "/agencies/parks-and-recreation/",
      comparativeAgency: "Department of Parks and Recreation",
    })),
    moreToolsId: "notice-more-tools",
  });
  assert.match(html, /data-record-action-regions="1"/);
  assert.match(html, /id="ncopy"/);
  assert.match(html, /notice-source-link/);
  assert.match(html, /data-more-tools-region="1"/);
  assert.match(html, /id="notice-more-tools"/);
  assert.ok(html.indexOf("ncopy") < html.indexOf("notice-more-tools"));
  assert.match(html, /data-research-tool="evidence"/);
  assert.match(html, /data-research-tool="asOf"/);
  assert.match(html, /data-research-tool="comparative"/);
  assert.doesNotMatch(html, /second workspace|pinning system|onboarding/i);
});

test("Guide and API expose direct research task entrances", () => {
  const rendered = renderResearchTaskEntrances({ includeApi: true });
  assert.match(rendered, new RegExp(`id="${RESEARCH_TASK_ENTRANCES_ID}"`));
  assert.match(rendered, new RegExp(GUIDE_HELP.connection.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, new RegExp(GUIDE_HELP.asOf.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, new RegExp(GUIDE_HELP.emptyCollection.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, /\/browse\/contracts\/\?mode=award/);

  assert.match(apiHtml, /id="research-task-entrances"/);
  assert.match(apiHtml, /data-research-task="evidence"/);
  assert.match(apiHtml, /data-research-task="asOf"/);
  assert.match(apiHtml, /data-research-task="collection"/);
  assert.match(apiHtml, /data-research-task="comparative"/);

  assert.match(guideHome, /\/guide\/how-to\/check-the-evidence-behind-a-connection\//);
  assert.match(guideHome, /\/guide\/how-to\/look-at-records-as-of-a-day\//);
  assert.match(guideHome, /\/guide\/how-to\/collect-records-and-export-them\//);
});

test("eligible contract entity and institution surfaces mount the discovery projection", () => {
  const discovery = readFileSync(new URL("../site/research_discovery.mjs", import.meta.url), "utf8");
  assert.match(routing, /renderNoticeClientActionRegions/);
  assert.match(discovery, /notice-more-tools/);
  for (const [name, source] of [
    ["money-history", moneyHistory],
    ["workspace", workspace],
    ["entities", entities],
  ]) {
    assert.match(source, /renderEligibleRecordTools/, name);
    assert.match(source, /more-tools/, name);
  }
  // Agency constellation remains the positive control for evidence and as-of.
  assert.match(agencyConstellation, /Connection evidence/);
  assert.match(agencyConstellation, /renderCivicTimeLedgerPanel|data-ctl-useful/);
  assert.doesNotMatch(routing, /per-row toolbar|second workspace/i);
});

test("saved collection and share control ids remain available inside More tools", () => {
  const discovery = readFileSync(new URL("../site/research_discovery.mjs", import.meta.url), "utf8");
  assert.match(routing, /renderNoticeClientActionRegions\(/);
  assert.match(discovery, /id="ncopy"/);
  assert.match(discovery, /id="nxlsx"/);
  assert.match(discovery, /id="nprint"/);
  assert.match(discovery, /notice-more-tools/);
  assert.match(moneyHistory, /id="dcopy"/);
  assert.match(moneyHistory, /qrButtonHTML\("dqr"/);
  assert.match(moneyHistory, /notice-detail-more-tools/);
  assert.match(workspace, /matter-more-tools/);
  assert.match(entities, /agency-more-tools/);
  assert.match(entities, /vendor-more-tools/);
  assert.match(i18n, /more_tools_label:\s*"More tools"/);
  assert.equal(MORE_TOOLS_LABEL, "More tools");
});

test("research-tools browser case is registered for composed notice verification", () => {
  assert.match(functional, /research-tools/);
  assert.match(functional, /data-more-tools-region|more-tools/);
});
