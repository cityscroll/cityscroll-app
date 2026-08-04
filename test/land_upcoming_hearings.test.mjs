/**
 * Land upcoming-hearings materialization + synthetic-row detector.
 *
 *   node --test test/land_upcoming_hearings.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isSyntheticHearingRow,
  isTraceableHearingRow,
  detectSyntheticUpcomingHearings,
  buildUpcomingHearingsSnapshot,
  buildMaterializationReceipt,
  hearingsFromZapApiPayload,
  reviewZapHearingMilestones,
  enrichHearingRows,
  LAND_HEARING_MATERIALIZATION_METHOD,
  ZAP_MILESTONE_HEARING_SOURCE,
} from "../tools/lib/land_upcoming_hearings.mjs";
import { loadFixtureHearings } from "../tools/build_land_upcoming_hearings.mjs";
import { parseZapApiProject } from "../worker/src/lib/zap_outcomes.mjs";
import { extractFn } from "./contract/site_extract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test/fixtures/zap_hearing_logistics/2024Q0292.json");
const PROD = join(ROOT, "site/data/land_upcoming_hearings.json");

function baseRow(over = {}) {
  return {
    schema_version: 1,
    source: "zap-api-dispositions",
    project_id: "2024Q0292",
    project_name: "Real Project",
    borough: "Queens",
    hearing_date: "2026-09-15",
    hearing_at: "2026-09-15T18:30:00.000Z",
    venue_address: "120-55 Queens Blvd",
    attendance_modes: ["in_person"],
    parse_status: "parsed",
    provenance: {
      field: "dcp-publichearinglocation",
      source: "zap-api-dispositions",
      derived: [],
    },
    ...over,
  };
}

test("isSyntheticHearingRow catches fixture-pad markers from the deferral", () => {
  assert.equal(isSyntheticHearingRow(baseRow()), false);
  assert.equal(
    isSyntheticHearingRow(
      baseRow({
        project_id: "2024K0240",
        project_name: "Fixture Street Rezoning",
      }),
    ),
    true,
  );
  assert.equal(
    isSyntheticHearingRow(
      baseRow({
        project_id: "2025M0100",
        project_name: "Example Avenue Special Permit",
      }),
    ),
    true,
  );
  assert.equal(
    isSyntheticHearingRow(
      baseRow({
        provenance: {
          field: "dcp-publichearinglocation",
          source: "zap-api-dispositions",
          derived: [{ field: "fixture", method: "build_land_upcoming_hearings" }],
        },
      }),
    ),
    true,
  );
  assert.equal(isSyntheticHearingRow(baseRow({ _synthetic: true })), true);
  assert.equal(isSyntheticHearingRow(baseRow({ project_id: "FIXZAP001" })), true);
});

test("detectSyntheticUpcomingHearings fails closed on synthetic production rows", () => {
  const bad = {
    schema_version: 1,
    hearings: [
      baseRow(),
      baseRow({
        project_id: "2024K0240",
        project_name: "Fixture Street Rezoning",
        borough: "Brooklyn",
      }),
    ],
  };
  const result = detectSyntheticUpcomingHearings(bad);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.kind === "synthetic_row"));
});

test("detectSyntheticUpcomingHearings accepts empty real snapshot", () => {
  const empty = {
    schema_version: 1,
    materialization: {
      method: LAND_HEARING_MATERIALIZATION_METHOD,
      mode: "live",
      upcoming_count: 0,
    },
    hearings: [],
  };
  const result = detectSyntheticUpcomingHearings(empty);
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("milestone traceability requires the accepted class to match the exact published title", () => {
  const milestone = baseRow({
    source: ZAP_MILESTONE_HEARING_SOURCE,
    milestone_id: "milestone-1",
    milestone_title: "Post Hearing Follow-Up / Future Votes",
    milestone_source_title: "Review Session - Post Hearing Follow-Up / Future Votes",
    event_class: "cpc_public_hearing",
    portal_url: "https://zap.planning.nyc.gov/projects/2024Q0292",
    provenance: {
      field: "dcp-reviewmeetingdate",
      source: ZAP_MILESTONE_HEARING_SOURCE,
      derived: [],
    },
  });
  assert.equal(isTraceableHearingRow(milestone), false);
  const detection = detectSyntheticUpcomingHearings({ hearings: [milestone] });
  assert.equal(detection.ok, false);
  assert.ok(detection.findings.some((finding) => finding.kind === "untraceable_row"));
});

test("buildUpcomingHearingsSnapshot strips synthetic and past rows", () => {
  const rows = [
    baseRow({ hearing_date: "2026-01-01", hearing_at: "2026-01-01T12:00:00.000Z" }),
    baseRow({
      project_id: "2026X0001",
      hearing_date: "2026-09-01",
      hearing_at: "2026-09-01T18:00:00.000Z",
    }),
    baseRow({
      project_id: "2024K0240",
      project_name: "Fixture Street Rezoning",
      hearing_date: "2026-10-01",
      hearing_at: "2026-10-01T18:00:00.000Z",
    }),
  ];
  const snap = buildUpcomingHearingsSnapshot(rows, {
    today: "2026-08-03",
    mode: "test",
    projects_listed: 3,
    projects_fetched: 3,
    projects_failed: 0,
  });
  assert.equal(snap.hearings.length, 1);
  assert.equal(snap.hearings[0].project_id, "2026X0001");
  assert.equal(snap.materialization.method, LAND_HEARING_MATERIALIZATION_METHOD);
  assert.equal(snap.materialization.upcoming_count, 1);
  const receipt = buildMaterializationReceipt(snap);
  assert.equal(receipt.detector_ok, true);
  assert.equal(receipt.upcoming_count, 1);
});

test("2024Q0292 fixture extracts real logistics (test-scoped only)", () => {
  const payload = JSON.parse(readFileSync(FIX, "utf8"));
  const rows = hearingsFromZapApiPayload(payload, {
    project_id: "2024Q0292",
    borough: "Queens",
  });
  assert.ok(rows.length >= 1);
  const bp = rows.find((r) => r.representing === "Borough President");
  assert.ok(bp);
  assert.equal(bp.venue_address, "120-55 Queens Blvd");
  // Prefer host+path assertion so review surfaces do not treat the handle as a social profile link.
  assert.match(String(bp.livestream_url || ""), /^https:\/\/www\.youtube\.com\//);
  assert.match(String(bp.livestream_url || ""), /queensbp/);
  assert.equal(isSyntheticHearingRow(bp), false);
  assert.equal(isTraceableHearingRow(bp), true);

  // At a fixed day inside the fixture window, upcoming is non-empty.
  const snap = buildUpcomingHearingsSnapshot(rows, {
    today: "2026-06-01",
    mode: "fixture",
  });
  assert.ok(snap.hearings.length >= 1);
  assert.ok(snap.hearings.every((h) => h.project_id === "2024Q0292"));
});

test("2024Q0292 fixture accepts only the two source-published CPC hearing milestone classes", () => {
  const payload = JSON.parse(readFileSync(FIX, "utf8"));
  const record = parseZapApiProject(payload);
  const review = reviewZapHearingMilestones(record, {
    project_id: "2024Q0292",
    project_name: record.project_name,
    public_status: record.public_status,
    portal_url: record.portal_url,
    borough: "Queens",
  });

  assert.deepEqual(
    review.hearings.map((row) => row.event_class).sort(),
    ["cpc_pre_hearing_review_session", "cpc_public_hearing"],
  );
  assert.ok(review.hearings.every((row) => row.source === ZAP_MILESTONE_HEARING_SOURCE));
  assert.ok(review.hearings.every((row) => row.provenance.field === "dcp-reviewmeetingdate"));
  assert.ok(review.hearings.every((row) => row.portal_url === record.portal_url));
  assert.ok(review.hearings.every((row) => isTraceableHearingRow(row)));
  assert.equal(
    review.hearings.find((row) => row.event_class === "cpc_pre_hearing_review_session")?.hearing_at,
    "2026-08-10T04:00:00.000Z",
  );

  const reviewedTitles = review.reviewed_false_positive_sample.map((row) => row.source_title);
  assert.ok(reviewedTitles.includes("Review Session - Certified / Referred"));
  assert.ok(reviewedTitles.includes("Review Session - Post Hearing Follow-Up / Future Votes"));
  assert.ok(!review.hearings.some((row) => /Post Hearing|Future Votes/i.test(row.milestone_source_title)));
});

test("fixture measurement recovers future milestones without manufacturing logistics", () => {
  const payload = JSON.parse(readFileSync(FIX, "utf8"));
  const rows = hearingsFromZapApiPayload(payload, {
    project_id: "2024Q0292",
    borough: "Queens",
  });
  const snap = buildUpcomingHearingsSnapshot(rows, {
    today: "2026-08-03",
    mode: "fixture",
  });

  assert.equal(snap.materialization.disposition_upcoming_count, 0);
  assert.equal(snap.materialization.milestone_upcoming_count, 2);
  assert.equal(snap.materialization.upcoming_count, 2);
  assert.deepEqual(
    snap.materialization.accepted_milestone_classes,
    {
      cpc_pre_hearing_review_session: 1,
      cpc_public_hearing: 1,
    },
  );
  for (const row of snap.hearings) {
    assert.equal(row.venue_address, null);
    assert.equal(row.livestream_url, null);
    assert.deepEqual(row.attendance_modes, []);
    assert.ok(row.project_id);
    assert.ok(row.hearing_date);
    assert.match(row.portal_url, /zap\.planning\.nyc\.gov\/projects\/2024Q0292$/);
  }
});

test("published date-only milestone timestamps render on the publisher calendar day", () => {
  const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
  const fdt = new Function(
    "window",
    `${extractFn("fdt")}; return fdt;`,
  )(windowStub);
  assert.equal(
    fdt("2026-08-10T04:00:00.000Z", { dateOnly: true }),
    "August 10, 2026",
  );
  const landSource = readFileSync(join(ROOT, "site/app/land.mjs"), "utf8");
  assert.match(landSource, /dateOnly:row\.parse_status==="published_date_only"/);
});

test("loadFixtureHearings reads only test fixtures and invents nothing", () => {
  const rows = loadFixtureHearings();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => !isSyntheticHearingRow(r)));
  assert.ok(rows.every((r) => r.project_id === "2024Q0292"));
});

test("production land_upcoming_hearings.json has no synthetic rows", () => {
  assert.ok(existsSync(PROD), "committed product snapshot must exist");
  const snap = JSON.parse(readFileSync(PROD, "utf8"));
  const result = detectSyntheticUpcomingHearings(snap);
  assert.equal(
    result.ok,
    true,
    `synthetic/untraceable findings: ${JSON.stringify(result.findings)}`,
  );
  for (const h of snap.hearings || []) {
    assert.equal(isSyntheticHearingRow(h), false);
    assert.ok(h.project_id);
    assert.ok(h.hearing_date || h.hearing_at);
    // Known deferral pad ids must never reappear.
    assert.notEqual(h.project_name, "Fixture Street Rezoning");
    assert.notEqual(h.project_name, "Example Avenue Special Permit");
  }
});

test("enrichHearingRows fills project meta without inventing logistics", () => {
  const enriched = enrichHearingRows(
    [{ project_id: null, hearing_date: "2026-09-01", source: "zap-api-dispositions" }],
    { project_id: "2026K0001", project_name: "Test", borough: "Brooklyn", public_status: "In Public Review" },
  );
  assert.equal(enriched[0].project_id, "2026K0001");
  assert.equal(enriched[0].borough, "Brooklyn");
  assert.equal(enriched[0].venue_address, undefined);
});
