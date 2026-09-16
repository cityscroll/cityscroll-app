import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NOTICE_MORE_TOOLS_SUMMARY_KEY,
  NOTICE_TOOLS_REGION_ATTR,
  filterNoticeConstellationNeighbors,
  noticeRelationshipKey,
  noticeMoreToolsSummaryLabel,
  renderNoticeEnrichmentRegion,
  renderNoticeMoreToolsDisclosure,
  representedNoticeRelationships,
} from "../site/notice_reader_presentation.mjs";
import { renderEdgeNotice } from "../site/pages_edge.mjs";

const clientSource = readFileSync(new URL("../site/notice_subject_client.mjs", import.meta.url), "utf8");
const moneyHistorySource = readFileSync(new URL("../site/app/money-history.mjs", import.meta.url), "utf8");
const harnessSource = readFileSync(
  new URL("./functional/resident_document_presentation.py", import.meta.url),
  "utf8",
);

test("relationship keys distinguish role meaning, not only destination URL", () => {
  const agency = noticeRelationshipKey({
    edge_type: "published_by_agency",
    target_kind: "agency",
    target_id: "dhs",
    target_name: "Homeless Services",
    href: "/agencies/dhs/",
  });
  const sameAgencyAsVendor = noticeRelationshipKey({
    edge_type: "named_vendor",
    target_kind: "vendor",
    target_id: "dhs",
    target_name: "Homeless Services",
    href: "/agencies/dhs/",
  });
  assert.ok(agency);
  assert.notEqual(agency, sameAgencyAsVendor);
});

test("local connections omit agency and vendor already shown in primary facts", () => {
  const represented = representedNoticeRelationships({
    agency: { id: "dhs", name: "Homeless Services" },
    vendor: { id: "BHRAGS Operating LLC", name: "BHRAGS Operating LLC" },
    subjects: [{ kind: "procurement", id: "procurement:contract:CT1", label: "Contract CT1" }],
  });
  const filtered = filterNoticeConstellationNeighbors([
    {
      edge_type: "published_by_agency",
      target_kind: "agency",
      target_id: "dhs",
      target_name: "Homeless Services",
      href: "/agencies/dhs/",
    },
    {
      edge_type: "named_vendor",
      target_kind: "vendor",
      target_id: "BHRAGS Operating LLC",
      target_name: "BHRAGS Operating LLC",
      href: "/vendors/bhrags/",
    },
    {
      edge_type: "related_record",
      target_kind: "procurement",
      target_id: "procurement:contract:CT1",
      target_name: "Contract CT1",
      href: "/procurements/procurement%3Acontract%3ACT1",
    },
    {
      edge_type: "related_record",
      target_kind: "record",
      target_id: "20240829199",
      target_name: "Related hearing",
      href: "/notices/20240829199",
    },
  ], represented);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].target_id, "20240829199");
});

test("More tools disclosure stays closed and preserves caller markup", () => {
  const summary = noticeMoreToolsSummaryLabel((key) => key === NOTICE_MORE_TOOLS_SUMMARY_KEY ? "More tools" : key);
  const html = renderNoticeMoreToolsDisclosure({
    summary,
    bodyHtml: '<button type="button" id="ncopy">Copy</button><button type="button" id="nprint">Print</button>',
  });
  assert.match(html, new RegExp(`${NOTICE_TOOLS_REGION_ATTR}="1"`));
  assert.match(html, new RegExp(`<summary data-i18n="${NOTICE_MORE_TOOLS_SUMMARY_KEY}">More tools</summary>`));
  assert.doesNotMatch(html, /\sopen[=>\s]/);
  assert.match(html, /id="ncopy"/);
  assert.match(html, /id="nprint"/);
  assert.equal(renderNoticeMoreToolsDisclosure({ bodyHtml: "   " }), "");
  assert.equal(renderNoticeMoreToolsDisclosure({ bodyHtml: "<button>x</button>" }), "");
  assert.equal(summary, "More tools");
});

test("empty enrichment regions omit headings and placeholders", () => {
  assert.equal(renderNoticeEnrichmentRegion({ region: "local-constellation", bodyHtml: "" }), "");
  assert.equal(renderNoticeEnrichmentRegion({ region: "local-constellation", bodyHtml: "   " }), "");
  assert.match(
    renderNoticeEnrichmentRegion({ region: "local-constellation", bodyHtml: "<ul><li>Kept</li></ul>" }),
    /data-notice-enrichment-region="local-constellation"/,
  );
});

test("edge notice presents each agency/vendor role once and closes optional tools", () => {
  const html = renderEdgeNotice({
    request_id: "20240829105",
    short_title: "City Sanctuary Facility for Families with Children",
    type_of_notice_description: "Award",
    agency_name: "Homeless Services",
    vendor_name: "BHRAGS Operating LLC",
    start_date: "2024-08-29",
    additional_description_1: "Shelter operations for families with children.",
  }, "20240829105");

  assert.match(html, /data-notice-primary-facts="1"/);
  assert.match(html, /data-notice-tools-region="1"/);
  assert.match(html, /<summary data-i18n="more_tools">More tools<\/summary>/);
  assert.doesNotMatch(html, /data-notice-tools-region="1"[^>]*\sopen/);

  assert.doesNotMatch(html, /class="ftype"[^>]*>[^<]*Homeless Services/);
  assert.doesNotMatch(html, /notice-local-constellation-heading/);
  assert.equal((html.match(/notice-agency-link/g) || []).length, 1);
  assert.equal((html.match(/notice-vendor-link/g) || []).length, 1);
  assert.match(html, /<dt>Agency<\/dt>/);
  assert.match(html, /<dt>Vendor<\/dt>/);
  assert.match(html, /Shelter operations for families with children/);
  assert.match(html, /a856-cityrecord\.nyc\.gov\/RequestDetail\/20240829105/);
});

test("client and money-detail templates keep utilities inside More tools", () => {
  assert.match(clientSource, /renderNoticeMoreToolsDisclosure/);
  assert.match(clientSource, /id="ncopy"/);
  assert.match(clientSource, /id="nqr"|qrButtonHTML\("nqr"/);
  assert.match(clientSource, /id="nxlsx"/);
  assert.match(clientSource, /id="nprint"/);
  assert.match(clientSource, /pinBtn\("notice"/);
  assert.match(clientSource, /notice_email_btn/);
  assert.match(moneyHistorySource, /moneyDetailMoreToolsHTML|data-notice-tools-region/);
  assert.match(moneyHistorySource, /id="dcopy"/);
  assert.match(moneyHistorySource, /id="dxlsx"/);
  assert.match(moneyHistorySource, /id="dprint"/);
});

test("A9 harness advertises the notice-tools browser case", () => {
  assert.match(harnessSource, /notice-tools/);
  assert.match(harnessSource, /run_notice_tools|assert_notice_tools/);
  assert.match(harnessSource, /"notice-tools"/);
  assert.match(harnessSource, /notice-tools/);
  assert.match(harnessSource, /TOOLS_MANIFEST_PATH/);
});
