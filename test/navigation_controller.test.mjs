import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  NAV,
  createNavigator,
  replayNavigationWithUrlWrites,
} from "../site/navigation_controller.mjs";

const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
const staffing = readFileSync(new URL("../site/app/staffing.mjs", import.meta.url), "utf8");
const boot = readFileSync(new URL("../site/app/boot.mjs", import.meta.url), "utf8");

test("of three quick navigations A, B, A only the last is applied", () => {
  const got = replayNavigationWithUrlWrites([
    ["begin", "#a"],
    ["begin", "#b"],
    ["begin", "#a"],
    ["advance", 1],
    ["advance", 2],
    ["advance", 3],
    ["advance", 3],
    ["advance", 3],
    ["advance", 3],
  ]);
  assert.deepEqual(got.log, [
    "1:resolving",
    "1:superseded",
    "2:resolving",
    "2:superseded",
    "3:resolving",
    "3:loading",
    "3:rendering",
    "3:focusing",
    "3:settled",
  ]);
  assert.deepEqual(got.settled, ["3:#a"]);
  assert.deepEqual(got.refused, [3, 4]);
  assert.equal(got.settledRoute, "#a");
});

test("a late step from a superseded navigation is refused and fires no settled listener", () => {
  const nav = createNavigator();
  const settled = [];
  nav.onSettled((route, id) => settled.push(`${id}:${route}`));
  const first = nav.begin("#people");
  nav.begin("#money");
  assert.equal(nav.state(first), NAV.SUPERSEDED);
  assert.equal(nav.advance(first), false);
  assert.deepEqual(settled, []);
});

test("URL write while applying is refused; nested suppressions release in order", () => {
  const midApply = replayNavigationWithUrlWrites([
    ["begin", "#land"],
    ["advance", 1],
    ["advance", 1],
    ["write-url", "#land?x=1"],
    ["advance", 1],
    ["write-url", "#land?x=1"],
    ["advance", 1],
  ]);
  assert.deepEqual(midApply.refused, [3]);
  assert.deepEqual(midApply.urlWrites, ["#land?x=1"]);

  const nested = replayNavigationWithUrlWrites([
    ["suppress-url-writes"],
    ["suppress-url-writes"],
    ["release-url-writes"],
    ["write-url", "#x"],
    ["release-url-writes"],
    ["write-url", "#x"],
  ]);
  assert.deepEqual(nested.refused, [3]);
  assert.deepEqual(nested.urlWrites, ["#x"]);
});

test("releasing a suppression that was never taken is refused", () => {
  const got = replayNavigationWithUrlWrites([["release-url-writes"]]);
  assert.deepEqual(got.refused, [0]);
  assert.deepEqual(got.urlWrites, []);
});

test("navigation still applies while URL writes are suppressed", () => {
  const got = replayNavigationWithUrlWrites([
    ["begin", "#people"],
    ["advance", 1],
    ["advance", 1],
    ["advance", 1],
    ["advance", 1],
    ["suppress-url-writes"],
    ["begin", "#money"],
    ["advance", 2],
    ["advance", 2],
    ["advance", 2],
    ["advance", 2],
    ["write-url", "#people?q=clerk"],
    ["release-url-writes"],
    ["write-url", "#money?agency=DOT"],
  ]);
  assert.deepEqual(got.settled, ["1:#people", "2:#money"]);
  assert.deepEqual(got.refused, [11]);
  assert.deepEqual(got.urlWrites, ["#money?agency=DOT"]);
});

test("Staffing suppresses URL writes across its default example await instead of holding the route lock", () => {
  assert.match(staffing, /suppressUrlWrites/);
  assert.doesNotMatch(staffing, /hashLock\s*=/);
  assert.match(
    staffing,
    /const releaseUrlWrites = globalThis\.routeNavigator\?\.suppressUrlWrites\?\.\(\);\s*try\{\s*await pSearch\(\);\s*\}\s*finally \{\s*releaseUrlWrites\?\.\(\);\s*\}/,
  );
});

test("hashchange begins a navigation and no longer skips applyHash while a lock is held", () => {
  const start = boot.indexOf('window.addEventListener("hashchange"');
  assert.ok(start >= 0);
  const end = boot.indexOf("});", start) + 3;
  const handler = boot.slice(start, end);
  assert.match(handler, /routeNavigator/);
  assert.match(handler, /\.begin\?\.\(targetHash\)|\.begin\(targetHash\)/);
  assert.match(handler, /\.advance\(/);
  assert.doesNotMatch(handler, /hashLock/);
  assert.doesNotMatch(handler, /location\.hash!==targetHash/);
  assert.match(handler, /if\(!applyHash\(\)\)/);
});

test("router owns applying inside applyHash; hashLock is a read-only derived view", () => {
  assert.match(routing, /let applying = false/);
  assert.match(routing, /applying = true/);
  assert.match(routing, /finally \{ applying = false; \}/);
  assert.doesNotMatch(routing, /let hashLock/);
  const hashLockProp = routing.indexOf('Object.defineProperty(globalThis, "hashLock"');
  assert.ok(hashLockProp >= 0);
  const hashLockEnd = routing.indexOf("});", hashLockProp) + 3;
  const hashLockBlock = routing.slice(hashLockProp, hashLockEnd);
  assert.doesNotMatch(hashLockBlock, /\bset\s*:/);
  assert.match(hashLockBlock, /get:\s*\(\)\s*=>/);
  assert.match(routing, /routeUrlWritesBlocked/);
  assert.match(routing, /createNavigator/);
  assert.match(routing, /globalThis\.routeNavigator = routeNavigator/);
});
