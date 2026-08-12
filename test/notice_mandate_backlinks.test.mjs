import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import { MANDATE_CONTRACT_EDGE_TYPE } from "../site/mandate_contracts_bridge.mjs";
import {
  NOTICE_MANDATE_BACKLINKS_SCHEMA,
  NOTICE_MANDATE_BACKLINKS_METHOD,
  compactMandateBacklink,
  isPublicBacklinkTier,
  lookupNoticeMandateBacklinks,
  renderNoticeMandateBacklinksForId,
  renderNoticeMandateBacklinksHTML,
} from "../site/notice_mandate_backlinks.mjs";
import {
  buildNoticeMandateBacklinksLookup,
  collectFromContractView,
  collectFromReportsView,
} from "../tools/lib/notice_mandate_backlinks_index.mjs";
import { OBSERVATION_STATUS } from "../site/process_conformance.mjs";
import { renderEdgeNotice } from "../site/pages_edge.mjs";
import {
  CROSS_BRIDGE_MANDATE_SUBJECT_REF,
  CROSS_BRIDGE_OBLIGATION_ID,
} from "./helpers/mandate_subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED = JSON.parse(
  readFileSync(join(ROOT, "site/data/notice_mandate_backlinks_lookup.json"), "utf8"),
);

const PUBLIC_EDGE = {
  mandate_id: CROSS_BRIDGE_OBLIGATION_ID,
  mandate: {
    subject_ref: CROSS_BRIDGE_MANDATE_SUBJECT_REF,
    duty_text: "Issue a request for proposals for elevator inspection services.",
    citation: "Local Law demo §1",
    source_href: "https://example.test/law",
  },
  procurement_record: {
    subject_ref: "notice:20260000001",
    request_id: "20260000001",
    label: "Elevator inspection services RFP",
  },
  edge: { type: MANDATE_CONTRACT_EDGE_TYPE },
  edge_policy: { tier: "public_inferred", reason: "held_out_precision_gate_passed" },
};

const SHADOW_EDGE = {
  ...PUBLIC_EDGE,
  procurement_record: {
    subject_ref: "notice:20260000099",
    request_id: "20260000099",
    label: "Shadow only",
  },
  edge_policy: { tier: "evidence_only", reason: "insufficient_relation_evidence" },
};

test("public tiers are accepted and evidence_only is rejected", () => {
  assert.equal(isPublicBacklinkTier("deterministic"), true);
  assert.equal(isPublicBacklinkTier("public_inferred"), true);
  assert.equal(isPublicBacklinkTier("evidence_only"), false);
  assert.equal(isPublicBacklinkTier("no_edge"), false);
});

test("compact rows keep bare mandate_id, drop subject_ref, and reject non-public tiers", () => {
  const publicRow = compactMandateBacklink({
    duty_text: "Hold a hearing.",
    citation: "AC §1",
    source_href: "https://example.test/law",
    relation: MANDATE_CONTRACT_EDGE_TYPE,
    agency_id: "homeless-services",
    publication_tier: "public_inferred",
    subject_ref: "mandate:should-not-leak",
    mandate_id: "should-not-leak",
  });
  assert.ok(publicRow);
  assert.equal(publicRow.agency_id, "homeless-services");
  assert.equal(publicRow.agency_href, "/agencies/homeless-services/");
  assert.equal(publicRow.subject_ref, undefined);
  // Bare canonical id is a product filter key; the graph subject_ref form is not stored.
  assert.equal(publicRow.mandate_id, "should-not-leak");
  assert.match(publicRow.watch_href || "", /lens=mandates/);
  assert.match(publicRow.watch_href || "", /mandate_id/);

  assert.equal(compactMandateBacklink({
    duty_text: "Shadow duty",
    publication_tier: "evidence_only",
  }), null);
});

test("contract view collector indexes public edges only by notice id", () => {
  const byNotice = collectFromContractView({
    agency_id: "buildings",
    agency_name: "Department of Buildings",
    edges: [PUBLIC_EDGE, SHADOW_EDGE],
    shadow_edges: [SHADOW_EDGE],
  });
  assert.equal(byNotice.has("20260000001"), true);
  assert.equal(byNotice.has("20260000099"), false);
  const row = byNotice.get("20260000001")[0];
  assert.equal(row.relation, MANDATE_CONTRACT_EDGE_TYPE);
  assert.match(row.duty_text, /elevator inspection/i);
  assert.equal(row.mandate_id, CROSS_BRIDGE_OBLIGATION_ID);
  assert.equal(row.watch_href, undefined);
  assert.doesNotMatch(JSON.stringify(row), /mandate:|subject_ref|evidence_only/);
});

