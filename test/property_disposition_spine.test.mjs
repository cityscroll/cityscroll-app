import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * Characterization: property disposition process spine
 * (hearing → auction_or_rfp → award_or_conveyance) by BBL / borough+block-lot.
 *
 * Field case: two+ Property Disposition notices sharing BBL show one chain;
 * single-notice spines stay honest (empty stages class-a, no invented events).
 * Filter chips propStage/PROP_STAGES remain temporal list filters, not this spine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISPOSITION_STAGES,
  STAGE_AUCTION_OR_RFP,
  STAGE_AWARD_OR_CONVEYANCE,
  STAGE_HEARING,
  attachDispositionSpines,
  buildPropertyDispositionSpine,
  classifyDispositionStage,
  dispositionJoinKeys,
  groupDispositionSpines,
  measurePropertyDispositionSpineCompleteness,
  spineForNotice,
} from "../worker/src/lib/property_disposition_spine.mjs";
import { propertyLocationFromRow } from "../site/property_location.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/property_disposition/multi_notice_bbl.json"), "utf8"),
);

test("DISPOSITION_STAGES is hearing → auction_or_rfp → award_or_conveyance", () => {
  assert.deepEqual([...DISPOSITION_STAGES], [
    "hearing",
    "auction_or_rfp",
    "award_or_conveyance",
  ]);
});

test("classifyDispositionStage maps notice types and body language without inventing stages", () => {
  assert.equal(
    classifyDispositionStage({ type_of_notice_description: "Public Hearings", short_title: "Disposition" }),
    STAGE_HEARING,
  );
  assert.equal(
    classifyDispositionStage({
      type_of_notice_description: "Sale",
      short_title: "REQUEST FOR PROPOSALS - INDUSTRY ROAD",
      additional_description_1: "Request for Proposals (RFP) for the sale",
    }),
    STAGE_AUCTION_OR_RFP,
  );
  assert.equal(
    classifyDispositionStage({
      type_of_notice_description: "Notice",
      short_title: "Notice of Public Sale",
      additional_description_1: "Public sale of residential property. Upset price $1.",
    }),
    STAGE_AUCTION_OR_RFP,
  );
  assert.equal(
    classifyDispositionStage({
      type_of_notice_description: "Notice",
      short_title: "Notice of tentative winning bidders",
      additional_description_1: "The property has been sold for $275,000.",
    }),
    STAGE_AWARD_OR_CONVEYANCE,
  );
  assert.equal(
    classifyDispositionStage({
      type_of_notice_description: "Notice",
      short_title: "OFFICIAL NOTICE OF PENDING DESTRUCTION",
      additional_description_1: "Unauthorized tobacco products pending destruction.",
    }),
    null,
  );
});

test("dispositionJoinKeys require BBL or borough+block/lot — never bare block alone", () => {
  const withBbl = dispositionJoinKeys({
    scope: "local",
    boroughs: ["Staten Island"],
    bbls: ["5006840261"],
    tax_lots: [{ block: "684", lots: ["261"] }],
  });
  assert.ok(withBbl.includes("bbl:5006840261"));
  assert.ok(withBbl.includes("taxlot:staten-island:684/261"));

  const noBorough = dispositionJoinKeys({
    scope: "local",
    boroughs: [],
    bbls: [],
    tax_lots: [{ block: "684", lots: ["261"] }],
  });
  assert.deepEqual(noBorough, []);

  const fromRow = dispositionJoinKeys(null, {
    short_title: "Disposition",
    additional_description_1:
      "City-owned property in the Borough of Manhattan Block 644 Lot 1 for lease surrender.",
  });
  // propertyLocationFromRow may supply borough+tax lot / BBL from the same text.
  const loc = propertyLocationFromRow({
    short_title: "Disposition",
    additional_description_1:
      "City-owned property in the Borough of Manhattan Block 644 Lot 1 for lease surrender.",
  });
  if (loc.bbls.length || (loc.boroughs.length && loc.tax_lots.length)) {
    assert.ok(dispositionJoinKeys(loc).length >= 1);
  }
  assert.ok(Array.isArray(fromRow));
});

test("field case: full three-stage chain on one BBL is one full spine", () => {
  const chain = fixture.notices.filter((n) => String(n.request_id).startsWith("full-chain-"));
  const spine = buildPropertyDispositionSpine(chain);

  assert.equal(spine.schema_version, 1);
  assert.equal(
    spine.subject_ref,
    "disposition:housing-preservation-and-development:bbl:5006840261",
  );
  assert.equal(spine.join.method, "exact_bbl");
  assert.equal(spine.full, true);
  assert.equal(spine.stage_fill, 1);
  assert.deepEqual(
    spine.stages.map((s) => [s.kind, s.matched]),
    [
      ["hearing", true],
      ["auction_or_rfp", true],
      ["award_or_conveyance", true],
    ],
  );
  assert.deepEqual(
    [...spine.events].map((e) => e.time.value),
    [...spine.events].map((e) => e.time.value).sort(),
  );
  assert.ok(spine.events.every((e) => e.source?.url && e.time?.precision === "day"));
  assert.equal(spine.gaps.length, 0);
});

