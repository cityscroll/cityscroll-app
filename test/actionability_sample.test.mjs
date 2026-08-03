// Destination-class actionability sample — honesty gate for the flywheel.
//
//   node --test test/actionability_sample.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  classifyActionDestination,
  classifyDestinationUrl,
  measureActionabilitySample,
  actionabilityInputFromSample,
  primaryKineticAction,
  DEEP_CLASSES,
} from "../ontology/actionability_sample.mjs";
import {
  buildIntelligenceReceipt,
  planEnrichmentCards,
} from "../ontology/flywheel.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const actions = require(join(ROOT, "site/action_registry.js"));

function loadSampleFixture() {
  return JSON.parse(
    readFileSync(join(ROOT, "ontology/fixtures/dimensions/actionability_sample.json"), "utf8"),
  );
}

function measureCommittedSample() {
  const fixture = loadSampleFixture();
  return measureActionabilitySample({
    matters: fixture.matters,
    static_handoffs: fixture.static_handoffs,
    today: fixture.today,
    compileActionRail: actions.compileActionRail,
  });
}

test("classifyDestinationUrl: City Record RequestDetail is deep", () => {
  assert.equal(
    classifyDestinationUrl("https://a856-cityrecord.nyc.gov/RequestDetail/20241112003"),
    "deep",
  );
});

test("classifyDestinationUrl: PASSPort RFx browse is search_page; extranet item is deep", () => {
  assert.equal(
    classifyDestinationUrl("https://a0333-passportpublic.nyc.gov/rfx.html"),
    "search_page",
  );
  assert.equal(
    classifyDestinationUrl("https://a0333-passportpublic.nyc.gov/contracts.html"),
    "search_page",
  );
  assert.equal(
    classifyDestinationUrl(
      "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/36426",
    ),
    "deep",
  );
});

test("classifyDestinationUrl: Checkbook smart_search is scoped_search; agid detail is deep", () => {
  assert.equal(
    classifyDestinationUrl(
      "https://www.checkbooknyc.com/smart_search/citywide?search_term=CT107120248803393",
    ),
    "scoped_search",
  );
  assert.equal(
    classifyDestinationUrl("https://www.checkbooknyc.com/contract_search"),
    "search_page",
  );
  assert.equal(
    classifyDestinationUrl(
      "https://www.checkbooknyc.com/contract_details/agid/6032530/doctype/CT1",
    ),
    "deep",
  );
});

test("classifyDestinationUrl: OASys exams landing and iSupplier guide are landing", () => {
  assert.equal(classifyDestinationUrl("https://www.nyc.gov/examsforjobs"), "landing");
  assert.equal(
    classifyDestinationUrl("https://a856-exams.nyc.gov/OASysWeb/noe?examId=9619"),
    "deep",
  );  assert.equal(
    classifyDestinationUrl(
      "https://www.nyc.gov/site/nycha/business/isupplier-vendor-registration.page",
    ),
    "landing",
  );
});

test("classifyDestinationUrl: OpenGov project URL is deep; bare GetFile is search_page", () => {
  assert.equal(
    classifyDestinationUrl("https://procurement.opengov.com/portal/example/projects/42"),
    "deep",
  );
  assert.equal(
    classifyDestinationUrl("https://a856-cityrecord.nyc.gov/Search/GetFile"),
    "search_page",
  );
  assert.equal(
    classifyDestinationUrl(
      "https://a856-cityrecord.nyc.gov/Search/GetFile?RequestID=20240101001&DocumentID=1",
    ),
    "deep",
  );
});

test("classifyActionDestination: unavailable delivery is unavailable even with no destination", () => {
  assert.equal(
    classifyActionDestination({ type: "attend", delivery: "unavailable" }),
    "unavailable",
  );
  assert.equal(
    classifyActionDestination({ type: "watch", delivery: "local", destination: "#alerts" }),
    "local",
  );
});

test("primaryKineticAction prefers official handoff over local watch", () => {
  const rail = actions.compileActionRail({
    kind: "solicitation",
    pin: "85726B0060",
    title: "Tub Grinder",
    deadline: "2026-08-05T10:00:00.000",
    rfx_detail: { status: "unmatched", reason: "no_epin_pin_join" },
  }, { today: "2026-08-01" });
  const primary = primaryKineticAction(rail);
  assert.equal(primary.type, "official_application");
  assert.notEqual(primary.delivery, "local");
});

test("committed sample is not the vacuous ACTION_TYPES rate=1", () => {
  const sample = measureCommittedSample();
  const typeCount = (actions.ACTION_TYPES || []).length;

  assert.ok(sample.sample_size > 0, "sample must include rows");
  assert.ok(
    sample.sample_size !== typeCount || sample.rate < 1,
    "sample must not collapse to ACTION_TYPES length with rate 1",
  );
  // The committed fixture deliberately includes search-page / landing / unavailable rows.
  assert.ok(
    sample.rate < 1,
    `expected deep rate < 1 when search-page handoffs are in sample, got ${sample.rate}`,
  );
  assert.ok(sample.by_class.search_page > 0, "expected search_page rows in sample");
  assert.ok(sample.by_class.landing > 0, "expected landing rows in sample");
  assert.ok(sample.deep === sample.actionable);
  assert.equal(sample.actionable, DEEP_CLASSES.reduce((n, c) => n + sample.by_class[c], 0));
  assert.match(sample.basis, /ACTION_TYPES enum length is not a valid/i);
});

