/**
 * A small hand-rolled DOM for browser-binder contract tests, with no jsdom
 * dependency — the same approach `test/contextual_ux_result_groups.test.mjs`
 * takes, widened just enough for a module that creates elements, replaces
 * `innerHTML`, delegates events and moves focus.
 *
 * Deliberate limits, so this helper stays readable rather than becoming a
 * second browser: the parser accepts the well-formed, double-quoted markup
 * this repository's renderers emit and nothing more, and the selector grammar
 * covers a comma-separated list of simple selectors built from a tag name,
 * `.class`, `#id`, `[attr]`, `[attr="value"]` and one `:not(...)` clause.
 *
 * Native modal behaviour — the backdrop, background inertness and the Escape
 * key on an open `<dialog>` — belongs to a real engine and is deliberately not
 * simulated here. `element.showModal` is present so a binder can take the
 * native path, and the headless capture harness proves what the engine does.
 */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = Object.freeze({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" });

function decodeEntities(value) {
  return String(value).replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match]);
}

/* ---------- selectors ---------- */

function parseSimpleSelector(source) {
  const parts = { tag: null, classes: [], id: null, attrs: [], not: null };
  let rest = source.trim();
  const notMatch = rest.match(/:not\(([^)]*)\)/);
  if (notMatch) {
    parts.not = parseSimpleSelector(notMatch[1]);
    rest = rest.replace(notMatch[0], "");
  }
  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    parts.tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }
  const partPattern = /\.([A-Za-z0-9_-]+)|#([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/g;
  let match;
  while ((match = partPattern.exec(rest))) {
    if (match[1]) parts.classes.push(match[1]);
    else if (match[2]) parts.id = match[2];
    else parts.attrs.push({ name: match[3], value: match[4] ?? match[5] ?? null });
  }
  return parts;
}

function matchesSimple(element, parts) {
  if (parts.tag && element.tagName !== parts.tag) return false;
  if (parts.id && element.getAttribute("id") !== parts.id) return false;
  for (const cls of parts.classes) {
    if (!(element.getAttribute("class") || "").split(/\s+/).includes(cls)) return false;
  }
  for (const attr of parts.attrs) {
    if (!element.hasAttribute(attr.name)) return false;
    if (attr.value !== null && element.getAttribute(attr.name) !== attr.value) return false;
  }
  if (parts.not && matchesSimple(element, parts.not)) return false;
  return true;
}

function parseSelectorList(selector) {
  return String(selector).split(",").map((part) => parseSimpleSelector(part));
}

/* ---------- nodes ---------- */

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key;
    this.shiftKey = Boolean(init.shiftKey);
    this.bubbles = init.bubbles !== false;
    this.target = null;
    this.defaultPrevented = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toLowerCase();
    this.ownerDocument = ownerDocument;
    this.nodeType = 1;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.text = "";
    this.listeners = new Map();
    this.focusCount = 0;
    this.showModalCount = 0;
  }

  // `<dialog open>` reflects between attribute and property in a real engine,
  // so a binder that sets either one is observed by a test reading the other.
  get open() { return this.hasAttribute("open"); }
  set open(value) { if (value) this.setAttribute("open", ""); else this.removeAttribute("open"); }

  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument || node.tagName === "html";
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }

  get dataset() {
    const attrs = this.attributes;
    return new Proxy({}, {
      get: (_t, key) => attrs.get(`data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`),
      set: (_t, key, value) => {
        attrs.set(`data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  closest(selector) {
    const list = parseSelectorList(selector);
    for (let current = this; current && current.nodeType === 1; current = current.parentNode) {
      if (list.some((parts) => matchesSimple(current, parts))) return current;
    }
    return null;
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    const list = parseSelectorList(selector);
    return this.descendants().filter((node) => list.some((parts) => matchesSimple(node, parts)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this.text;
  }

  set innerHTML(html) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    parseInto(this, String(html), this.ownerDocument);
  }

  focus() {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  /** Count of registered handlers, so a test can prove a binder is idempotent. */
  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    for (let node = this; node; node = node.parentNode) {
      for (const handler of [...(node.listeners.get(event.type) || [])]) handler(event);
      if (!event.bubbles) break;
    }
    return !event.defaultPrevented;
  }

  showModal() {
    this.showModalCount += 1;
    this.open = true;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new FakeEvent("close", { bubbles: false }));
  }
}

/* ---------- parser ---------- */

function parseInto(parent, html, ownerDocument) {
  const stack = [parent];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>/g;
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    const text = html.slice(cursor, match.index);
    if (text.trim()) stack[stack.length - 1].text += decodeEntities(text);
    cursor = tagPattern.lastIndex;
    const tag = match[1].toLowerCase();
    if (match[0].startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const element = new FakeElement(tag, ownerDocument);
    for (const [, name, value] of match[2].matchAll(/\s+([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
      element.setAttribute(name, value === undefined ? "" : decodeEntities(value));
    }
    stack[stack.length - 1].appendChild(element);
    if (!VOID_TAGS.has(tag) && !match[0].endsWith("/>")) stack.push(element);
  }
  const tail = html.slice(cursor);
  if (tail.trim()) stack[stack.length - 1].text += decodeEntities(tail);
}

/* ---------- document ---------- */

class FakeDocument {
  constructor() {
    this.nodeType = 9;
    // A document node reports itself as connected in a real engine, and code
    // that falls back to a document-wide scope depends on that.
    this.isConnected = true;
    this.listeners = new Map();
    this.documentElement = new FakeElement("html", this);
    this.documentElement.parentNode = this;
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.documentElement.querySelectorAll(`#${id}`)[0] || null;
  }

  querySelector(selector) {
    return this.documentElement.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  contains(node) {
    return this.documentElement.contains(node) || node === this.documentElement;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }
}

/** A document with one mounted container holding the supplied markup. */
export function mountDocument(html, { containerClass = "calendar-host" } = {}) {
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  container.className = containerClass;
  doc.body.appendChild(container);
  container.innerHTML = html;
  return { doc, container };
}

export function click(element) {
  return element.dispatchEvent(new FakeEvent("click"));
}

export function keydown(element, key, init = {}) {
  return element.dispatchEvent(new FakeEvent("keydown", { key, ...init }));
}

/**
 * Elements are circular by construction (a parent holds its children and each
 * child holds its parent), and `dataset` is a Proxy, so letting an assertion
 * library render one produces an unusable — and, at month-grid size, extremely
 * slow — diff. Identity comparisons go through this instead of `assert.equal`.
 */
export function describeNode(node) {
  if (!node) return String(node);
  const id = node.getAttribute?.("id");
  const uid = node.getAttribute?.("data-calendar-event-preview-uid");
  const cls = node.getAttribute?.("class");
  return `<${node.tagName}${id ? ` id=${id}` : ""}${cls ? ` class=${cls}` : ""}${uid ? ` event=${uid}` : ""}>`;
}

export { FakeDocument, FakeElement, FakeEvent };
