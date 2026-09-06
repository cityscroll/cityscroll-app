// The Notice route's cold module graph: what it must fetch before the application
// reports itself ready, what it must not fetch at all, and the preload manifest the
// edge-rendered document announces.
//
//   node --test test/notice_cold_path.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootChain,
  measureChain,
  measureHomeColdPath,
  measureLensRouteColdPath,
  measureNoticeColdPath,
  renderManifest,
} from "../tools/notice_cold_path.mjs";
import { NOTICE_MODULE_PRELOADS } from "../site/notice_module_preload.mjs";
import { renderNoticeModulePreloadHTML } from "../site/pages_edge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_SOURCE = readFileSync(join(ROOT, "site/app/main.mjs"), "utf8");
const BUDGET = JSON.parse(readFileSync(join(ROOT, "architecture/notice-cold-path-budget.json"), "utf8"));

// One module per gated lens group, named so a reader can see which lens each entry owns.
const GATED_LENS_MODULES = Object.freeze({
  money: "/app/money-list.mjs",
  land: "/app/land.mjs",
  exams: "/app/exams.mjs",
  staffing: "/app/staffing.mjs",
  meetings: "/app/meetings.mjs",
});

test("the loader registers every gated lens group as a route module", () => {
  for (const name of Object.keys(GATED_LENS_MODULES)) {
    assert.match(
      MAIN_SOURCE,
      new RegExp(`\\n\\s+${name}: \\(\\) => import\\(`),
      `routeModuleLoaders is missing the ${name} lens`,
    );
  }
  assert.deepEqual([...BUDGET.gatedLensModules].sort(), Object.keys(GATED_LENS_MODULES).sort());
});

test("a cold Notice boot loads none of the five gated lens groups", () => {
  const notice = new Set(measureNoticeColdPath().modules);
  for (const [name, modulePath] of Object.entries(GATED_LENS_MODULES)) {
    assert.equal(notice.has(modulePath), false, `${name} lens (${modulePath}) is on the Notice cold path`);
  }
});

test("a route that shows a lens still loads it", () => {
  const lensRoute = new Set(measureLensRouteColdPath().modules);
  for (const [name, modulePath] of Object.entries(GATED_LENS_MODULES)) {
    assert.equal(lensRoute.has(modulePath), true, `${name} lens (${modulePath}) never loads on a lens route`);
  }
});

test("every lens route resolves to its own module through the loader's route gate", () => {
  const gate = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf("function routeModuleForHash"));
  const expected = [
    ['tab==="money"', "money"],
    ['tab==="land"', "land"],
    ['tab==="exams"', "exams"],
    ['tab==="staffing"', "staffing"],
    ['tab==="meetings"', "meetings"],
    ['raw.startsWith("land/")', "land"],
    ['raw.startsWith("exam/")', "exams"],
  ];
  for (const [condition, name] of expected) {
    const line = gate.split("\n").find((text) => text.includes(condition));
    assert.ok(line, `routeModuleForHash never tests ${condition}`);
    assert.match(line, new RegExp(`return "${name}"`), `${condition} does not activate the ${name} lens`);
  }
  // The notice detail keeps the property gate it already had, which chains rules.
  assert.match(gate, /raw\.startsWith\("notice\/"\)[\s\S]*?return "property"/);
});

test("the Notice cold path stays under its committed ceiling", () => {
  const notice = measureNoticeColdPath();
  assert.ok(
    notice.moduleCount <= BUDGET.maxModules,
    `Notice cold path loads ${notice.moduleCount} modules, ceiling is ${BUDGET.maxModules}`,
  );
  assert.ok(
    notice.bytes <= BUDGET.maxBytes,
    `Notice cold path transfers ${notice.bytes} bytes, ceiling is ${BUDGET.maxBytes}`,
  );
  assert.ok(
    notice.serialRequestStages <= BUDGET.maxSerialRequestStages,
    `Notice cold path has ${notice.serialRequestStages} serial request stages, ceiling is ${BUDGET.maxSerialRequestStages}`,
  );
});

test("the Notice cold path is smaller than the same boot with no lens gate", () => {
  const notice = measureNoticeColdPath();
  const ungated = measureChain([
    ...bootChain("notice"),
    ...Object.values(GATED_LENS_MODULES),
  ]);
  assert.ok(notice.moduleCount < ungated.moduleCount);
  assert.ok(notice.bytes < ungated.bytes);
});

test("the Home route keeps its own short entry chain", () => {
  const home = measureHomeColdPath();
  assert.ok(home.moduleCount < 20, `home boot grew to ${home.moduleCount} modules`);
});

test("the preload manifest matches the real import closure", () => {
  const path = join(ROOT, "site/notice_module_preload.mjs");
  assert.ok(existsSync(path), "site/notice_module_preload.mjs is missing");
  assert.equal(
    readFileSync(path, "utf8"),
    renderManifest(measureNoticeColdPath().modules),
    "site/notice_module_preload.mjs is stale — run node tools/notice_cold_path.mjs --write",
  );
});

test("the manifest announces the chain without the entry module the document already requests", () => {
  const notice = measureNoticeColdPath();
  assert.equal(NOTICE_MODULE_PRELOADS.includes("/app/main.mjs"), false);
  assert.equal(NOTICE_MODULE_PRELOADS.length, notice.moduleCount - 1);
  assert.deepEqual(
    [...NOTICE_MODULE_PRELOADS].sort(),
    notice.modules.filter((path) => path !== "/app/main.mjs").sort(),
  );
});

test("the edge-rendered Notice document announces one hint per chain module", () => {
  const html = renderNoticeModulePreloadHTML();
  const hrefs = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((match) => match[1]);
  assert.deepEqual(hrefs, [...NOTICE_MODULE_PRELOADS]);
  assert.equal(hrefs.length, NOTICE_MODULE_PRELOADS.length);
});