test("reports view collector indexes observed filing receipts only", () => {
  const byNotice = collectFromReportsView({
    agency_id: "commission-on-human-rights",
    agency_name: "Commission on Human Rights",
    mandates: [
      {
        mandate_id: "53107-001",
        duty_text: "Submit an annual report and publish it in the City Record.",
        citation: "Admin Code § 8-105",
        source_href: "https://example.test/law",
        observation_status: OBSERVATION_STATUS.OBSERVED,
        filing_receipt: {
          request_id: "20251001039",
          label: "FY25 Annual Report",
          href: "#notice/20251001039",
        },
      },
      {
        mandate_id: "x-miss",
        duty_text: "Submit a climate survey report.",
        observation_status: null,
        filing_receipt: null,
      },
    ],
  });
  assert.equal(byNotice.has("20251001039"), true);
  assert.equal(byNotice.get("20251001039")[0].relation, "mandate_report_filing");
  assert.equal(byNotice.get("20251001039")[0].mandate_id, "53107-001");
  assert.equal(byNotice.has("x-miss"), false);
});

test("lookup and render are empty-safe and omit absence copy", () => {
  const lookup = {
    schema: NOTICE_MANDATE_BACKLINKS_SCHEMA,
    method: NOTICE_MANDATE_BACKLINKS_METHOD,
    by_notice: {
      "20260000001": [{
        duty_text: "Issue a request for proposals for elevator inspection services.",
        citation: "Local Law demo §1",
        source_href: "https://example.test/law",
        relation: MANDATE_CONTRACT_EDGE_TYPE,
        relation_label: "Procurement record for this duty",
        agency_id: "buildings",
        agency_name: "Department of Buildings",
        agency_href: "/agencies/buildings/",
        mandate_id: CROSS_BRIDGE_OBLIGATION_ID,
        publication_tier: "public_inferred",
      }],
      "20260000099": [{
        duty_text: "Should never render",
        publication_tier: "evidence_only",
        relation: MANDATE_CONTRACT_EDGE_TYPE,
      }],
    },
  };
  assert.deepEqual(lookupNoticeMandateBacklinks(lookup, "20991231999"), []);
  assert.equal(renderNoticeMandateBacklinksForId(lookup, "20991231999"), "");
  assert.equal(renderNoticeMandateBacklinksForId(lookup, "20260000099"), "");

  const html = renderNoticeMandateBacklinksForId(lookup, "20260000001");
  assert.match(html, /data-connected-mandate="1"/);
  assert.match(html, /Connected mandate/);
  assert.match(html, /elevator inspection services/);
  assert.match(html, /Local Law demo/);
  assert.match(html, /Source law/);
  assert.match(html, /href="https:\/\/example\.test\/law"/);
  assert.match(html, /href="\/agencies\/buildings\/"/);
  assert.match(html, /Procurement record for this duty/);
  assert.match(html, /Watch this mandate/);
  assert.match(html, /data-mandate-watch="1"/);
  assert.match(html, new RegExp(`data-mandate-id="${CROSS_BRIDGE_OBLIGATION_ID}"`));
  assert.match(html, /lens=mandates/);
  assert.doesNotMatch(html, /subject_ref|mandate:|evidence_only|source_system|not yet shown|no data/i);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("edge notice renderer stamps the card and stays silent without a match", () => {
  const lookup = {
    schema: NOTICE_MANDATE_BACKLINKS_SCHEMA,
    method: NOTICE_MANDATE_BACKLINKS_METHOD,
    by_notice: {
      "20210820102": COMMITTED.by_notice["20210820102"],
    },
  };
  const withCard = renderEdgeNotice({
    request_id: "20210820102",
    short_title: "Shelter renewal",
    agency_name: "Homeless Services",
    type_of_notice_description: "Award",
    section_name: "Procurement",
  }, "20210820102", null, lookup);
  assert.match(withCard, /data-connected-mandate="1"/);
  assert.match(withCard, /Connected mandate/);
  assert.match(withCard, /shelter contracts/i);
  assert.match(withCard, /Administrative Code/);
  assert.match(withCard, /href="\/agencies\/homeless-services\/"/);
  assert.match(withCard, /Watch this mandate/);
  assert.doesNotMatch(withCard, /mandate:66056|subject_ref|evidence_only/);
  assert.deepEqual(detectNodePageCruft(withCard), []);

  const empty = renderEdgeNotice({
    request_id: "20991231999",
    short_title: "Unrelated notice",
    agency_name: "Parks & Recreation",
    type_of_notice_description: "Solicitation",
  }, "20991231999", null, lookup);
  assert.doesNotMatch(empty, /Connected mandate|data-connected-mandate/);
  assert.doesNotMatch(empty, /not yet shown|no data/i);
});

test("committed lookup is public-only and includes the known contract edge", () => {
  assert.equal(COMMITTED.schema, NOTICE_MANDATE_BACKLINKS_SCHEMA);
  assert.equal(COMMITTED.method, NOTICE_MANDATE_BACKLINKS_METHOD);
  assert.ok(COMMITTED.counts?.edges >= 1);
  const rows = COMMITTED.by_notice?.["20210820102"];
  assert.ok(Array.isArray(rows) && rows.length >= 1);
  for (const row of rows) {
    assert.ok(isPublicBacklinkTier(row.publication_tier));
    assert.ok(row.duty_text);
    assert.equal(row.subject_ref, undefined);
    assert.equal(row.evidence, undefined);
    // Canonical bare id enables the one-duty watch; graph subject_ref form stays off.
    assert.ok(row.mandate_id);
    assert.doesNotMatch(row.mandate_id, /^mandate:/);
  }
  const html = renderNoticeMandateBacklinksHTML(rows);
  assert.match(html, /Connected mandate/);
  assert.match(html, /Watch this mandate/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("live materialization from sources stays public-only", () => {
  const obligations = JSON.parse(
    readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"),
  );
  const intelligence = JSON.parse(
    readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"),
  );
  const gate = JSON.parse(
    readFileSync(join(ROOT, "site/data/cross_spine_edge_gate.json"), "utf8"),
  );
  const procurementAwards = JSON.parse(
    readFileSync(join(ROOT, "site/data/ocp_awards_warehouse_lookup.json"), "utf8"),
  );
  const lookup = buildNoticeMandateBacklinksLookup({
    obligationsLookup: obligations,
    intelligence,
    procurementAwards,
    crossSpineGate: gate,
    meetingsDomain: { rows: [] },
    rulesDomain: { rows: [], row_count: 0 },
    processConformance: { by_agency: {} },
    landProjects: {},
    generatedAt: "2026-08-09T00:00:00.000Z",
  });
  assert.equal(lookup.schema, NOTICE_MANDATE_BACKLINKS_SCHEMA);
  assert.ok(lookup.counts.edges >= 1);
  assert.ok(lookup.by_notice["20210820102"]?.length >= 1);
  for (const rows of Object.values(lookup.by_notice)) {
    for (const row of rows) {
      assert.ok(isPublicBacklinkTier(row.publication_tier));
      assert.equal("subject_ref" in row, false);
      assert.equal("watch_href" in row, false);
      if (row.mandate_id) assert.doesNotMatch(row.mandate_id, /^mandate:/);
    }
  }
  const known = lookup.by_notice["20210820102"][0];
  assert.ok(known.mandate_id, "public contract edge must carry a canonical mandate id");
});

test("notice-context wires mandate backlinks into fillContext without a profile-blocking path", () => {
  const source = readFileSync(join(ROOT, "site/app/notice-context.mjs"), "utf8");
  assert.match(source, /notice_mandate_backlinks\.mjs/);
  assert.match(source, /mandateBacklinksHTMLFor/);
  assert.match(source, /data-connected-mandate/);
  assert.match(source, /fillContext/);
  // Empty-safe: no fetch when request_id is missing; skip when edge already stamped.
  assert.match(source, /if\(!r\|\|!r\.request_id\)return ""/);
  assert.match(source, /data-connected-mandate='1'/);
  // SPA-safe: browser module must not import bridge index builders or ER packages.
  const browserModule = readFileSync(join(ROOT, "site/notice_mandate_backlinks.mjs"), "utf8");
  assert.doesNotMatch(browserModule, /from ["'].*entity_resolution/);
  assert.doesNotMatch(browserModule, /from ["'].*mandate_contracts_bridge/);
  assert.doesNotMatch(browserModule, /from ["'].*notice_mandate_backlinks_index/);
});
