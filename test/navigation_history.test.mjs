import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

function extractFn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const navigation = new Function(
  `${extractFn("safeHistoryHash")};
   ${extractFn("normalizeHistoryPoint")};
   ${extractFn("itemRouteFallbackHash")};
   ${extractFn("routeHistoryEntry")};
   ${extractFn("routeReturnContext")};
   ${extractFn("routeHistoryState")};
   return { itemRouteFallbackHash, routeHistoryEntry, routeReturnContext, routeHistoryState, normalizeHistoryPoint };`,
)();

test("item routes declare deterministic collection fallbacks for cold deep links", () => {
  assert.deepEqual(
    [
      "#notice/20260706036",
      "#exam/7016",
      "#land/2026X0362",
      "#vendor/Example%20LLC",
      "#agency/Consumer%20and%20Worker%20Protection",
      "#matter/84124P0003001",
      "#investigation",
      "#investigation/shared/abc123",
      "#task/can-i-bid",
      "#task/can-i-bid/20260624023",
      "#task/what-will-change",
      "#task/what-will-change/2026X0362",
    ].map(navigation.itemRouteFallbackHash),
    [
      "#money",
      "#people?view=guide",
      "#land",
      "#money",
      "#money",
      "#money",
      "#money",
      "#investigation",
      "#money",
      "#task/can-i-bid",
      "#land",
      "#task/what-will-change",
    ],
  );

  for (const hash of ["#rules", "#money?mode=award", "https://example.com/"]) {
    assert.equal(navigation.itemRouteFallbackHash(hash), null, hash);
  }
});

test("history state accepts only bounded same-document hashes and scroll points", () => {
  const state = {
    cityscrollRoute: {
      entry: { hash: "#rules?q=sidewalk", x: 4.4, y: 912.7 },
      back: { hash: "#money?mode=award", x: -10, y: 240 },
    },
  };
  assert.deepEqual(navigation.routeHistoryEntry(state), {
    hash: "#rules?q=sidewalk",
    x: 4,
    y: 913,
  });
  assert.deepEqual(navigation.routeReturnContext(state), {
    hash: "#money?mode=award",
    x: 0,
    y: 240,
  });

  assert.equal(navigation.routeHistoryEntry({ cityscrollRoute: { entry: { hash: "javascript:alert(1)", y: 10 } } }), null);
  assert.equal(navigation.routeReturnContext({ cityscrollRoute: { back: { hash: "#rules\nmalformed", y: 10 } } }), null);
  assert.equal(navigation.routeReturnContext(null), null);
});

test("routeHistoryState preserves referrer context and can clear back on tab push", () => {
  // Simulate a prior item-route history entry that still has a back target.
  const fakeHistory = {
    state: {
      cityscrollRoute: {
        entry: { hash: "#notice/1", x: 0, y: 12 },
        back: { hash: "#agency/Parks", x: 0, y: 400 },
      },
      other: true,
    },
  };
  const prevHistory = globalThis.history;
  globalThis.history = fakeHistory;
  try {
    const preserved = navigation.routeHistoryState({
      entry: { hash: "#money?q=bridge", x: 0, y: 80 },
    });
    assert.equal(preserved.other, true);
    assert.deepEqual(preserved.cityscrollRoute.back, { hash: "#agency/Parks", x: 0, y: 400 });
    assert.deepEqual(preserved.cityscrollRoute.entry, { hash: "#money?q=bridge", x: 0, y: 80 });

    const cleared = navigation.routeHistoryState({
      entry: { hash: "#rules", x: 0, y: 0 },
      back: null,
    });
    assert.equal(cleared.cityscrollRoute.back, undefined);
    assert.equal(cleared.cityscrollRoute.entry.hash, "#rules");
  } finally {
    globalThis.history = prevHistory;
  }
});

test("global route chrome records item-link context and restores history scroll", () => {
  assert.match(source, /data-route-back/);
  assert.match(source, /function rememberItemRouteContext\(/);
  assert.match(source, /function commitPendingItemRouteContext\(/);
  assert.match(source, /function applyActiveHistoryRouteScroll\(/);
  assert.match(source, /function routeBackLabel\(/);
  assert.match(source, /isRestoringHistoryRouteScroll\(\)/);
  assert.match(source, /window\.addEventListener\("popstate"/);
  assert.match(source, /restoreHistoryRouteScroll\(\)/);
  // Filter rewrites must not wipe history.state with replaceState(null, …).
  const updateHash = extractFn("updateHash");
  assert.match(updateHash, /routeHistoryState\(\{entry\}\)/);
  assert.doesNotMatch(updateHash, /history\.replaceState\(null/);
  const pushHash = extractFn("pushHash");
  assert.match(pushHash, /routeHistoryState\(\{entry,\s*back:null\}\)/);
  assert.doesNotMatch(pushHash, /history\.pushState\(null/);
});
