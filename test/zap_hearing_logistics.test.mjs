/**
 * ZAP disposition hearing logistics + ULURP pipeline-position sentence.
 *
 *   node --test test/zap_hearing_logistics.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseHearingLocationText,
  extractZapHearingLogistics,
  filterHearingLogistics,
  normalizeHttpUrl,
  representingToPhaseId,
} from "../worker/src/lib/zap_hearing_logistics.mjs";
import { parseZapApiProject } from "../worker/src/lib/zap_outcomes.mjs";
import {
  buildUlurpPipelinePosition,
  buildUlurpStatutoryClockView,
  ULURP_PUBLIC_REVIEW_PHASE_IDS,
} from "../site/ulurp_statutory_clock.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";
import {
  zoningHandoff,
  compileActionRail,
} from "../worker/src/lib/action_registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test/fixtures/zap_hearing_logistics/2024Q0292.json");

test("parseHearingLocationText extracts in-person + youtube livestream (owner field case)", () => {
  const raw = "In person at 120-55 Queens Blvd or livestreamed at www.youtube.com/@queensbp";
  const parsed = parseHearingLocationText(raw);
  assert.equal(parsed.parse_status, "parsed");
  assert.equal(parsed.venue_address, "120-55 Queens Blvd");
  assert.equal(parsed.livestream_url, "https://www.youtube.com/@queensbp");
  assert.ok(parsed.attendance_modes.includes("in_person"));
  assert.ok(parsed.attendance_modes.includes("livestream"));
  assert.equal(parsed.raw, raw);
  assert.ok(parsed.provenance.derived.length >= 1);
});

test("parseHearingLocationText keeps raw when unparseable", () => {
  const raw = "See board office for details";
  const parsed = parseHearingLocationText(raw);
  assert.equal(parsed.parse_status, "raw_only");
  assert.equal(parsed.venue_address, null);
  assert.equal(parsed.livestream_url, null);
  assert.equal(parsed.raw, raw);
});

test("normalizeHttpUrl accepts bare www hosts and rejects javascript:", () => {
  assert.equal(normalizeHttpUrl("www.youtube.com/@queensbp"), "https://www.youtube.com/@queensbp");
  assert.equal(normalizeHttpUrl("javascript:alert(1)"), null);
});

test("2024Q0292 fixture: BP disposition yields address + youtube + datetime", () => {
  const payload = JSON.parse(readFileSync(FIX, "utf8"));
  const record = parseZapApiProject(payload);
  assert.equal(record.project_id, "2024Q0292");
  assert.equal(record.public_status, "In Public Review");
  assert.ok(Array.isArray(record.hearing_logistics));
  assert.ok(record.hearing_logistics.length >= 1);

  const bp = record.hearing_logistics.find((h) => h.representing === "Borough President");
  assert.ok(bp, "Borough President hearing logistics present");
  assert.equal(bp.phase_id, "borough_president");
  assert.equal(bp.venue_address, "120-55 Queens Blvd");
  assert.equal(bp.livestream_url, "https://www.youtube.com/@queensbp");
  assert.match(bp.hearing_at || "", /^2026-07-02T13:30/);
  assert.equal(bp.hearing_date, "2026-07-02");
  assert.ok(bp.maps_url.includes("120-55"));
  assert.equal(bp.parse_status, "parsed");
  assert.ok(bp.provenance?.hearing_at?.field === "dcp-dateofpublichearing");

  // Disposition raw fields retained for provenance.
  const disp = record.dispositions.find((d) => d.representing === "Borough President");
  assert.ok(disp);
  assert.match(disp.hearing_location || "", /Queens Blvd/i);
  assert.ok(disp.hearing_at);
});

test("filterHearingLogistics supports borough + attendance mode", () => {
  const rows = [
    {
      project_id: "A",
      borough: "Queens",
      hearing_date: "2026-09-01",
      attendance_modes: ["in_person", "livestream"],
      venue_address: "1 Main",
      livestream_url: "https://www.youtube.com/@x",
    },
    {
      project_id: "B",
      borough: "Brooklyn",
      hearing_date: "2026-09-02",
      attendance_modes: ["in_person"],
      venue_address: "2 Main",
    },
    {
      project_id: "C",
      borough: "Queens",
      hearing_date: "2026-01-01",
      attendance_modes: ["livestream"],
      livestream_url: "https://www.youtube.com/@y",
    },
  ];
  const upcoming = filterHearingLogistics(rows, { today: "2026-08-03", upcoming_only: true });
  assert.deepEqual(upcoming.map((r) => r.project_id).sort(), ["A", "B"]);
  const qnLive = filterHearingLogistics(rows, {
    today: "2026-08-03",
    borough: "Queens",
    mode: "livestream",
  });
  assert.deepEqual(qnLive.map((r) => r.project_id), ["A"]);
});

test("pipeline position joins public review with BP step and 30-day clock", () => {
  assert.deepEqual([...ULURP_PUBLIC_REVIEW_PHASE_IDS], [
    "community_board",
    "borough_president",
    "cpc",
    "city_council",
    "mayoral_appeals",
  ]);

  const spine = {
    events: [
      {
        id: "cert",
        kind: "zap_milestone",
        title: "Application Reviewed at City Planning Commission Review Session",
        detail: "Certified",
        status: "Completed",
        time: { value: "2026-05-11", precision: "day", basis: "actual_end", certainty: "actual" },
      },
      {
        id: "cb",
        kind: "zap_milestone",
        title: "Community Board Review",
        detail: "Completed",
        status: "Completed",
        time: { value: "2026-07-08", precision: "day", basis: "actual_end", certainty: "actual" },
      },
      {
        id: "bp",
        kind: "zap_milestone",
        title: "Borough President Review",
        detail: "In Progress",
        status: "In Progress",
        time: { value: "2026-07-09", precision: "day", basis: "actual_start", certainty: "actual" },
      },
    ],
  };
  const record = {
    project_id: "2024Q0292",
    public_status: "In Public Review",
    certified_referred: "2026-05-11",
    milestones: spine.events,
    spine,
  };
  const clock = buildUlurpStatutoryClockView(record, { generatedAt: "2026-08-03T12:00:00Z" });
  const phaseView = buildLandPhaseView(spine, {
    public_status: "In Public Review",
    project_id: "2024Q0292",
  });
  assert.equal(phaseView.current.phase_id, "borough_president");

  const pos = buildUlurpPipelinePosition({
    phaseView,
    clock,
    publicStatus: "In Public Review",
    today: "2026-08-03",
  });
  assert.ok(pos);
  assert.equal(pos.step_phase_id, "borough_president");
  assert.equal(pos.step_n, 2);
  assert.equal(pos.step_m, 5);
  assert.equal(pos.window_days, 30);
  assert.equal(pos.due_date, "2026-08-09");
  assert.equal(pos.days_left, 6);
  assert.equal(pos.overall_status, "public_review");
});

test("zoning handoff surfaces attend maps + watch live from ZAP logistics", () => {
  const matter = {
    kind: "zoning",
    project_id: "2024Q0292",
    public_status: "In Public Review",
    phase_id: "borough_president",
    phase_label: "Borough President review",
    project_url: "https://zap.planning.nyc.gov/projects/2024Q0292",
    hearings: [
      {
        event_date: "2026-09-10T13:30:00.000Z",
        agency: "Borough President",
        title: "Borough President public hearing",
        notice_text: "In person at 120-55 Queens Blvd or livestreamed at www.youtube.com/@queensbp",
        venue: { address: "120-55 Queens Blvd", mode: "hybrid" },
        street_address_1: "120-55 Queens Blvd",
        participation_url: "https://www.youtube.com/@queensbp",
        livestream_url: "https://www.youtube.com/@queensbp",
        maps_url: "https://www.google.com/maps/search/?api=1&query=120-55%20Queens%20Blvd%2C%20New%20York%2C%20NY",
        body_kind: "borough_president",
        source: "zap_disposition",
      },
    ],
  };
  const handoff = zoningHandoff(matter, { today: "2026-08-03" });
  assert.equal(handoff.system, "zoning_extracted");
  assert.equal(handoff.venue_address, "120-55 Queens Blvd");
  assert.equal(handoff.livestream_url, "https://www.youtube.com/@queensbp");
  assert.ok(handoff.maps_url);

  const actions = compileActionRail(matter, { today: "2026-08-03" });
  const dests = actions.map((a) => a.destination).filter(Boolean);
  assert.ok(dests.some((d) => /maps\.google|google\.com\/maps/i.test(d)), "maps attend present");
  assert.ok(dests.some((d) => /youtube\.com\/@queensbp/i.test(d)), "youtube watch present");
  assert.ok(actions.some((a) => a.label_key === "land_action_attend_in_person"
    || a.label_key === "land_action_attend_in_person_at"
    || /Attend in person/i.test(a.label || "")));
  assert.ok(actions.some((a) => a.label_key === "land_action_watch_live"));
});

test("extractZapHearingLogistics dedupes ZM/ZR disposition pairs", () => {
  const logistics = extractZapHearingLogistics({
    project_id: "X",
    portal_url: "https://zap.planning.nyc.gov/projects/X",
    dispositions: [
      {
        id: "1",
        name: "X_ZM_QN BP",
        representing: "Borough President",
        hearing_date: "2026-07-02",
        hearing_at: "2026-07-02T13:30:00.000Z",
        hearing_location: "In person at 120-55 Queens Blvd or livestreamed at www.youtube.com/@queensbp",
      },
      {
        id: "2",
        name: "X_ZR_QN BP",
        representing: "Borough President",
        hearing_date: "2026-07-02",
        hearing_at: "2026-07-02T13:30:00.000Z",
        hearing_location: "In person at 120-55 Queens Blvd or livestreamed at www.youtube.com/@queensbp",
      },
    ],
  });
  assert.equal(logistics.length, 1);
  assert.equal(representingToPhaseId("Borough President"), "borough_president");
});

test("land upcoming hearings snapshot is present and free of synthetic rows", () => {
  const snap = JSON.parse(
    readFileSync(join(ROOT, "site/data/land_upcoming_hearings.json"), "utf8"),
  );
  assert.ok(Array.isArray(snap.hearings));
  // Empty is allowed when no future ZAP hearing dates are published; padding is not.
  for (const h of snap.hearings) {
    assert.ok(h.project_id);
    assert.ok(h.hearing_date || h.hearing_at);
    assert.notEqual(h.project_name, "Fixture Street Rezoning");
    assert.notEqual(h.project_name, "Example Avenue Special Permit");
    const derived = h.provenance?.derived || [];
    assert.ok(
      !derived.some((d) => d.field === "fixture" || /fixture|synthetic/i.test(String(d.method || ""))),
      "production row must not carry fixture provenance",
    );
  }
  // Filter still works on fixture-derived rows at a day inside the 2024Q0292 window.
  const payload = JSON.parse(readFileSync(FIX, "utf8"));
  const record = parseZapApiProject(payload);
  const logistics = extractZapHearingLogistics(record, {
    project_id: record.project_id,
    portal_url: record.portal_url,
    borough: "Queens",
  });
  const qn = filterHearingLogistics(logistics, {
    today: "2026-06-01",
    borough: "Queens",
    mode: "livestream",
  });
  assert.ok(qn.length >= 1);
});

test("site modules reference pipeline position and hearing logistics", () => {
  const land = readFileSync(join(ROOT, "site/app/land.mjs"), "utf8");
  assert.match(land, /landPipelinePositionHTML/);
  assert.match(land, /buildUlurpPipelinePosition/);
  assert.match(land, /land_upcoming_hearings/);
  assert.match(land, /status==="hearings"/);

  const feed = readFileSync(join(ROOT, "site/app/feed-actions.mjs"), "utf8");
  assert.match(feed, /landActionZapHearingsFromRecord/);
  assert.match(feed, /hearing_logistics/);

  const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
  assert.match(i18n, /land_pipeline_position_html/);
  assert.match(i18n, /land_action_watch_live/);
  assert.match(i18n, /land_status_upcoming_hearings/);
});