test("field case: two+ hearing notices sharing BBL form one multi-notice hearing stage", () => {
  const excelsior = fixture.notices.filter((n) =>
    ["20150421106", "20150609105"].includes(n.request_id),
  );
  const spine = buildPropertyDispositionSpine(excelsior);
  assert.equal(spine.join.notice_count, 2);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_HEARING).matched, true);
  assert.equal(spine.stages.find((s) => s.kind === STAGE_HEARING).notice_count, 2);
  // Later stages stay explicit empty — not invented, class-a.
  const empty = spine.stages.filter((s) => !s.matched).map((s) => s.kind);
  assert.deepEqual(empty, [STAGE_AUCTION_OR_RFP, STAGE_AWARD_OR_CONVEYANCE]);
  assert.ok(spine.gaps.every((g) => g.class === "not_yet_ingested" && g.source === "City Record Online"));
  assert.equal(spine.events.length, 2);
});

test("groupDispositionSpines joins same-agency BBL chains and keeps cross-agency separate", () => {
  const spines = groupDispositionSpines(fixture.notices);
  const full = spineForNotice(spines, "full-chain-hearing");
  assert.ok(full);
  assert.equal(full.full, true);
  assert.equal(full.join.notice_count, 3);
  // SBS notice on same BBL must not merge into HPD chain (agency-scoped subject).
  const sbs = spineForNotice(spines, "cross-agency-same-lot");
  assert.ok(sbs);
  assert.notEqual(sbs.subject_ref, full.subject_ref);
  assert.match(sbs.subject_ref, /^disposition:small-business-services:bbl:/);
  assert.equal(sbs.join.notice_count, 1);
  assert.ok(!full.stages.some((st) => (st.request_ids || []).includes("cross-agency-same-lot")));

  const industry = spineForNotice(spines, "20220504006");
  assert.ok(industry);
  assert.equal(industry.join.notice_count, 2);
  assert.ok(industry.stages.find((s) => s.kind === STAGE_AUCTION_OR_RFP).matched);

  const auto = spineForNotice(spines, "singleton-unlocated");
  assert.ok(auto);
  assert.equal(auto.join.method, "single_notice");
  assert.equal(auto.subject_ref, "notice:singleton-unlocated");
  assert.equal(auto.stages.find((s) => s.kind === STAGE_AUCTION_OR_RFP).matched, true);
});

test("single-notice spine is honest: one matched stage, empty slots not filled with filter labels", () => {
  const row = fixture.notices.find((n) => n.request_id === "singleton-unlocated");
  const spine = buildPropertyDispositionSpine([row]);
  assert.equal(spine.matched_stages, 1);
  assert.equal(spine.full, false);
  // Never re-label temporal filter chips as process stages.
  assert.ok(!spine.stages.some((s) => ["proposed", "soon", "upcoming", "past"].includes(s.kind)));
  assert.deepEqual(
    spine.gaps.map((g) => g.slot),
    [STAGE_HEARING, STAGE_AWARD_OR_CONVEYANCE],
  );
});

test("measurePropertyDispositionSpineCompleteness moves with fill", () => {
  const empty = measurePropertyDispositionSpineCompleteness([]);
  assert.equal(empty.metric, "property_disposition_spine_completeness_rate");
  assert.equal(empty.property_disposition_spine_completeness_rate, 0);

  const spines = groupDispositionSpines(fixture.notices);
  const metrics = measurePropertyDispositionSpineCompleteness(spines);
  assert.ok(metrics.spine_count >= 4);
  assert.ok(metrics.multi_notice_spine_count >= 2);
  assert.ok(metrics.property_disposition_spine_completeness_rate > 0);
  assert.ok(metrics.property_disposition_spine_completeness_rate <= 1);
  assert.ok(metrics.full_spine_rate > 0);
  assert.ok(metrics.stage_rates.hearing >= 0);
});

test("attachDispositionSpines stamps the property view without inventing locations", () => {
  const view = attachDispositionSpines({
    schema_version: 1,
    properties: fixture.notices,
  });
  assert.ok(Array.isArray(view.disposition_spines));
  assert.ok(view.disposition_spines.length >= 4);
  assert.equal(view.disposition_metrics.metric, "property_disposition_spine_completeness_rate");
  const stamped = view.properties.find((p) => p.request_id === "full-chain-hearing");
  assert.equal(stamped.disposition_stage, STAGE_HEARING);
  assert.equal(
    stamped.disposition_subject_ref,
    "disposition:housing-preservation-and-development:bbl:5006840261",
  );
  assert.ok(stamped.disposition_join_keys.includes("bbl:5006840261"));
});

test("public Property Disposition notice detail mounts the spine; temporal filter rail stays filter-only", () => {
  const index = SITE_SOURCE;
  assert.match(index, /function propertyDispositionSpineHTML/);
  assert.match(index, /loadPropertyDispositionSpine/);
  assert.match(index, /disposition_spines/);
  // Temporal filter rail (not process stages) remains alongside the process rail.
  assert.match(index, /const PROP_STAGES=\[\["all","stage_all"\],\["proposed"/);
  assert.match(index, /function propStage\(r\)/);
  assert.match(index, /id="processrail"/);
  assert.match(index, /buildPropertyExplorerEntries/);
  // Process stage labels used by the spine UI.
  assert.match(index, /disposition_stage_hearing/);
  assert.match(index, /disposition_stage_auction_or_rfp/);
  assert.match(index, /disposition_stage_award_or_conveyance/);
  assert.match(index, /lifecycleNoticeEventsHTML\(p\.events\)/);
  assert.match(index, /join_evidence_summary/);
  assert.doesNotMatch(index, /disposition_join_matched_html/);
});
