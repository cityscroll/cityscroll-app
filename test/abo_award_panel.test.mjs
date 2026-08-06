import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  aboAwardSourceUrl,
  releasedAboAward,
} from "../site/abo_award_panel.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const EDGE = {
  request_id: "20230406117",
  source_key: "d84c-dk28:Governors Island Corporation:BRYAN CAVE LEIGHTON PAISNER LLP",
  method: "title_date_fuzzy",
  confidence: 0.97,
  award: {
    dataset: "d84c-dk28",
    authority_name: "Governors Island Corporation",
    vendor_name: "BRYAN CAVE LEIGHTON PAISNER LLP",
    procurement_description: "Zoning and land use counsel services",
    award_date: "2023-07-11T00:00:00.000",
    contract_amount: "$101,368.85",
  },
};

function payload(status = "accepted", edge = EDGE) {
  return {
    schema: "cityscroll.abo_award_residual.v1",
    bridge: {
      status,
      fuzzy_precision_floor: 0.95,
      fuzzy_precision: 0.97,
    },
    matches_by_request_id: edge ? { [edge.request_id]: edge } : {},
  };
}

test("released ABO award exposes the complete official award tuple", () => {
  assert.deepEqual(releasedAboAward(payload(), EDGE.request_id), {
    request_id: EDGE.request_id,
    source_key: EDGE.source_key,
    method: "title_date_fuzzy",
    confidence: 0.97,
    dataset: "d84c-dk28",
    authority: "Governors Island Corporation",
    vendor: "BRYAN CAVE LEIGHTON PAISNER LLP",
    amount: 101368.85,
    award_date: "2023-07-11",
    description: "Zoning and land use counsel services",
  });
});

test("unresolved and below-threshold notices are honestly absent", () => {
  assert.equal(releasedAboAward(payload("stopped_below_threshold"), EDGE.request_id), null);
  assert.equal(releasedAboAward(payload("accepted", null), EDGE.request_id), null);
  assert.equal(releasedAboAward(payload(), "not-present"), null);
  const lowPrecision = payload();
  lowPrecision.bridge.fuzzy_precision = 0.5;
  assert.equal(releasedAboAward(lowPrecision, EDGE.request_id), null);
});

test("source link resolves to the human-readable published dataset page", () => {
  const match = releasedAboAward(payload(), EDGE.request_id);
  const url = new URL(aboAwardSourceUrl(match));
  assert.equal(url.origin, "https://data.ny.gov");
  assert.equal(url.pathname, "/d/d84c-dk28");
  assert.equal(url.search, "");
});

test("malformed released rows do not create incomplete public cards", () => {
  const incomplete = structuredClone(EDGE);
  delete incomplete.award.vendor_name;
  assert.equal(releasedAboAward(payload("accepted", incomplete), EDGE.request_id), null);
  const lowEdgeConfidence = structuredClone(EDGE);
  lowEdgeConfidence.confidence = 0.8;
  assert.equal(releasedAboAward(payload("accepted", lowEdgeConfidence), EDGE.request_id), null);
});

test("the current below-threshold production payload renders no match", () => {
  const current = JSON.parse(readFileSync(new URL("../site/data/abo_award_residual_lookup.json", import.meta.url)));
  assert.equal(current.bridge.status, "stopped_below_threshold");
  assert.equal(releasedAboAward(current, EDGE.request_id), null);
});

function extractFunction(name) {
  const start = SITE_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain in the registered site modules`);
  let depth = 0;
  let seen = false;
  for (let i = SITE_SOURCE.indexOf("{", start); i < SITE_SOURCE.length; i += 1) {
    if (SITE_SOURCE[i] === "{") { depth += 1; seen = true; }
    else if (SITE_SOURCE[i] === "}" && seen && --depth === 0) return SITE_SOURCE.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

test("public card names vendor, amount, date, authority, and the exact source", () => {
  const render = new Function(
    "t", "escUiHtml", "lifecycleMoney", "fdate", "EXT_ATTRS", "extSR",
    `${extractFunction("aboAwardPanelHTML")}; return aboAwardPanelHTML;`,
  )(
    (key) => ({
      external_awards_heading: "Awards published elsewhere",
      lifecycle_stage_award: "Award",
      external_awards_abo_source: "NYS Authorities Budget Office",
      award_guide_amount_label: "Award amount",
    })[key] || key,
    (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    (value) => `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    (value) => String(value).slice(0, 10),
    'target="_blank" rel="noopener noreferrer"',
    () => '<span class="sr-only"> (opens in new tab)</span>',
  );
  const match = releasedAboAward(payload(), EDGE.request_id);
  const html = render(match, aboAwardSourceUrl(match));
  assert.match(html, /data-abo-award-panel="1"/);
  assert.match(html, /BRYAN CAVE LEIGHTON PAISNER LLP/);
  assert.match(html, /\$101,368\.85/);
  assert.match(html, /2023-07-11/);
  assert.match(html, /Governors Island Corporation/);
  assert.match(html, /data-abo-award-source="1"/);
  assert.match(html, /data\.ny\.gov\/d\/d84c-dk28/);
  assert.doesNotMatch(html, /possible|fuzzy|candidate/i);
});

test("routing renders either the released award or the older candidate panel, never both", () => {
  assert.match(SITE_SOURCE, /if\(!released\) externalAwardForNotice\(r, \$\("#nexternal"\)\)/);
  assert.equal((SITE_SOURCE.match(/externalAwardForNotice\(r, \$\("#nexternal"\)\)/g) || []).length, 2,
    "one fallback and one error fallback should be the only external award call sites");
});
