// cx-02: the empty My investigation state guides the reader to the first
// find-and-pin step instead of exposing share/freeze/export/print/clear
// controls with nothing yet to act on. Populated collections must keep every
// existing control, note, and privacy behavior unchanged, and deleting the
// last pinned item must restore the same empty guidance.
//
//   node --test test/contextual_ux_empty_investigation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "site", "app", "workspace.mjs"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in workspace.mjs`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Handles both one-line consts (object/string literals) and multi-line ones
// (e.g. invItemHref's ternary chain), by tracking bracket depth to the
// terminating top-level semicolon rather than assuming a single source line.
function extractConst(name) {
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `const ${name} not found in workspace.mjs`);
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);

function fakeLocalStorage(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

// A minimal stand-in for the real entity-pivot link renderer (site/app/entities.mjs) —
// invItemsHtml only needs *a* link back for this test, not its exact production markup.
function pivotAStub(href, text) { return href ? `<a href="${href}">${text}</a>` : String(text); }

function build({ localStorage } = {}) {
  const ls = localStorage || fakeLocalStorage();
  const factory = new Function(
    "t", "localStorage", "pivotA",
    `"use strict";
     const INVESTIGATION_SIGNAL_TYPE = "signal";
     let invSessionRecognized = false;
     ` +
      extractConst("INVKEY") +
      extractConst("PINTYPE_KEY") +
      extractConst("INV_HREF") +
      extractConst("invItemHref") +
      extractFn("invDefaultStore") +
      extractFn("invStore") +
      extractFn("invSave") +
      extractFn("invEmptyGuideHtml") +
      extractFn("invItemsHtml") +
      "return { invDefaultStore, invStore, invSave, invEmptyGuideHtml, invItemsHtml };",
  );
  return factory(t, ls, pivotAStub);
}

const SIX_ACTION_IDS = ["invshare", "invpackage", "invcsv", "invjson", "invprint", "invclear"];

test("empty: the guided empty state names the find -> open -> pin sequence, links to search, and previews later outputs, without any output action", () => {
  const { invEmptyGuideHtml } = build();
  const html = invEmptyGuideHtml();

  assert.match(html, /Find a notice, vendor, agency, or matter/, "explains what to find");
  assert.match(html, /use its Pin button/, "explains how the first record gets pinned");
  assert.match(html, /<a class="act primary" href="\/search\/" id="invfind">/, "a real, natively keyboard-operable link to search");
  assert.match(html, />Find something to pin</);
  assert.doesNotMatch(html, /tabindex="-1"/, "the find link stays in the normal tab order");

  assert.match(html, /share a read-only link/);
  assert.match(html, /freeze a research package/);
  assert.match(html, /export a CSV or JSON file/);
  assert.match(html, /print a dossier/);

  for (const id of SIX_ACTION_IDS) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} must not appear before anything is pinned`);
  }
});

test("one item: the existing item list renders exactly as it did before this change", () => {
  const { invItemsHtml } = build();
  const items = [{ t: "notice", id: "20260625017", title: "Sidewalk repair contract", meta: "DOT", note: "", added: "2026-09-01" }];
  const html = invItemsHtml(items, false);

  assert.match(html, /class="tl"/);
  assert.match(html, /Sidewalk repair contract/);
  assert.match(html, /href="\/notices\/20260625017\/"/);
  assert.match(html, /class="invnote"/, "the note field a populated item gets is untouched");
});

test("last-item removal: splicing the only pinned item out (the .invdel handler's own logic) leaves the stored collection empty again", () => {
  const ls = fakeLocalStorage();
  const { invDefaultStore, invStore, invSave } = build({ localStorage: ls });

  const seeded = invDefaultStore();
  seeded.invs[seeded.current].items.push({ t: "notice", id: "1", title: "One pinned notice", meta: "", note: "", added: "2026-09-01" });
  invSave(seeded);
  const withItem = invStore();
  assert.equal(withItem.invs[withItem.current].items.length, 1);

  withItem.invs[withItem.current].items.splice(0, 1);
  invSave(withItem);

  const afterRemoval = invStore();
  assert.equal(afterRemoval.invs[afterRemoval.current].items.length, 0, "deleting the only pinned item leaves zero items, so the next render re-derives the empty branch");
});

test("stored-collection reload: an already-empty stored collection reloads empty, and a stored item (with its note) reloads populated", () => {
  const emptyLs = fakeLocalStorage({
    crd_invs_v1: JSON.stringify({ current: "inv1", invs: { inv1: { name: "My investigation", created: "2026-09-01", items: [] } } }),
  });
  const { invStore: reloadEmpty } = build({ localStorage: emptyLs });
  const emptyState = reloadEmpty();
  assert.equal(emptyState.invs[emptyState.current].items.length, 0);

  const populatedLs = fakeLocalStorage({
    crd_invs_v1: JSON.stringify({
      current: "inv1",
      invs: { inv1: { name: "My investigation", created: "2026-09-01", items: [{ t: "notice", id: "1", title: "Stored item", meta: "", note: "kept across reload", added: "2026-09-01" }] } },
    }),
  });
  const { invStore: reloadPopulated, invItemsHtml } = build({ localStorage: populatedLs });
  const populatedState = reloadPopulated();
  assert.equal(populatedState.invs[populatedState.current].items.length, 1);
  const html = invItemsHtml(populatedState.invs[populatedState.current].items, false);
  assert.match(html, /Stored item/);
  assert.match(html, /kept across reload/, "the reader's own note survives a reload");
});

test("showInvestigation renders the six output actions only once something is pinned, and uses invEmptyGuideHtml() before that", () => {
  assert.match(src, /const hasItems = inv\.items\.length > 0;/);
  assert.match(src, /\$\{hasItems \? invItemsHtml\(inv\.items,false\) : invEmptyGuideHtml\(\)\}/);

  const actionsBar = src.match(/\$\{hasItems \? `<div class="actions" style="margin-top:16px">([\s\S]*?)<\/div>` : ""\}/);
  assert.ok(actionsBar, "the six-button action row must be conditioned on hasItems");
  for (const id of SIX_ACTION_IDS) {
    assert.match(actionsBar[1], new RegExp(`id="${id}"`));
  }

  assert.match(
    src,
    /if\(hasItems\)\{[\s\S]*?\$\("#invcsv"\)\.addEventListener[\s\S]*?\$\("#invshare"\)\.addEventListener[\s\S]*?\$\("#invpackage"\)\.addEventListener/,
    "the share/package/csv/json/print/clear listeners bind only when the six controls actually exist in the DOM",
  );
});

test("deleting an item re-renders through showInvestigation, which re-derives the empty/populated branch from the current store on every render", () => {
  assert.match(
    src,
    /box\.querySelectorAll\("\.invdel"\)\.forEach\(b=>b\.addEventListener\("click", \(\)=>\{[\s\S]{0,200}showInvestigation\(\);/,
    "removing a pinned item (including the last one) re-runs showInvestigation, which recomputes hasItems",
  );
  assert.match(
    src,
    /\$\("#invclear"\)\.addEventListener\("click", \(\)=>\{[\s\S]{0,120}items=\[\];[\s\S]{0,80}showInvestigation\(\);/,
    "clearing all items also re-runs showInvestigation, restoring the same empty guidance",
  );
});
