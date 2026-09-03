// Behavioural cover for the static-first homepage entry (site/home_entry.mjs).
//
// The root URL defers the full application graph, and with it boot.mjs's language-switcher
// wiring, behind a hash route. home_entry.mjs therefore owns the compact language <select>
// on the neutral home. A module-evaluation error here (2026-09-02: a refactor deleted the
// switcher function but left its call) takes the language pick, the hash-route loader hook,
// and the topic-preview bootstrap down together, so this test loads the real module against
// a minimal DOM and exercises the handlers it registers.

import test from "node:test";
import assert from "node:assert/strict";

function fakeElement(id = "") {
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    options: [],
    dataset: {},
    listeners: new Map(),
    classList: { toggle() {} },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    removeEventListener(type) { this.listeners.delete(type); },
  };
}

const elements = new Map(
  ["langSelect", "homeCta", "home-topic-query", "nlgo", "nlq"].map((id) => [id, fakeElement(id)]),
);
const select = elements.get("langSelect");
select.options = [{ value: "en" }, { value: "es" }, { value: "zh-Hans" }];

const applied = [];
const picked = [];
const windowListeners = new Map();

globalThis.document = {
  body: { dataset: {} },
  getElementById(id) { return elements.get(id) || null; },
  querySelectorAll() { return []; },
  querySelector() { return null; },
};
globalThis.window = {
  LANG: "es",
  addEventListener(type, handler) { windowListeners.set(type, handler); },
  applyStrings() { applied.push(window.LANG); },
  setLang(lang) { picked.push(lang); window.LANG = lang; },
};
globalThis.location = { hash: "" };

await import("../site/home_entry.mjs");

test("the saved language is reflected in the picker and the chrome is repainted on load", () => {
  assert.equal(select.value, "es", "the picker must show the persisted language, not the markup default");
  assert.deepEqual(applied, ["es"], "the static chrome is translated once at entry");
});

test("picking a language on the static home hands the choice to setLang", () => {
  const onChange = select.listeners.get("change");
  assert.equal(typeof onChange, "function", "the entry module never wired the language picker");
  select.value = "zh-Hans";
  onChange({ target: select });
  assert.deepEqual(picked, ["zh-Hans"]);
});

test("the entry module registers the hash-route loader and the topic-preview bootstrap", () => {
  assert.equal(typeof windowListeners.get("hashchange"), "function");
  assert.equal(typeof elements.get("nlgo").listeners.get("click"), "function");
  assert.equal(typeof elements.get("nlq").listeners.get("keydown"), "function");
});
