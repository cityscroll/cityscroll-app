/**
 * Land detail optional NTA / community-district outline layers.
 *
 *   node --test test/land_detail_boundary_layers.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LAND_BOUNDARIES_PARAM,
  LAND_BOUNDARY_LAYER_CD,
  LAND_BOUNDARY_LAYER_NTA,
  LAND_PRESENTATION_STATE_KEYS,
  landDetailBoundariesFromRouteHash,
  normalizeLandDetailBoundaries,
  omitLandPresentationState,
  routeHashWithLandDetailBoundaries,
  stripLandPresentationState,
} from "../site/land_view_state.mjs";
import { scopeFromRouteHash as scopeFromRouteHashV0, watchFromScope as watchFromScopeV0 } from "../site/scope_v0.mjs";
import {
  LAND_DETAIL_BOUNDARY_ARTIFACTS,
  LAND_DETAIL_BOUNDARY_CD_LABEL,
  LAND_DETAIL_BOUNDARY_CONTROLS_ARIA,
  LAND_DETAIL_BOUNDARY_CONTEXT_NOTE,
  LAND_DETAIL_BOUNDARY_FAILURE_COPY,
  LAND_DETAIL_BOUNDARY_LAYERS_SCHEMA,
  LAND_DETAIL_BOUNDARY_LEGEND_COLORS,
  LAND_DETAIL_BOUNDARY_LEGEND_HEADING,
  LAND_DETAIL_BOUNDARY_NTA_LABEL,
  LAND_DETAIL_BOUNDARY_RETRY_LABEL,
  __resetLandDetailBoundaryCachesForTests,
  buildLandDetailBoundaryLayersView,
  contrastRatio,
  landDetailBoundaryPlaceIds,
  loadLandDetailBoundaryLayerDoc,
  loadLandDetailBoundaryMembership,
  mountLandDetailBoundaryLayers,
  relativeLuminance,
  renderLandDetailBoundaryControlsHTML,
  selectBoundaryFeatures,
} from "../site/land_detail_boundary_layers.mjs";
import { landDetailPlaceMembershipForProject } from "../site/land_detail_place_links.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "land-detail-boundary-layers");
const ANCHORS = Object.freeze({
  fdny: "2026R0127",
  westshore: "2025K0305",
  dewitt: "2023M0213",
});

function readJson(relative) {
  return JSON.parse(readFileSync(join(REPO, relative), "utf8"));
}

function sha256Text(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function loadShared() {
  return {
    index: readJson("site/data/land_place_membership.json"),
    nta: readJson("site/data/geography/layers/nta2020/26B.json"),
    cd: readJson("site/data/geography/layers/community_district/2026-05-26.json"),
  };
}

function membershipFor(projectId, shared = loadShared()) {
  return landDetailPlaceMembershipForProject(shared.index, projectId);
}

function pythonPlaywrightChromiumAvailable() {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      "from playwright.sync_api import sync_playwright\n"
      + "with sync_playwright() as p:\n"
      + "    browser = p.chromium.launch(headless=True)\n"
      + "    browser.close()\n",
    ],
    { encoding: "utf8", timeout: 60_000, env: process.env },
  );
  return probe.status === 0;
}

function okJson(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

describe("land_detail_boundary_layers route state", () => {
  it("keeps boundaries in Land presentation keys so watches never absorb outline toggles", () => {
    assert.ok(LAND_PRESENTATION_STATE_KEYS.includes(LAND_BOUNDARIES_PARAM));
    assert.deepEqual(
      normalizeLandDetailBoundaries("cd,nta,unknown"),
      [LAND_BOUNDARY_LAYER_NTA, LAND_BOUNDARY_LAYER_CD],
    );
    assert.equal(
      routeHashWithLandDetailBoundaries("#land/2026R0127", ["nta"]),
      "#land/2026R0127?boundaries=nta",
    );
    assert.equal(
      routeHashWithLandDetailBoundaries("#land/2026R0127?boundaries=nta,cd", []),
      "#land/2026R0127",
    );
    assert.deepEqual(
      landDetailBoundariesFromRouteHash("#land/2026R0127?boundaries=nta,cd"),
      [LAND_BOUNDARY_LAYER_NTA, LAND_BOUNDARY_LAYER_CD],
    );

    const withOutlines = "#land?boro=Queens&stage=public_review&boundaries=nta";
    assert.equal(stripLandPresentationState(withOutlines), "#land?boro=Queens&stage=public_review");
    assert.deepEqual(
      omitLandPresentationState({ stage: "public_review", boundaries: "nta", family: "rezoning" }),
      { stage: "public_review", family: "rezoning" },
    );

    const scope = scopeFromRouteHashV0(withOutlines);
    const watch = watchFromScopeV0(scope, { lens: "land" });
    assert.equal(watch.filter.boundaries, undefined);
    assert.equal("boundaries" in watch.filter, false);
  });
});

describe("A1: FDNY and multi-area outlines from membership ids", () => {
  it("FDNY requests SI0105 and R01 features without inventing membership from geometry", () => {
    const shared = loadShared();
    const membership = membershipFor(ANCHORS.fdny, shared);
    assert.deepEqual(landDetailBoundaryPlaceIds(membership, "nta"), ["SI0105"]);
    assert.deepEqual(landDetailBoundaryPlaceIds(membership, "cd"), ["R01"]);

    const ntaFeatures = selectBoundaryFeatures(shared.nta, ["SI0105"], "nta2020");
    const cdFeatures = selectBoundaryFeatures(shared.cd, ["R01"], "community_district");
    assert.equal(ntaFeatures.length, 1);
    assert.equal(ntaFeatures[0].id, "SI0105");
    assert.match(ntaFeatures[0].properties.label, /Westerleigh-Castleton Corners/);
    assert.equal(cdFeatures.length, 1);
    assert.equal(cdFeatures[0].id, "R01");

    // Positive control: asking for an id that is absent must fail this checker.
    const missing = selectBoundaryFeatures(shared.nta, ["ZZ9999"], "nta2020");
    assert.equal(missing.length, 0);

    const view = buildLandDetailBoundaryLayersView({
      projectId: ANCHORS.fdny,
      membership,
      enabled: ["nta", "cd"],
      layerDocs: { nta: shared.nta, cd: shared.cd },
    });
    assert.equal(view.schema, LAND_DETAIL_BOUNDARY_LAYERS_SCHEMA);
    const ntaLayer = view.layers.find((layer) => layer.token === "nta");
    const cdLayer = view.layers.find((layer) => layer.token === "cd");
    assert.deepEqual(ntaLayer.features.map((feature) => feature.id), ["SI0105"]);
    assert.deepEqual(cdLayer.features.map((feature) => feature.id), ["R01"]);
    assert.equal(ntaLayer.geometry_fidelity, "simplified");
  });

  it("multi-area projects keep every supported place id and never drop project marks from the model", () => {
    const shared = loadShared();
    for (const [projectId, expectedNta, expectedCd] of [
      [ANCHORS.westshore, ["BK1301", "BK1391"], ["K11", "K13"]],
      [ANCHORS.dewitt, ["MN0401", "MN0402"], ["M04"]],
    ]) {
      const membership = membershipFor(projectId, shared);
      assert.deepEqual(landDetailBoundaryPlaceIds(membership, "nta"), expectedNta);
      assert.deepEqual(landDetailBoundaryPlaceIds(membership, "cd"), expectedCd);
      const view = buildLandDetailBoundaryLayersView({
        projectId,
        membership,
        enabled: ["nta", "cd"],
        layerDocs: { nta: shared.nta, cd: shared.cd },
      });
      assert.equal(view.project_id, projectId);
      assert.deepEqual(
        view.layers.find((layer) => layer.token === "nta").features.map((feature) => feature.id),
        expectedNta,
      );
      assert.deepEqual(
        view.layers.find((layer) => layer.token === "cd").features.map((feature) => feature.id),
        expectedCd,
      );
    }
  });
});

describe("A2: toggles do not change query membership; uncovered anchors keep Manhattan outlines", () => {
  it("enabling outlines leaves Land filter identity and result-count inputs untouched", () => {
    const base = "#land?boro=Manhattan&stage=public_review";
    const withNta = routeHashWithLandDetailBoundaries(base, ["nta"]);
    const scopeBefore = scopeFromRouteHashV0(base);
    const scopeAfter = scopeFromRouteHashV0(withNta);
    assert.deepEqual(scopeBefore.place.boroughs, scopeAfter.place.boroughs);
    assert.deepEqual(scopeBefore.facets.values, scopeAfter.facets.values);
    assert.equal(scopeAfter.facets.values.boundaries, undefined);

    // Converse control: a geography key change does alter place membership.
    const changed = scopeFromRouteHashV0("#land?boro=Brooklyn&stage=public_review");
    assert.notDeepEqual(changed.place.boroughs, scopeBefore.place.boroughs);
  });

  it("Dewitt keeps MN0401/MN0402 even though the display anchor BBL is uncovered", () => {
    const shared = loadShared();
    const membership = membershipFor(ANCHORS.dewitt, shared);
    const nta = membership.layers.nta2020;
    assert.equal(nta.uncovered_bbls >= 1, true);
    assert.deepEqual(nta.places, ["MN0401", "MN0402"]);
    const features = selectBoundaryFeatures(shared.nta, nta.places, "nta2020");
    assert.deepEqual(features.map((feature) => feature.id), ["MN0401", "MN0402"]);
    assert.match(features[0].properties.label, /Chelsea-Hudson Yards/);
    assert.match(features[1].properties.label, /Hell'?s Kitchen/);
  });
});

describe("A3: lazy fetch ordering and failed-layer isolation", () => {
  it("opening detail does not fetch boundary assets until a layer is requested; converse control stays quiet", async () => {
    __resetLandDetailBoundaryCachesForTests();
    const shared = loadShared();
    const calls = [];
    const fetchImpl = async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("land_place_membership.json")) return okJson(shared.index);
      if (href.includes("/nta2020/")) return okJson(shared.nta);
      if (href.includes("/community_district/")) return okJson(shared.cd);
      return { ok: false, status: 404, json: async () => null };
    };

    // Intermediate observation: membership may load for control availability, but
    // geometry assets must remain unrequested before any enable.
    await loadLandDetailBoundaryMembership(fetchImpl);
    assert.ok(calls.some((url) => url.includes("land_place_membership.json")));
    assert.equal(calls.some((url) => url.includes("/nta2020/")), false);
    assert.equal(calls.some((url) => url.includes("/community_district/")), false);

    // Converse control: with no enable call, a second membership read still does
    // not pull geometry.
    const before = calls.length;
    await loadLandDetailBoundaryMembership(fetchImpl);
    assert.equal(calls.length, before);

    await loadLandDetailBoundaryLayerDoc("nta", fetchImpl);
    assert.ok(calls.some((url) => url.includes("/nta2020/")));
    assert.equal(calls.some((url) => url.includes("/community_district/")), false);
  });

  it("ORDERING: injects a layer failure between membership and geometry paint, with a healthy converse", async () => {
    __resetLandDetailBoundaryCachesForTests();
    const shared = loadShared();
    const events = [];
    let ntaShouldFail = true;

    const detailRoot = {
      querySelector(selector) {
        if (selector === "#land-detail-boundary-controls-host") return this.host || null;
        if (selector === "#landpan") return this.anchor;
        return null;
      },
      host: null,
      anchor: {
        id: "landpan",
        insertAdjacentHTML: (_where, html) => {
          events.push(`host:${html.includes("land-detail-boundary-controls-host")}`);
          detailRoot.host = {
            innerHTML: "",
            querySelector(sel) {
              if (sel === "[data-land-detail-boundary-controls='1']") {
                if (!this._root) return null;
                return this._root;
              }
              return null;
            },
            set innerHTML(value) {
              this._html = String(value);
              this._root = value
                ? {
                  dataset: {},
                  contains() { return true; },
                  addEventListener(type, handler) {
                    this._handler = handler;
                    events.push(`wired:${type}`);
                  },
                  click(token, { retry = false } = {}) {
                    const target = {
                      closest(sel) {
                        if (retry && sel === "[data-land-boundary-retry]") {
                          return { getAttribute: () => token };
                        }
                        if (!retry && sel === "[data-land-boundary-layer]") {
                          return {
                            disabled: false,
                            getAttribute: (name) => {
                              if (name === "data-land-boundary-layer") return token;
                              if (name === "aria-pressed") return "false";
                              return null;
                            },
                          };
                        }
                        return null;
                      },
                    };
                    this._handler?.({ target });
                  },
                }
                : null;
            },
            get innerHTML() { return this._html || ""; },
          };
        },
      },
    };

    const mapLayers = [];
    const map = {
      removeLayer(layer) { events.push(`remove:${layer.id}`); },
    };
    const leaflet = {
      geoJSON(collection) {
        const layer = {
          id: collection.features.map((feature) => feature.id).join(","),
          addTo() { mapLayers.push(this); events.push(`add:${this.id}`); return this; },
          bringToBack() { events.push(`back:${this.id}`); },
        };
        return layer;
      },
    };

    const locationLike = { hash: `#land/${ANCHORS.fdny}` };
    const historyLike = {
      state: null,
      replaceState(_state, _title, url) {
        events.push(`hash:${url}`);
        locationLike.hash = String(url);
      },
    };

    const fetchImpl = async (url) => {
      const href = String(url);
      events.push(`fetch:${href.includes("membership") ? "membership" : href.includes("nta2020") ? "nta" : href.includes("community_district") ? "cd" : "other"}`);
      if (href.includes("land_place_membership.json")) return okJson(shared.index);
      if (href.includes("/nta2020/")) {
        if (ntaShouldFail) {
          events.push("fail:nta");
          return { ok: false, status: 503, json: async () => null };
        }
        return okJson(shared.nta);
      }
      if (href.includes("/community_district/")) return okJson(shared.cd);
      return { ok: false, status: 404, json: async () => null };
    };

    const controller = await mountLandDetailBoundaryLayers({
      map,
      detailRoot,
      projectId: ANCHORS.fdny,
      fetchImpl,
      leaflet,
      locationLike,
      historyLike,
      documentLike: null,
    });
    assert.ok(controller);
    // Intermediate: membership fetched, geometry not yet.
    assert.ok(events.includes("fetch:membership"));
    assert.equal(events.includes("fetch:nta"), false);

    await controller.enable("nta");
    // Failure injected after membership, before a successful geometry paint.
    assert.ok(events.includes("fetch:nta"));
    assert.ok(events.includes("fail:nta"));
    assert.equal(mapLayers.length, 0);
    assert.deepEqual(controller.getFailures(), ["nta"]);
    assert.match(detailRoot.host.innerHTML, /data-land-boundary-failure="nta"/);
    assert.match(detailRoot.host.innerHTML, new RegExp(LAND_DETAIL_BOUNDARY_FAILURE_COPY));
    assert.match(detailRoot.host.innerHTML, new RegExp(LAND_DETAIL_BOUNDARY_RETRY_LABEL));

    // Converse control: a healthy enable paints geometry and clears failure.
    ntaShouldFail = false;
    __resetLandDetailBoundaryCachesForTests();
    await controller.enable("nta");
    assert.ok(mapLayers.some((layer) => layer.id === "SI0105"));
    assert.deepEqual(controller.getFailures(), []);
    assert.ok(events.includes("back:SI0105"));
  });
});

describe("A4: controls, legend contrast, keyboard affordances, and measured viewports", () => {
  it("renders accessible labels, legend vintage, and WCAG contrast for legend ink", () => {
    const shared = loadShared();
    const view = buildLandDetailBoundaryLayersView({
      projectId: ANCHORS.fdny,
      membership: membershipFor(ANCHORS.fdny, shared),
      enabled: ["nta", "cd"],
      layerDocs: { nta: shared.nta, cd: shared.cd },
    });
    const html = renderLandDetailBoundaryControlsHTML(view);
    assert.match(html, new RegExp(LAND_DETAIL_BOUNDARY_NTA_LABEL));
    assert.match(html, new RegExp(LAND_DETAIL_BOUNDARY_CD_LABEL));
    assert.match(html, new RegExp(LAND_DETAIL_BOUNDARY_CONTROLS_ARIA));
    assert.match(html, new RegExp(LAND_DETAIL_BOUNDARY_LEGEND_HEADING));
    assert.match(html, new RegExp(LAND_DETAIL_BOUNDARY_CONTEXT_NOTE));
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /data-land-boundary-vintage="26B"/);
    assert.match(html, /data-land-boundary-vintage="2026-05-26"/);

    const ratioInk = contrastRatio(
      LAND_DETAIL_BOUNDARY_LEGEND_COLORS.ink,
      LAND_DETAIL_BOUNDARY_LEGEND_COLORS.paper,
    );
    const ratioMeta = contrastRatio(
      LAND_DETAIL_BOUNDARY_LEGEND_COLORS.meta,
      LAND_DETAIL_BOUNDARY_LEGEND_COLORS.paper,
    );
    assert.ok(ratioInk >= 4.5, `legend ink contrast ${ratioInk}`);
    assert.ok(ratioMeta >= 4.5, `legend meta contrast ${ratioMeta}`);

    // Positive control: near-white on paper must fail the same checker.
    const weak = contrastRatio("#f0ebe3", LAND_DETAIL_BOUNDARY_LEGEND_COLORS.paper);
    assert.ok(weak < 4.5, `weak control contrast ${weak}`);
    assert.ok(relativeLuminance(LAND_DETAIL_BOUNDARY_LEGEND_COLORS.paper) > 0.5);
  });

  it("marks artifact inventory and committed layer bytes for both outline tokens", () => {
    assert.equal(
      LAND_DETAIL_BOUNDARY_ARTIFACTS.nta.artifact_url,
      "data/geography/layers/nta2020/26B.json",
    );
    assert.equal(
      LAND_DETAIL_BOUNDARY_ARTIFACTS.cd.artifact_url,
      "data/geography/layers/community_district/2026-05-26.json",
    );
    assert.ok(existsSync(join(REPO, "site", LAND_DETAIL_BOUNDARY_ARTIFACTS.nta.artifact_url)));
    assert.ok(existsSync(join(REPO, "site", LAND_DETAIL_BOUNDARY_ARTIFACTS.cd.artifact_url)));
  });

  it("measures control layout at 390 and 1440 in a real browser when Chromium is available", async (t) => {
    if (!pythonPlaywrightChromiumAvailable()) {
      t.skip("Python playwright Chromium is not launchable in this lane");
      return;
    }

    const shared = loadShared();
    const view = buildLandDetailBoundaryLayersView({
      projectId: ANCHORS.fdny,
      membership: membershipFor(ANCHORS.fdny, shared),
      enabled: ["nta", "cd"],
      layerDocs: { nta: shared.nta, cd: shared.cd },
    });
    const controlsHtml = renderLandDetailBoundaryControlsHTML(view);
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8">
<style>
body{margin:0;background:#f7f4ed;color:#202c32;font:16px/1.4 system-ui}
.land-detail-boundary-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin:16px}
.land-detail-boundary-toggle{min-height:44px;padding:8px 12px;border:1px solid #5a6570;border-radius:8px;background:#fff;color:#202c32;font:600 13px/1.3 system-ui}
.land-detail-boundary-toggle[aria-pressed="true"]{background:#166b70;border-color:#166b70;color:#fff}
.land-detail-boundary-legend{flex:1 1 100%;margin:0;padding:8px 12px;border:1px solid #d6d1c7;border-radius:8px;background:#f7f4ed;color:#202c32}
.land-detail-boundary-legend-heading{margin:0;font:700 12px/1.3 system-ui;letter-spacing:.04em;text-transform:uppercase;color:#202c32}
.land-detail-boundary-note{margin:4px 0 0;font:13px/1.45 system-ui;color:#202c32}
.land-detail-boundary-legend-list{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}
.land-detail-boundary-legend-item{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font:13px/1.4 system-ui;color:#202c32}
.land-detail-boundary-legend-meta{color:#4a5560;font-size:12px}
@media(max-width:420px){
  .land-detail-boundary-controls{flex-direction:column;align-items:stretch}
  .land-detail-boundary-toggle{width:100%}
}
</style></head><body>${controlsHtml}
<script>
document.querySelectorAll('.land-detail-boundary-toggle').forEach((button) => {
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      button.setAttribute('data-activated', '1');
    }
  });
});
</script></body></html>`;

    const htmlPath = join(process.env.FM_TASK_SCRATCH || "/tmp", "land-detail-boundary-layers-measure.html");
    writeFileSync(htmlPath, pageHtml);

    const script = `
from playwright.sync_api import sync_playwright
import json
from pathlib import Path
html = Path(${JSON.stringify(htmlPath)}).read_text(encoding="utf-8")
readings = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, height in ((390, 844), (1440, 900)):
        page = browser.new_page()
        page.set_viewport_size({"width": width, "height": height})
        page.set_content(html, wait_until="domcontentloaded")
        measured = page.evaluate("""() => ({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          toggleCount: document.querySelectorAll('[data-land-boundary-layer]').length,
          labels: [...document.querySelectorAll('[data-land-boundary-layer]')].map((node) => node.textContent.trim()),
          legend: !!document.querySelector('[data-land-detail-boundary-legend]'),
          firstToggle: (() => {
            const node = document.querySelector('[data-land-boundary-layer]');
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return { width: rect.width, height: rect.height, top: rect.top };
          })(),
        })""")
        page.focus('[data-land-boundary-layer="nta"]')
        page.keyboard.press('Enter')
        activated = page.get_attribute('[data-land-boundary-layer="nta"]', 'data-activated')
        readings.append({
          "requested": {"width": width, "height": height},
          "measured": measured,
          "keyboard_activated": activated == "1",
        })
        page.close()
    browser.close()
print(json.dumps(readings))
`;
    const probe = spawnSync("python3", ["-c", script], {
      encoding: "utf8",
      timeout: 90_000,
      env: process.env,
    });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    const readings = JSON.parse(probe.stdout.trim().split("\n").at(-1));
    assert.equal(readings.length, 2);

    for (const reading of readings) {
      assert.equal(reading.measured.innerWidth, reading.requested.width);
      assert.equal(reading.measured.toggleCount, 2);
      assert.deepEqual(reading.measured.labels, [
        LAND_DETAIL_BOUNDARY_NTA_LABEL,
        LAND_DETAIL_BOUNDARY_CD_LABEL,
      ]);
      assert.equal(reading.measured.legend, true);
      assert.equal(reading.keyboard_activated, true);
      assert.ok(reading.measured.firstToggle.height >= 44);
    }
    const mobile = readings.find((row) => row.requested.width === 390);
    const desktop = readings.find((row) => row.requested.width === 1440);
    assert.ok(mobile && desktop);
    // Mobile stacks controls full-width; desktop keeps a compact control.
    assert.ok(mobile.measured.firstToggle.width > desktop.measured.firstToggle.width);

    // Keep committed evidence read-only. Live measurements prove the run; the
    // tracked receipt is asserted, never rewritten, so time-travel suites leave
    // a clean working tree.
    const committedPath = join(EVIDENCE_DIR, "capture-manifest.json");
    assert.ok(existsSync(committedPath), "committed capture-manifest is required");
    const committed = JSON.parse(readFileSync(committedPath, "utf8"));
    assert.equal(committed.schema, "cityscroll.land-detail-boundary-layers-receipt.v1");
    assert.equal(committed.alias, "cb56f9abf36a5");
    assert.match(String(committed.revision || ""), /^[0-9a-f]{40}$/);
    assert.equal(committed.viewports?.length, 2);
    assert.deepEqual(
      committed.viewports.map((row) => row.requested.width).sort((a, b) => a - b),
      [390, 1440],
    );
    for (const row of committed.viewports) {
      assert.equal(row.measured_inner_width, row.requested.width);
      assert.equal(row.keyboard_activated, true);
      assert.deepEqual(row.labels, [
        LAND_DETAIL_BOUNDARY_NTA_LABEL,
        LAND_DETAIL_BOUNDARY_CD_LABEL,
      ]);
    }
    assert.equal(sha256Text(controlsHtml).length, 64);

    if (process.env.CITYSCROLL_WRITE_BOUNDARY_CAPTURE === "1") {
      const scratchRoot = process.env.FM_TASK_SCRATCH || "/tmp";
      const scratchPath = join(scratchRoot, "land-detail-boundary-layers-capture-manifest.json");
      const grounded = spawnSync("git", ["rev-parse", "origin/main"], {
        cwd: REPO,
        encoding: "utf8",
      });
      const revision = grounded.stdout.trim();
      const receipt = {
        schema: "cityscroll.land-detail-boundary-layers-receipt.v1",
        alias: "cb56f9abf36a5",
        revision,
        artifact_vintages: {
          nta2020: shared.nta.vintage?.id || null,
          community_district: shared.cd.vintage?.id || null,
        },
        viewports: readings.map((row) => ({
          requested: row.requested,
          measured_inner_width: row.measured.innerWidth,
          measured_inner_height: row.measured.innerHeight,
          toggle_width: row.measured.firstToggle.width,
          toggle_height: row.measured.firstToggle.height,
          keyboard_activated: row.keyboard_activated,
          labels: row.measured.labels,
        })),
        assertions: [
          "Requested viewport widths 390 and 1440 were applied with page.set_viewport_size and measured via window.innerWidth.",
          "Control labels remain Neighborhood boundaries and Community district boundaries.",
          "Enter activates the focused outline control.",
          "Mobile control width exceeds desktop control width under the stacked layout.",
        ],
        render_hash: sha256Text(controlsHtml),
        captured_at: "2026-09-26T00:00:00.000Z",
      };
      writeFileSync(scratchPath, `${JSON.stringify(receipt, null, 2)}\n`);
    }
  });
});

describe("production path wiring", () => {
  it("detail map runtime mounts boundary layers after project geometry paints", () => {
    const runtime = readFileSync(join(REPO, "site/app/map_runtime.mjs"), "utf8");
    const land = readFileSync(join(REPO, "site/app/land.mjs"), "utf8");
    assert.match(runtime, /attachLandDetailBoundaryLayers/);
    assert.match(runtime, /land_detail_boundary_layers\.mjs/);
    assert.match(runtime, /options\?\.projectId/);
    assert.match(land, /projectId:\s*r\.project_id/);
  });
});
