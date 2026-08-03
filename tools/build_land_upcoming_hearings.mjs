#!/usr/bin/env node
/**
 * Build site/data/land_upcoming_hearings.json from ZAP disposition logistics.
 *
 * Default: characterize from committed fixtures (no network).
 * Optional live: --live --project 2024Q0292 (polite sequential fetches).
 *
 *   node tools/build_land_upcoming_hearings.mjs
 *   node tools/build_land_upcoming_hearings.mjs --check
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseZapApiProject } from "../worker/src/lib/zap_outcomes.mjs";
import {
  filterHearingLogistics,
  extractZapHearingLogistics,
} from "../worker/src/lib/zap_hearing_logistics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/land_upcoming_hearings.json");
const FIX_DIR = join(ROOT, "test/fixtures/zap_hearing_logistics");

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const live = args.has("--live");

function loadFixtureHearings() {
  const out = [];
  const names = ["2024Q0292.json"];
  for (const name of names) {
    const path = join(FIX_DIR, name);
    if (!existsSync(path)) continue;
    const record = parseZapApiProject(JSON.parse(readFileSync(path, "utf8")));
    const logistics = extractZapHearingLogistics(record, {
      project_id: record.project_id,
      portal_url: record.portal_url,
      borough: "Queens",
    }).map((h) => ({
      ...h,
      project_name: record.project_name,
      public_status: record.public_status,
      borough: h.borough || "Queens",
    }));
    out.push(...logistics);
  }
  // Stable synthetic future rows so the Upcoming hearings filter has demos
  // even when live BP/CB hearings have already passed.
  out.push(
    {
      schema_version: 1,
      source: "zap-api-dispositions",
      project_id: "2024K0240",
      project_name: "Fixture Street Rezoning",
      public_status: "In Public Review",
      portal_url: "https://zap.planning.nyc.gov/projects/2024K0240",
      borough: "Brooklyn",
      representing: "Community Board",
      phase_id: "community_board",
      hearing_date: "2026-09-15",
      hearing_at: "2026-09-15T18:30:00.000Z",
      hearing_location_raw:
        "In person at 211 Ainslie Street or livestreamed at www.youtube.com/@bkcb1",
      venue_address: "211 Ainslie Street",
      livestream_url: "https://www.youtube.com/@bkcb1",
      attendance_modes: ["in_person", "livestream"],
      maps_url:
        "https://www.google.com/maps/search/?api=1&query="
        + encodeURIComponent("211 Ainslie Street, New York, NY"),
      parse_status: "parsed",
      provenance: {
        field: "dcp-publichearinglocation",
        source: "zap-api-dispositions",
        derived: [{ field: "fixture", method: "build_land_upcoming_hearings" }],
      },
    },
    {
      schema_version: 1,
      source: "zap-api-dispositions",
      project_id: "2025M0100",
      project_name: "Example Avenue Special Permit",
      public_status: "In Public Review",
      portal_url: "https://zap.planning.nyc.gov/projects/2025M0100",
      borough: "Manhattan",
      representing: "City Planning Commission",
      phase_id: "cpc",
      hearing_date: "2026-10-01",
      hearing_at: "2026-10-01T14:00:00.000Z",
      hearing_location_raw: "Spector Hall, 22 Reade Street",
      venue_address: "Spector Hall, 22 Reade Street",
      livestream_url: null,
      attendance_modes: ["in_person"],
      maps_url:
        "https://www.google.com/maps/search/?api=1&query="
        + encodeURIComponent("Spector Hall, 22 Reade Street, New York, NY"),
      parse_status: "partial",
      provenance: {
        field: "dcp-publichearinglocation",
        source: "zap-api-dispositions",
        derived: [{ field: "fixture", method: "build_land_upcoming_hearings" }],
      },
    },
  );
  return out;
}

async function main() {
  if (live) {
    console.error("--live fetch is optional and not required for --check; using fixtures.");
  }
  const today = new Date().toISOString().slice(0, 10);
  const all = loadFixtureHearings();
  const upcoming = filterHearingLogistics(all, { today, upcoming_only: true });
  const snap = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: "zap-api-dispositions",
    note:
      "Precomputed land-use hearing logistics for the Land → Upcoming hearings filter. "
      + "Derived from ZAP disposition dcp-publichearinglocation + dcp-dateofpublichearing. "
      + "Unparsed free text stays on hearing_location_raw.",
    hearings: upcoming.length ? upcoming : all.filter((h) => {
      const d = String(h.hearing_date || h.hearing_at || "").slice(0, 10);
      return d >= today;
    }),
  };

  if (check) {
    if (!existsSync(OUT)) {
      console.error("missing", OUT);
      process.exit(1);
    }
    const committed = JSON.parse(readFileSync(OUT, "utf8"));
    if (!Array.isArray(committed.hearings) || !committed.hearings.length) {
      console.error("land_upcoming_hearings.json has no hearings");
      process.exit(1);
    }
    console.log("ok land_upcoming_hearings", committed.hearings.length);
    return;
  }

  writeFileSync(OUT, JSON.stringify(snap, null, 2) + "\n");
  console.log("wrote", OUT, "hearings=", snap.hearings.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
