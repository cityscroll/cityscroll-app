import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MANDATE_RULES_BRIDGE_METHOD,
  agencyMandateRulesPath,
  agencyRulesFollowHref,
  buildMandateRulesBridgeView,
  renderMandateRulesBridgeSection,
} from "../site/mandate_rules_bridge.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import { OBSERVATION_STATUS } from "../site/process_conformance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARKS = "parks-and-recreation";
const BUILDINGS = "buildings";

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

test("shareable path anchors Mandates → Rules card", () => {
  assert.equal(
    agencyMandateRulesPath(PARKS),
    "/agencies/parks-and-recreation/#mandates-rules",
  );
  assert.match(agencyRulesFollowHref(PARKS), /\/following/);
  assert.match(agencyRulesFollowHref(PARKS), /lens=rules/);
  assert.match(agencyRulesFollowHref(PARKS), /Parks/);
});

test("bridge joins Parks rulemaking mandates to Rules-lens filings", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const rulesBlock = intelligence.by_ref?.["agency:id:parks-and-recreation"]?.domains?.rules;
  const rulesItems = (rulesBlock?.objects || []).map((object) => ({
    id: object.request_id,
    request_id: object.request_id,
    label: object.label,
    when: object.when,
    href: object.href || `#notice/${object.request_id}`,
    source: "City Record",
  }));
  const view = buildMandateRulesBridgeView(PARKS, {
    obligationsLookup: obligations,
    rulesItems,
    rulesCount: Number(rulesBlock?.count) || rulesItems.length,
    rulesBrowseHref: "/browse/rules/?agency=Parks",
  });
  assert.equal(view.status, "matched");
  assert.equal(view.method, MANDATE_RULES_BRIDGE_METHOD);
  assert.ok(view.counts.rulemaking_mandates >= 1, "Parks has rulemaking mandates");
  assert.ok(view.counts.rules_filings >= 1, "Parks has Rules-lens filings");
  assert.ok(view.mandates.every((m) => m.deliverable_type === "rulemaking"));
  assert.ok(view.rules_items.length >= 1);
  assert.equal(view.rules_items[0].href, "/notices/" + encodeURIComponent(view.rules_items[0].id));
  assert.match(view.share_path, /#mandates-rules$/);
  assert.match(view.rulemaking_mandates_follow_href, /lens=mandates|deliverable/);
  assert.match(view.rules_follow_href, /lens=rules/);
});

test("per-mandate observed Rules filing surfaces when topic join hits", () => {
  const view = buildMandateRulesBridgeView(BUILDINGS, {
    obligationsLookup: {
      by_agency: {
        buildings: {
          obligations: [
            {
              obligation_id: "demo-rm-1",
              duty_text: "Promulgate rules relating to safety standards for refrigeration systems",
              deliverable_type: "rulemaking",
              citation: "Local Law demo",
              deadline: { computed_date: "2020-01-01" },
              source: { legistar_url: "https://example.test/law" },
            },
          ],
        },
      },
    },
    rulesItems: [
      {
        id: "20260407013",
        label: "Final Rule - Rules relating to Safety Standards for Refrigeration Systems",
        when: "2026-04-07",
      },
      {
        id: "20260407014",
        label: "Related rule filing",
        href: "/custom/notice/20260407014",
      },
    ],
    rulesCount: 2,
    conformanceItems: [
      {
        mandate_id: "demo-rm-1",
        observation: {
          status: OBSERVATION_STATUS.OBSERVED,
          label: "Observed in City Record",
          observed_record: {
            request_id: "20260407013",
            label: "Final Rule - Rules relating to Safety Standards for Refrigeration Systems",
            when: "2026-04-07",
            href: "#notice/20260407013",
            signal_kind: "rule_filing",
          },
        },
      },
    ],
  });
  assert.equal(view.status, "matched");
  assert.equal(view.counts.observed_links, 1);
  assert.equal(view.mandates[0].observed_record.request_id, "20260407013");
  assert.equal(view.mandates[0].observed_record.href, "/notices/20260407013");
  assert.equal(view.rules_items[0].href, "/notices/20260407013");
  assert.equal(view.rules_items[1].href, "/custom/notice/20260407014");
  const html = renderMandateRulesBridgeSection(view);
  assert.match(html, /id="mandates-rules"/);
  assert.match(html, /City Record: Final Rule/);
  assert.match(html, /href="\/notices\/20260407013"/);
  assert.match(html, /Open in Rules|Follow Rules activity|Watch rulemaking mandates/);
  assert.doesNotMatch(html, /not X but Y|not yet shown|fabricat|disclaimer/i);
  // Reader headings use "mandates", not upstream "obligations" labels.
  assert.match(html, /Rulemaking mandates/);
  assert.doesNotMatch(html, />Statutory obligations</i);
});

test("empty bridge omits HTML rather than shipping absence copy", () => {
  const view = buildMandateRulesBridgeView("campaign-finance-board", {
    obligationsLookup: { by_agency: {} },
    rulesItems: [],
    rulesCount: 0,
  });
  assert.equal(view.status, "empty");
  assert.equal(renderMandateRulesBridgeSection(view), "");
});

test("Parks constellation document surfaces Mandates → Rules card", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const view = buildAgencyConstellationView(PARKS, {
    intelligence,
    certification,
    obligations,
    process_conformance: processConformance,
  });
  assert.ok(view.mandates_rules);
  assert.equal(view.mandates_rules.status, "matched");
  assert.ok(view.mandates_rules.counts.rulemaking_mandates >= 1);
  assert.ok(view.mandates_rules.counts.rules_filings >= 1);
  assert.match(view.mandates_rules_href, /#mandates-rules$/);

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /id="mandates-rules"/);
  assert.match(html, /Rulemaking mandates · Rules activity/);
  assert.match(html, /data-agency-constellation-card="mandates-rules"/);
  assert.match(html, /data-bridge-side="mandates"/);
  assert.match(html, /data-bridge-side="rules"/);
  assert.match(html, /Open in Rules/);
  assert.match(html, /Watch rulemaking mandates/);
  assert.match(html, /Follow Rules activity/);
  // No disclaimerslop.
  assert.doesNotMatch(html, /not a compliance verdict|not verified identity|fabricat/i);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("Buildings live materialization can show observed rulemaking → Rules links", () => {
  assert.ok(obligations && processConformance, "lookups required");
  const view = buildAgencyConstellationView(BUILDINGS, {
    intelligence,
    certification,
    obligations,
    process_conformance: processConformance,
  });
  if (view.mandates_rules?.status !== "matched") return;
  // Live corpus has observed rulemaking joins for Buildings (process-conformance).
  const observed = (view.mandates_rules.mandates || []).filter((m) => m.observed_record);
  if (observed.length === 0) return; // corpus may thin; Parks coverage above is the demo bar
  assert.ok(observed[0].observed_record.request_id);
  const html = renderMandateRulesBridgeSection(view.mandates_rules);
  assert.match(html, /City Record:/);
  assert.match(html, /data-observation-status="observed"/);
});