test("measureActionabilitySample scores PASSPort matched without rfp_id as search_page", () => {
  const sample = measureActionabilitySample({
    matters: [{
      sample_id: "passport-only",
      kind: "solicitation",
      pin: "81026B0003",
      title: "Records Remediation Project",
      deadline: "2026-08-18T13:00:00.000",
      rfx_detail: {
        status: "matched",
        portal: "https://a0333-passportpublic.nyc.gov/rfx.html",
        detail: { epin: "81026B0003", rfx_status: "Released" },
      },
    }],
    static_handoffs: [],
    today: "2026-08-01",
    compileActionRail: actions.compileActionRail,
  });
  assert.equal(sample.sample_size, 1);
  assert.equal(sample.rate, 0);
  assert.equal(sample.rows[0].class, "search_page");
});

test("measureActionabilitySample scores PASSPort matched with rfp_id as deep", () => {
  const sample = measureActionabilitySample({
    matters: [{
      sample_id: "passport-deep",
      kind: "solicitation",
      pin: "81026B0003",
      title: "Records Remediation Project",
      deadline: "2026-08-18T13:00:00.000",
      rfx_detail: {
        status: "matched",
        portal: "https://a0333-passportpublic.nyc.gov/rfx.html",
        detail: { epin: "81026B0003", rfx_status: "Released", rfp_id: "36426" },
      },
    }],
    static_handoffs: [],
    today: "2026-08-01",
    compileActionRail: actions.compileActionRail,
  });
  assert.equal(sample.sample_size, 1);
  assert.equal(sample.rate, 1);
  assert.equal(sample.rows[0].class, "deep");
});

test("all-deep sample yields rate 1; mixed sample yields honest fraction", () => {
  const deepOnly = measureActionabilitySample({
    matters: [{
      sample_id: "zap",
      kind: "zoning",
      lifecycle_stage: "public-review",
      project_url: "https://zap.planning.nyc.gov/projects/2021K0123",
    }],
    static_handoffs: [{
      id: "notice",
      url: "https://a856-cityrecord.nyc.gov/RequestDetail/20241112003",
    }],
    today: "2026-08-01",
    compileActionRail: actions.compileActionRail,
  });
  assert.equal(deepOnly.rate, 1);
  assert.equal(deepOnly.deep, 2);

  const mixed = measureActionabilitySample({
    matters: [],
    static_handoffs: [
      { id: "a", url: "https://a856-cityrecord.nyc.gov/RequestDetail/1" },
      { id: "b", url: "https://a0333-passportpublic.nyc.gov/rfx.html" },
    ],
  });
  assert.equal(mixed.sample_size, 2);
  assert.equal(mixed.deep, 1);
  assert.equal(mixed.rate, 0.5);
});

test("flywheel emits actionability card when destination-class deep rate is low", () => {
  const sample = measureCommittedSample();
  const input = actionabilityInputFromSample(sample);
  assert.ok(input.rate < 0.5, `committed sample should be below 0.5 so cards fire (rate=${input.rate})`);

  const receipt = buildIntelligenceReceipt({
    mode: "fixture",
    generated_at: "1970-01-01T00:00:00.000Z",
    source_coverage: { measurement: { after: { rate: 1, covered: 1, total: 1 } } },
    gap_taxonomy: { gaps: [] },
    registry_sync: { ok: true, summary: "ok" },
    cross_spine: { checked: 1, contradictions: 0 },
    actionability: input,
  });
  assert.equal(receipt.metrics.actionability_rate_sample, input.rate);
  assert.equal(receipt.metrics.actionability_sample_size, input.sample_size);

  const cards = planEnrichmentCards({
    receipt,
    source_coverage: { sources: [] },
    gap_taxonomy: { gaps: [] },
    registry_sync: { ok: true },
    cross_spine: { contradictions: 0 },
    actionability: input,
  });
  const actionCard = cards.find((c) => c.class === "actionability");
  assert.ok(actionCard, "expected actionability-low card when deep rate < 0.5");
  assert.ok(actionCard.evidence.by_class);
  assert.ok(actionCard.evidence.non_deep_sample?.length > 0);
  assert.match(actionCard.title, /deep-link/i);
});

test("intelligence_receipt --fixture reports actionability.rate < 1", () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "tools/intelligence_receipt.mjs"), "--fixture", "--json"],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.ok(
    Number.isFinite(receipt.metrics.actionability_rate_sample),
    "actionability_rate_sample must be numeric",
  );
  assert.ok(
    receipt.metrics.actionability_rate_sample < 1,
    `fixture receipt must not report vacuous rate=1 (got ${receipt.metrics.actionability_rate_sample})`,
  );
  assert.ok(
    receipt.metrics.actionability_sample_size > (actions.ACTION_TYPES || []).length
      || receipt.metrics.actionability_rate_sample < 1,
    "sample must not be the ACTION_TYPES enum stand-in",
  );
});

test("intelligence_flywheel --fixture can emit an actionability card", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-actionability-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, "tools/intelligence_flywheel.mjs"),
        "--fixture",
        "--emit-cards",
        dir,
        "--generated-at",
        "1970-01-01T00:00:00.000Z",
        "--json",
      ],
      { encoding: "utf8", cwd: ROOT },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.ok(receipt.metrics.actionability_rate_sample < 1);
    const actionCards = (receipt.cards_emitted || []).filter((c) => c.class === "actionability");
    assert.ok(actionCards.length >= 1, "flywheel should emit actionability card on low deep rate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
