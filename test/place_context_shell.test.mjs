import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

/*
 * Minimal DOM for place-context banner sync. Selector support matches what
 * site/app/place-context.mjs uses: #id, [data-attr], and tag names.
 */
function elementMatches(el, selector) {
  if (selector.startsWith("#")) return el.id === selector.slice(1);
  if (selector.startsWith("[") && selector.endsWith("]")) {
    const body = selector.slice(1, -1);
    const eq = body.indexOf("=");
    if (eq < 0) return el.attributes.has(body);
    const name = body.slice(0, eq);
    const raw = body.slice(eq + 1).replace(/^["']|["']$/g, "");
    return el.getAttribute(name) === raw;
  }
  return el.tagName === selector.toLowerCase();
}

function collect(el, selector, out) {
  for (const child of el.children) {
    if (elementMatches(child, selector)) out.push(child);
    collect(child, selector, out);
  }
  return out;
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toLowerCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this._text = "";
    this._listeners = new Map();
    this.parentNode = null;
  }

  get id() { return this.attributes.get("id") || ""; }
  set id(value) { this.attributes.set("id", String(value)); }
  get className() { return this.attributes.get("class") || ""; }
  set className(value) { this.attributes.set("class", String(value)); }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value) {
    if (value) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }

  get dataset() {
    const attrs = this.attributes;
    return new Proxy({}, {
      get(_target, key) {
        const attr = `data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
        return attrs.has(attr) ? attrs.get(attr) : undefined;
      },
      set(_target, key, value) {
        const attr = `data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
        attrs.set(attr, String(value));
        return true;
      },
    });
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value ?? "");
  }

  get value() { return this.attributes.get("value") || ""; }
  set value(next) { this.attributes.set("value", String(next ?? "")); }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  querySelector(selector) { return collect(this, selector, [])[0] || null; }
  querySelectorAll(selector) { return collect(this, selector, []); }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  after(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    node.parentNode = parent;
    parent.children.splice(index + 1, 0, node);
  }
}

function createDocument() {
  const doc = {
    body: null,
    createElement(tag) { return new FakeElement(tag, doc); },
    querySelector(selector) { return doc.body?.querySelector(selector) || null; },
    querySelectorAll(selector) { return doc.body?.querySelectorAll(selector) || []; },
  };
  doc.body = new FakeElement("body", doc);
  const langNotice = new FakeElement("div", doc);
  langNotice.id = "langNotice";
  doc.body.append(langNotice);
  // Pre-seed the banner so ensureBanner does not need innerHTML parsing.
  const banner = new FakeElement("div", doc);
  banner.id = "place-context";
  banner.className = "session-banner";
  const label = new FakeElement("span", doc);
  label.setAttribute("data-place-context-label", "");
  const change = new FakeElement("button", doc);
  change.setAttribute("data-place-context-change", "");
  const select = new FakeElement("select", doc);
  select.setAttribute("data-place-context-borough", "");
  select.hidden = true;
  const clear = new FakeElement("button", doc);
  clear.setAttribute("data-place-context-clear", "");
  banner.append(label, change, select, clear);
  doc.body.append(banner);
  return doc;
}

test("place-context banner sync does not throw when i18n t() is absent", async () => {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    window: globalThis.window,
    t: globalThis.t,
    applyStrings: globalThis.applyStrings,
    addEventListener: globalThis.addEventListener,
  };
  const doc = createDocument();
  globalThis.document = doc;
  globalThis.location = {
    pathname: "/browse/property/",
    search: "?boro=Brooklyn&view=archive",
    hash: "",
    href: "https://cityscroll.org/browse/property/?boro=Brooklyn&view=archive",
    origin: "https://cityscroll.org",
  };
  globalThis.window = globalThis;
  globalThis.window.LANG = "en";
  delete globalThis.t;
  globalThis.applyStrings = () => {};
  globalThis.addEventListener = () => {};

  try {
    const moduleUrl = pathToFileURL(new URL("../site/app/place-context.mjs", import.meta.url).pathname).href
      + `?shell=${Date.now()}`;
    const { sync } = await import(moduleUrl);
    assert.equal(typeof globalThis.t, "undefined");
    assert.doesNotThrow(() => sync());
    const banner = doc.querySelector("#place-context");
    assert.ok(banner, "place-context banner mounts without i18n");
    const label = banner.querySelector("[data-place-context-label]");
    assert.match(label.textContent, /^Context: Brooklyn$/);
  } finally {
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.location === undefined) delete globalThis.location;
    else globalThis.location = previous.location;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    if (previous.t === undefined) delete globalThis.t;
    else globalThis.t = previous.t;
    if (previous.applyStrings === undefined) delete globalThis.applyStrings;
    else globalThis.applyStrings = previous.applyStrings;
    if (previous.addEventListener === undefined) delete globalThis.addEventListener;
    else globalThis.addEventListener = previous.addEventListener;
  }
});
