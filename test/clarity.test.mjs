import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const claritySource = readFileSync(new URL("../site/clarity.js", import.meta.url), "utf8");

function loadClarity(sandboxExtras = {}) {
  const sandbox = {
    window: undefined,
    globalThis: undefined,
    document: undefined,
    navigator: undefined,
    ...sandboxExtras,
  };
  sandbox.window = sandbox.window || sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(claritySource, sandbox);
  return sandbox.CROLClarity;
}

function fakeDoc(html = "") {
  const store = new Map();
  const elements = [];
  const doc = {
    readyState: "complete",
    head: { appendChild(node) { elements.push(node); return node; } },
    body: null,
    documentElement: null,
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        async: false,
        src: "",
        onerror: null,
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
      };
      return el;
    },
    querySelector(sel) {
      if (sel.startsWith('meta[name="crol-clarity-project-id"]')) {
        const content = store.get("meta:crol-clarity-project-id");
        return content == null ? null : { content };
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "input, textarea, select") return store.get("formFields") || [];
      return [];
    },
    getElementById(id) {
      const map = store.get("byId") || {};
      return map[id] || null;
    },
    _store: store,
    _scripts: elements,
  };
  return doc;
}

function formField() {
  const attrs = {};
  return {
    attrs,
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k]; },
  };
}

test("does not load when project id resolves empty", () => {
  const api = loadClarity();
  assert.equal(api.shouldLoad({ projectId: "", navigator: {} }), false);
  // Empty window override cannot blank a configured constant; use explicit empty projectId path.
  const result = api.shouldLoad({ projectId: "", navigator: {} });
  assert.equal(result, false);
});

test("resolves project id from window, then configured constant, then meta", () => {
  const api = loadClarity();
  assert.equal(
    api.resolveProjectId({ CROL_CLARITY_PROJECT_ID: "  abc123  " }, fakeDoc()),
    "abc123",
  );
  // Live constant is configured — wins over meta when window is unset.
  assert.equal(api.resolveProjectId({}, fakeDoc()), "xusuca7gsv");
  const doc = fakeDoc();
  doc._store.set("meta:crol-clarity-project-id", "meta-id-9");
  assert.equal(api.resolveProjectId({}, doc), "xusuca7gsv");
});

test("skips load when Do Not Track is set", () => {
  const api = loadClarity();
  assert.equal(api.prefersNoTracking({ doNotTrack: "1" }), true);
  assert.equal(api.prefersNoTracking({ doNotTrack: "yes" }), true);
  assert.equal(api.prefersNoTracking({ msDoNotTrack: "1" }), true);
  assert.equal(api.shouldLoad({ projectId: "abc", navigator: { doNotTrack: "1" } }), false);
  const doc = fakeDoc();
  const result = api.boot({
    window: { CROL_CLARITY_PROJECT_ID: "abc" },
    document: doc,
    navigator: { doNotTrack: "1" },
  });
  assert.equal(result.loaded, false);
  assert.equal(result.reason, "opt-out");
  assert.equal(doc._scripts.length, 0);
});

test("skips load when Global Privacy Control is set", () => {
  const api = loadClarity();
  assert.equal(api.prefersNoTracking({ globalPrivacyControl: true }), true);
  assert.equal(
    api.shouldLoad({ projectId: "abc", navigator: { globalPrivacyControl: true } }),
    false,
  );
  const result = api.boot({
    window: { CROL_CLARITY_PROJECT_ID: "abc" },
    document: fakeDoc(),
    navigator: { globalPrivacyControl: true },
  });
  assert.equal(result.loaded, false);
  assert.equal(result.reason, "opt-out");
});

test("loads async Clarity tag when configured and not opted out", () => {
  const api = loadClarity();
  const doc = fakeDoc();
  const email = formField();
  doc._store.set("formFields", [email]);
  doc._store.set("byId", { adest: email });
  const result = api.boot({
    window: { CROL_CLARITY_PROJECT_ID: "projectXYZ" },
    document: doc,
    navigator: { doNotTrack: "0", globalPrivacyControl: false },
  });
  assert.equal(result.loaded, true);
  assert.equal(result.reason, "ok");
  assert.equal(doc._scripts.length, 1);
  assert.equal(doc._scripts[0].async, true);
  assert.equal(doc._scripts[0].src, "https://www.clarity.ms/tag/projectXYZ");
  assert.equal(email.getAttribute("data-clarity-mask"), "true");
});

test("masks all form controls including known email ids", () => {
  const api = loadClarity();
  const doc = fakeDoc();
  const input = formField();
  const textarea = formField();
  const email = formField();
  doc._store.set("formFields", [input, textarea]);
  doc._store.set("byId", { fbemail: email });
  const count = api.applyInputMasking(doc);
  assert.equal(count, 2);
  assert.equal(input.getAttribute("data-clarity-mask"), "true");
  assert.equal(textarea.getAttribute("data-clarity-mask"), "true");
  assert.equal(email.getAttribute("data-clarity-mask"), "true");
});

test("every public page loads the Clarity runtime", () => {
  for (const page of [
    "index.html",
    "about.html",
    "api.html",
    "changelog.html",
    "data.html",
    "standards.html",
    "stats.html",
  ]) {
    const source = readFileSync(new URL(`../site/${page}`, import.meta.url), "utf8");
    assert.match(source, /<script defer src="clarity\.js\?v=1\.0\.0"><\/script>/, page);
  }
});

test("email capture fields ship with data-clarity-mask in markup", () => {
  const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");
  assert.match(index, /id="adest"[^>]*data-clarity-mask="true"/);
  assert.match(index, /id="homeCtaEmail"[^>]*data-clarity-mask="true"/);
  assert.match(about, /id="fbemail"[^>]*data-clarity-mask="true"/);
});

test("privacy copy discloses Clarity, masking, and DNT/GPC in English", () => {
  const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
  const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");
  for (const src of [i18n, about]) {
    assert.match(src, /Microsoft Clarity/);
    assert.match(src, /Do Not Track/);
    assert.match(src, /Global Privacy Control/);
    assert.match(src, /masked/i);
  }
  // Live project id is public (not a secret); activation is intentional.
  const clarity = readFileSync(new URL("../site/clarity.js", import.meta.url), "utf8");
  assert.match(clarity, /const CONFIGURED_PROJECT_ID = "xusuca7gsv";/);
});

test("CONFIGURED_PROJECT_ID is the live Clarity project (heatmaps enabled)", () => {
  const api = loadClarity();
  assert.equal(api.CONFIGURED_PROJECT_ID, "xusuca7gsv");
  const doc = fakeDoc();
  const result = api.boot({ window: {}, document: doc, navigator: {} });
  assert.equal(result.loaded, true);
  assert.equal(result.projectId, "xusuca7gsv");
});
