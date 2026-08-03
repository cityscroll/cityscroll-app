#!/usr/bin/env node
// Rebuild the deterministic location-resolution flywheel inventory from the
// two hand-labelled location corpora and the existing geocoded-pin fixture.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { propertyLocationFromRow } from "../site/property_location.mjs";
import { affectedAreaFromRow } from "../worker/src/lib/hearings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "ontology/fixtures/dimensions/location_resolution.json");
const MEASURED_AT = "2026-08-02";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

function measureLens({ lens, label, corpus, extractor }) {
  const fixture = readJson(corpus);
  const expected = fixture.notices.filter((notice) => notice.expected.scope !== "unlocated");
  const locatedIds = [];
  const missedIds = [];
  const falsePositiveIds = [];
  for (const notice of fixture.notices) {
    const actualLocated = extractor(notice.row).scope !== "unlocated";
    const expectedLocated = notice.expected.scope !== "unlocated";
    if (actualLocated && expectedLocated) locatedIds.push(notice.row.request_id);
    else if (!actualLocated && expectedLocated) missedIds.push(notice.row.request_id);
    else if (actualLocated) falsePositiveIds.push(notice.row.request_id);
  }
  return {
    lens,
    label,
    corpus,
    corpus_total: fixture.notices.length,
    expected_located: expected.length,
    located: locatedIds.length,
    located_rate: expected.length ? locatedIds.length / expected.length : null,
    missed_ids: missedIds,
    false_positive_ids: falsePositiveIds,
  };
}

function geocodedPins() {
  const fixture = readJson("test/contract/fixtures/dining_out_nyc.json");
  const seen = new Set();
  const pins = [];
  for (const [id, pin] of Object.entries(fixture.geocodes || {})) {
    const identity = pin.bbl || `${pin.latitude},${pin.longitude}`;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    pins.push({
      id,
      latitude: pin.latitude ?? null,
      longitude: pin.longitude ?? null,
      bbl: pin.bbl || null,
      community_district: pin.community_district || null,
      council_district: pin.council_district || null,
    });
  }
  return pins.sort((a, b) => a.id.localeCompare(b.id));
}

function buildInventory() {
  return {
    schema: "cityscroll.location_resolution_inventory.v0",
    measured_at: MEASURED_AT,
    note: "Located rates are rebuilt from the two pinned hand-labelled corpora. District rates use the existing geocoded civic-scope pins. Missing boundary vintages remain explicit until authoritative boundary sources are contracted.",
    lenses: [
      measureLens({
        lens: "meetings-hearings",
        label: "Meetings and hearings",
        corpus: "test/contract/fixtures/affected_area_golden.json",
        extractor: affectedAreaFromRow,
      }),
      measureLens({
        lens: "property",
        label: "Property",
        corpus: "test/contract/fixtures/property_location_golden.json",
        extractor: propertyLocationFromRow,
      }),
    ],
    geocoded_pins: geocodedPins(),
    boundaries: [
      {
        id: "community-district-boundaries",
        dataset_id: "5crt-au7u",
        vintage_at: null,
        max_stale_days: 730,
        status: "vintage-not-contracted",
      },
      {
        id: "city-council-district-boundaries",
        dataset_id: "872g-cjhh",
        vintage_at: null,
        max_stale_days: 730,
        status: "vintage-not-contracted",
      },
    ],
  };
}

const text = `${JSON.stringify(buildInventory(), null, 2)}\n`;
const inventory = JSON.parse(text);
if (process.argv.includes("--check")) {
  if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== text) {
    process.stderr.write("location-resolution inventory is stale; run node tools/build_location_resolution_inventory.mjs\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("location-resolution inventory: OK\n");
  }
} else if (!process.argv.includes("--gate")) {
  writeFileSync(OUTPUT, text);
  process.stdout.write(`wrote ${OUTPUT}\n`);
}

const gateIndex = process.argv.indexOf("--gate");
if (gateIndex >= 0) {
  const gate = process.argv[gateIndex + 1];
  let pass = false;
  if (gate === "located") {
    pass = inventory.lenses.every((lens) => lens.located_rate === 1);
  } else if (gate === "districts") {
    pass = inventory.geocoded_pins.every((pin) =>
      Number.isFinite(pin.latitude)
      && Number.isFinite(pin.longitude)
      && pin.community_district
      && pin.council_district);
  } else if (gate === "boundary-vintage") {
    const measuredAt = new Date(inventory.measured_at).getTime();
    pass = inventory.boundaries.every((boundary) => {
      const vintageAt = new Date(boundary.vintage_at).getTime();
      return Number.isFinite(vintageAt)
        && measuredAt - vintageAt <= Number(boundary.max_stale_days) * 86400000;
    });
  } else {
    throw new Error(`unknown location-resolution gate: ${gate}`);
  }
  if (!pass) {
    process.stderr.write(`location-resolution gate failed: ${gate}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`location-resolution gate: ${gate} OK\n`);
  }
}
