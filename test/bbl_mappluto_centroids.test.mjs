import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BBL_MAPPLUTO_CENTROID_CANARIES,
  BBL_MAPPLUTO_CENTROIDS_ARTIFACT,
  BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE,
  assertBblMapplutoCentroidsServeGate,
  bblMapplutoCentroidsServeGateFindings,
  buildBblMapplutoCentroidsDoc,
  collectSellFacingBbls,
  lookupBblCentroid,
  normalizeBbl,
  sellFacingProjectIds,
} from "../site/bbl_mappluto_centroids.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const landSrc = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start === -1) {
    start = source.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`function ${name} not found`);
  }
  let cursor = source.indexOf("(", start);
  if (cursor === -1) throw new Error(`could not parse ${name}`);
  let parenDepth = 0;
  let mode = "code";
  let quote = "";
  let escaped = false;
  let templateExprDepth = 0;
  for (; cursor < source.length; cursor += 1) {
    const ch = source[cursor];
    const prev = source[cursor - 1];
    if (mode === "lineComment") {
      if (ch === "\n") mode = "code";
      continue;
    }
    if (mode === "blockComment") {
      if (prev === "*" && ch === "/") mode = "code";
      continue;
    }
    if (mode === "string") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) mode = "code";
      continue;
    }
    if (mode === "template") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "`" && templateExprDepth === 0) mode = "code";
      else if (ch === "{" && prev === "$") templateExprDepth += 1;
      else if (ch === "}" && templateExprDepth > 0) templateExprDepth -= 1;
      continue;
    }
    if (ch === "/" && source[cursor + 1] === "/") {
      mode = "lineComment";
      cursor += 1;
      continue;
    }
    if (ch === "/" && source[cursor + 1] === "*") {
      mode = "blockComment";
      cursor += 1;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      mode = ch === "`" ? "template" : "string";
      quote = ch;
      continue;
    }
    if (ch === "(") parenDepth += 1;
    if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  let i = source.indexOf("{", cursor);
  if (i === -1) throw new Error(`could not parse ${name}`);
  let depth = 0;
  mode = "code";
  quote = "";
  escaped = false;
  templateExprDepth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];
    if (mode === "lineComment") {
      if (ch === "\n") mode = "code";
      continue;
    }
    if (mode === "blockComment") {
      if (prev === "*" && ch === "/") mode = "code";
      continue;
    }
    if (mode === "string") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        mode = "code";
        quote = "";
      }
      if (ch === "\n" && quote !== "`") {
        mode = "code";
        quote = "";
      }
      continue;
    }
    if (mode === "template") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "`" && templateExprDepth === 0) mode = "code";
      else if (ch === "{" && prev === "$") templateExprDepth += 1;
      else if (ch === "}" && templateExprDepth > 0) templateExprDepth -= 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      mode = "lineComment";
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      mode = "blockComment";
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      mode = ch === "`" ? "template" : "string";
      quote = ch;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not extract ${name}`);
}

const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const {
  normalizeLandBbl,
  collectProjectBbls,
  resolveLandMapLocation,
} = new Function(
  "cleanText",
  "lookupBblCentroid",
  [
    extractFunction(landSrc, "toFiniteCoordinates"),
    extractFunction(landSrc, "toFinitePoint"),
    extractFunction(landSrc, "normalizeLandBbl"),
    extractFunction(landSrc, "collectProjectBbls"),
    extractFunction(landSrc, "collectAddressCandidates"),
    extractFunction(landSrc, "resolveLandMapLocation"),
    "return {normalizeLandBbl, collectProjectBbls, resolveLandMapLocation};",
  ].join("\n"),
)(cleanText, lookupBblCentroid);

test("normalizeBbl pads and strips non-digits", () => {
  assert.equal(normalizeBbl("3012660036"), "3012660036");
  assert.equal(normalizeBbl("3-01266-0036"), "3012660036");
  assert.equal(normalizeBbl(3012660036), "3012660036");
});

const FIXTURE_NOW = "2026-08-18T12:00:00.000Z";

test("serve gate fails closed on empty / low coverage / missing canary", () => {
  const empty = buildBblMapplutoCentroidsDoc({
    mode: "mappluto_pluto_csv",
    byBbl: {},
    sellFacingBbls: ["1010000001", "1010000002"],
    materializedAt: FIXTURE_NOW,
  });
  const findings = bblMapplutoCentroidsServeGateFindings(empty, { now: FIXTURE_NOW });
  assert.ok(findings.some((line) => /empty|below floor|canary/i.test(line)));
  assert.throws(() => assertBblMapplutoCentroidsServeGate(empty, { now: FIXTURE_NOW }));
});

test("serve gate accepts retained MapPLUTO extract with canary + coverage", () => {
  const sellFacing = ["3012660036", "1017670001", "1017670002"];
  const doc = buildBblMapplutoCentroidsDoc({
    mode: "mappluto_pluto_csv",
    byBbl: {
      "3012660036": { lat: 40.6696224, lon: -73.9557834 },
      "5017800015": { lat: 40.6083294, lon: -74.1876383 },
      "1017670001": { lat: 40.8, lon: -73.95 },
      "1017670002": { lat: 40.801, lon: -73.951 },
    },
    sellFacingBbls: sellFacing,
    materializedAt: FIXTURE_NOW,
  });
  assert.equal(doc.coverage.rate, 1);
  assert.equal(doc.coverage.canaries["3012660036"].status, "matched");
  assert.equal(doc.coverage.canaries["5017800015"].status, "matched");
  assertBblMapplutoCentroidsServeGate(doc, { now: FIXTURE_NOW });
  assert.deepEqual(lookupBblCentroid(doc, ["3012660036"]), {
    bbl: "3012660036",
    lat: 40.6696224,
    lon: -73.9557834,
  });
});

test("collectSellFacingBbls unions zap_bbl rows with canary BBLs", () => {
  const collected = collectSellFacingBbls(
    {
      rows: [
        { project_id: "2022M0258", bbls: ["1017670001"] },
        { project_id: "other", bbls: ["9999999999"] },
      ],
    },
    new Set(["2022M0258"]),
  );
  assert.ok(collected.bbls.includes("1017670001"));
  assert.ok(collected.bbls.includes("3012660036"));
  assert.equal(collected.by_project["2022M0258"][0], "1017670001");
  assert.ok(!collected.bbls.includes("9999999999"));
});

test("2026K0123 map status resolves exact from committed BBL MapPLUTO centroid (no live ArcGIS)", async () => {
  const canaryBbl = "3012660036";
  assert.equal(BBL_MAPPLUTO_CENTROID_CANARIES[canaryBbl], "2026K0123");
  const record = {
    project_id: "2026K0123",
    project_name: "1550 Bedford Avenue Rezoning",
    borough: "Brooklyn",
  };
  const outcome = {
    open_data: { borough: "Brooklyn", community_district: "K09" },
    dob: { filings: [{ bbl: canaryBbl, house_no: "1550", street_name: "BEDFORD AVENUE" }] },
  };
  assert.deepEqual(collectProjectBbls(record, outcome), [canaryBbl]);

  const centroidLookup = buildBblMapplutoCentroidsDoc({
    mode: "mappluto_pluto_csv",
    byBbl: { [canaryBbl]: { lat: 40.6696224, lon: -73.9557834 } },
    sellFacingBbls: [canaryBbl],
    materializedAt: FIXTURE_NOW,
  });

  let geocodeCalls = 0;
  const result = await resolveLandMapLocation(record, outcome, {
    centroidLookup,
    geocode: async () => {
      geocodeCalls += 1;
      return { status: "matched", lat: 40.7, lon: -73.95, label: "borough-center-leak" };
    },
  });

  assert.equal(result.status, "exact");
  assert.equal(result.precision, "exact");
  assert.equal(result.lat, 40.6696224);
  assert.equal(result.lon, -73.9557834);
  assert.equal(result.method, "bbl_mappluto_centroid");
  assert.equal(result.bbl, canaryBbl);
  assert.equal(geocodeCalls, 0);
  assert.ok(!/services5\.arcgis\.com/i.test(landSrc));
});

test("committed centroid lookup covers >=95% of sell-facing BBLs and keeps canary", () => {
  const artifactPath = join(ROOT, BBL_MAPPLUTO_CENTROIDS_ARTIFACT);
  assert.ok(
    existsSync(artifactPath),
    `${BBL_MAPPLUTO_CENTROIDS_ARTIFACT} missing — run node tools/build_bbl_mappluto_centroids.mjs`,
  );
  const doc = JSON.parse(readFileSync(artifactPath, "utf8"));
  assertBblMapplutoCentroidsServeGate(doc);
  assert.ok(doc.coverage.rate >= BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE);

  const projects = JSON.parse(
    readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"),
  );
  const bbls = JSON.parse(
    readFileSync(join(ROOT, "site/data/zap_bbl_warehouse_lookup.json"), "utf8"),
  );
  const sellFacing = collectSellFacingBbls(bbls, sellFacingProjectIds(projects));
  let matched = 0;
  for (const bbl of sellFacing.bbls) {
    if (doc.by_bbl?.[bbl]) matched += 1;
  }
  // Denominator in the artifact is sell-facing zap_bbl BBLs (canaries may be extra).
  const sellFacingOnly = sellFacing.bbls.filter(
    (bbl) => !Object.prototype.hasOwnProperty.call(BBL_MAPPLUTO_CENTROID_CANARIES, bbl)
      || (bbls.rows || []).some(
        (row) => Array.isArray(row.bbls) && row.bbls.map(String).includes(bbl),
      ),
  );
  const universe = sellFacingOnly.length ? sellFacingOnly : sellFacing.bbls;
  matched = universe.filter((bbl) => doc.by_bbl?.[bbl]).length;
  const rate = universe.length ? matched / universe.length : 0;
  assert.ok(
    rate >= BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE,
    `sell-facing BBL centroid coverage ${rate} below ${BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE}`,
  );
  assert.ok(doc.by_bbl["3012660036"]);
  assert.equal(doc.coverage.canaries["3012660036"].status, "matched");
  assert.ok(doc.by_bbl["5017800015"], "2025R0257 MapPLUTO canary 5017800015 must stay in the centroid table");
  assert.equal(doc.coverage.canaries["5017800015"].status, "matched");
});
