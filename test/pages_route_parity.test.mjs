import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ROUTE_INVENTORY,
  compareInventories,
  formatParityReport,
  joinOrigin,
  targetsForOrigin,
} from "../tools/pages_route_parity.mjs";
import { CONTENT_MARKER, targetsFromCli } from "../tools/live_url_smoke.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("route inventory covers every sitemap page plus robots and sitemap", () => {
  const sitemap = read("sitemap.xml");
  const paths = [...sitemap.matchAll(/https:\/\/cityscroll\.org([^<]*)/g)].map((m) => {
    const raw = m[1] || "/";
    return raw === "" ? "/" : raw;
  });
  assert.ok(paths.includes("/"));
  for (const path of paths) {
    assert.ok(
      ROUTE_INVENTORY.some((route) => route.path === path),
      `missing inventory entry for sitemap path ${path}`,
    );
  }
  assert.ok(ROUTE_INVENTORY.some((r) => r.path === "/robots.txt"));
  assert.ok(ROUTE_INVENTORY.some((r) => r.path === "/sitemap.xml"));
});

test("targetsForOrigin joins without double slashes", () => {
  const targets = targetsForOrigin("https://cityscroll.pages.dev/");
  assert.equal(targets[0].url, "https://cityscroll.pages.dev/");
  assert.equal(
    targets.find((t) => t.id === "about").url,
    "https://cityscroll.pages.dev/about.html",
  );
  assert.equal(joinOrigin("https://example.com", "/x"), "https://example.com/x");
});

test("compareInventories passes when statuses and markers match", () => {
  const referenceRows = ROUTE_INVENTORY.map((route) => ({
    path: route.path,
    id: route.id,
    kind: route.kind,
    finalStatus: 200,
    ok: true,
    reason: null,
    statusChain: [{ status: 200 }],
  }));
  const candidateRows = referenceRows.map((row) => ({ ...row }));
  const comparison = compareInventories(referenceRows, candidateRows);
  assert.equal(comparison.ok, true);
  assert.equal(comparison.failures.length, 0);
});

test("compareInventories fails on status or marker mismatch", () => {
  const referenceRows = [
    {
      path: "/",
      id: "home",
      kind: "html",
      finalStatus: 200,
      ok: true,
      reason: null,
      statusChain: [{ status: 200 }],
    },
  ];
  const statusMismatch = compareInventories(referenceRows, [
    { ...referenceRows[0], finalStatus: 404, ok: false, reason: "final status 404" },
  ]);
  assert.equal(statusMismatch.ok, false);
  assert.match(statusMismatch.failures.join("\n"), /status 200 vs 404/);

  const markerMismatch = compareInventories(referenceRows, [
    { ...referenceRows[0], ok: false, reason: "body missing content marker" },
  ]);
  assert.equal(markerMismatch.ok, false);
  assert.match(markerMismatch.failures.join("\n"), /content failure/);
});

test("formatParityReport records both origins and PASS/FAIL", () => {
  const referenceRows = [
    {
      path: "/",
      id: "home",
      kind: "html",
      finalStatus: 200,
      ok: true,
      reason: null,
      statusChain: [{ status: 200 }],
    },
  ];
  const candidateRows = [{ ...referenceRows[0] }];
  const comparison = compareInventories(referenceRows, candidateRows);
  const report = formatParityReport({
    referenceOrigin: "https://cityscroll.org",
    candidateOrigin: "https://cityscroll.pages.dev",
    comparedAt: "2026-07-30T00:00:00.000Z",
    comparison,
    referenceRows,
    candidateRows,
  });
  assert.match(report, /PASS/);
  assert.match(report, /cityscroll\.org/);
  assert.match(report, /cityscroll\.pages\.dev/);
  assert.match(report, /DNS is unchanged/);
});

test("live_url_smoke CLI can target a single parallel host", () => {
  const fromBase = targetsFromCli({ baseUrl: "https://cityscroll.pages.dev" });
  assert.deepEqual(
    fromBase.map((t) => t.url),
    ["https://cityscroll.pages.dev/", "https://cityscroll.pages.dev/about.html"],
  );
  const fromUrls = targetsFromCli({
    urls: ["https://cityscroll.pages.dev/data.html"],
  });
  assert.equal(fromUrls[0].url, "https://cityscroll.pages.dev/data.html");
  assert.equal(fromUrls[0].marker, CONTENT_MARKER);
});
