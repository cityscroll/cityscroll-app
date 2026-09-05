import assert from "node:assert/strict";
import test from "node:test";

import {
  activateFamilyNavHeading,
  familyNavItemFromLane,
  familyNavItemsFromLanes,
  laneDescriptorFromSection,
  laneStateFromBodyClassName,
  renderFamilyNav,
  visibleLaneSections,
} from "../site/search_family_nav.mjs";

/*
 * A minimal, hand-rolled DOM standing in for the browser: just enough
 * querySelector/attribute/dataset/event-listener behavior for the module
 * under test, with no jsdom dependency. Selector grammar is intentionally
 * limited to what site/search_document.mjs actually uses: a bare tag name,
 * a single ".class", or a single "[data-attr]" presence check.
 */
function elementMatches(el, selector) {
  if (selector.startsWith(".")) {
    const cls = selector.slice(1);
    return (el.className || "").split(/\s+/).includes(cls);
  }
  if (selector.startsWith("[") && selector.endsWith("]")) {
    return el.attributes.has(selector.slice(1, -1));
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
    this.tagName = tagName.toLowerCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this._text = "";
    this._listeners = new Map();
    this.focusCalled = false;
    this.scrolledInto = null;
  }

  get id() { return this.attributes.get("id") || ""; }
  set id(value) { this.attributes.set("id", value); }
  get className() { return this.attributes.get("class") || ""; }
  set className(value) { this.attributes.set("class", value); }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value) { if (value) this.attributes.set("hidden", ""); else this.attributes.delete("hidden"); }

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
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value ?? "");
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  querySelector(selector) { return collect(this, selector, [])[0] || null; }
  querySelectorAll(selector) { return collect(this, selector, []); }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  click() {
    const handlers = this._listeners.get("click") || [];
    const event = { type: "click", target: this, preventDefault() {} };
    for (const handler of handlers) handler(event);
  }

  focus() { this.focusCalled = true; }
  scrollIntoView(opts) { this.scrolledInto = opts || true; }
}

function createDocument() {
  const doc = { createElement: (tag) => new FakeElement(tag, doc) };
  return doc;
}

function buildRoot(doc, { semanticLanes, keywordLanes, semanticHidden = false, keywordHidden = true } = {}) {
  const root = doc.createElement("div");

  const nav = doc.createElement("nav");
  nav.setAttribute("data-search-family-nav", "");
  nav.hidden = true;
  const list = doc.createElement("ul");
  list.setAttribute("data-search-family-nav-list", "");
  nav.append(list);
  root.append(nav);

  function buildLaneGroup(kind, lanes, groupHidden) {
    const group = doc.createElement("div");
    group.setAttribute(kind === "semantic" ? "data-semantic-lanes" : "data-keyword-lanes", "");
    group.hidden = groupHidden;
    for (const lane of lanes || []) {
      const section = doc.createElement("section");
      section.className = "topic-search-lane";
      section.setAttribute(kind === "semantic" ? "data-semantic-family" : "data-search-lane", lane.id);
      section.hidden = Boolean(lane.hidden);

      const heading = doc.createElement("h3");
      heading.id = lane.headingId;
      heading.textContent = lane.label;

      const status = doc.createElement("span");
      status.className = "topic-search-lane-status";
      status.textContent = lane.statusText;

      const body = doc.createElement("div");
      body.className = lane.bodyClassName || "topic-search-lane-body";

      section.append(heading, status, body);
      group.append(section);
    }
    return group;
  }

  root.append(buildLaneGroup("semantic", semanticLanes, semanticHidden));
  root.append(buildLaneGroup("keyword", keywordLanes, keywordHidden));
  return { root, nav, list };
}

const SIX_FAMILIES = [
  { id: "contracts", label: "Contracts" },
  { id: "people-organizations", label: "People + organizations" },
  { id: "land", label: "Land" },
  { id: "rules", label: "Rules" },
  { id: "meetings", label: "Meetings" },
  { id: "exams", label: "Exams" },
];

function semanticFixture(overrides = {}) {
  return SIX_FAMILIES.map((family) => ({
    ...family,
    headingId: `search-semantic-lane-${family.id}`,
    statusText: "1 result",
    bodyClassName: "topic-search-lane-body",
    ...overrides[family.id],
  }));
}

/* ---- pure item construction ---- */

test("familyNavItemFromLane sanitizes and requires an id, a focus target, and a label", () => {
  assert.deepEqual(
    familyNavItemFromLane({ id: "contracts", headingId: "search-semantic-lane-contracts", label: "Contracts", statusText: "3 results" }),
    { id: "contracts", headingId: "search-semantic-lane-contracts", label: "Contracts", statusText: "3 results", state: "" },
  );
  assert.equal(familyNavItemFromLane({ id: "", headingId: "x", label: "x" }), null, "missing id is dropped, not rendered blank");
  assert.equal(familyNavItemFromLane({ id: "x", headingId: "", label: "x" }), null, "missing heading target is dropped");
  assert.equal(familyNavItemFromLane({ id: "x", headingId: "x", label: "" }), null, "missing label is dropped");
  assert.equal(familyNavItemFromLane(null), null);
  const overlong = familyNavItemFromLane({ id: "x".repeat(400), headingId: "y".repeat(400), label: "z".repeat(400), statusText: "w".repeat(400) });
  assert.ok(overlong.id.length <= 80 && overlong.headingId.length <= 80 && overlong.label.length <= 80 && overlong.statusText.length <= 80);
  assert.equal(familyNavItemFromLane({ id: "x", headingId: "y", label: "z", state: "made-up" }).state, "", "an unrecognized state is not invented as a label");
});

test("familyNavItemsFromLanes drops invalid entries without dropping the valid ones around them", () => {
  const items = familyNavItemsFromLanes([
    { id: "contracts", headingId: "h1", label: "Contracts", statusText: "3 results" },
    null,
    { id: "", headingId: "h2", label: "broken" },
    { id: "meetings", headingId: "h3", label: "Meetings", statusText: "No matches" },
  ]);
  assert.deepEqual(items.map((item) => item.id), ["contracts", "meetings"]);
});

test("laneStateFromBodyClassName reads only the classes the page itself already applies", () => {
  assert.equal(laneStateFromBodyClassName("topic-search-lane-body is-loading"), "loading");
  assert.equal(laneStateFromBodyClassName("topic-search-lane-body is-error"), "error");
  assert.equal(laneStateFromBodyClassName("topic-search-lane-body"), "");
  assert.equal(laneStateFromBodyClassName(""), "");
});

/* ---- reading the live section, and choosing the active lane group ---- */

test("laneDescriptorFromSection copies the section's own heading, status text, and state verbatim", () => {
  const doc = createDocument();
  const { root } = buildRoot(doc, {
    semanticLanes: [{ id: "meetings", label: "Meetings", headingId: "search-semantic-lane-meetings", statusText: "3 results", bodyClassName: "topic-search-lane-body" }],
  });
  const section = root.querySelector(".topic-search-lane");
  assert.deepEqual(laneDescriptorFromSection(section), {
    id: "meetings",
    headingId: "search-semantic-lane-meetings",
    label: "Meetings",
    statusText: "3 results",
    state: "",
  });
});

test("visibleLaneSections follows whichever lane group the page is actually showing", () => {
  const doc = createDocument();
  const { root } = buildRoot(doc, {
    semanticLanes: semanticFixture(),
    keywordLanes: SIX_FAMILIES.map((f) => ({ ...f, headingId: `search-lane-${f.id}`, statusText: "Waiting" })),
    semanticHidden: false,
    keywordHidden: true,
  });
  assert.equal(visibleLaneSections(root).length, 6);
  assert.ok(visibleLaneSections(root).every((s) => s.getAttribute("data-semantic-family")));

  const legacy = buildRoot(doc, {
    semanticLanes: semanticFixture(),
    keywordLanes: SIX_FAMILIES.map((f) => ({ ...f, headingId: `search-lane-${f.id}`, statusText: "2 results" })),
    semanticHidden: true,
    keywordHidden: false,
  });
  assert.ok(visibleLaneSections(legacy.root).every((s) => s.getAttribute("data-search-lane")));
});

test("an individually hidden family (a narrowed scope) is excluded from the jump list", () => {
  const doc = createDocument();
  const fixture = semanticFixture({ exams: { hidden: true } });
  const { root } = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  const ids = visibleLaneSections(root).map((s) => s.getAttribute("data-semantic-family"));
  assert.ok(!ids.includes("exams"));
  assert.equal(ids.length, 5);
});

/* ---- the required response states: complete, partial, empty, loading, error ---- */

test("complete: every family has results, and the nav's own text matches each section's count exactly", () => {
  const doc = createDocument();
  const fixture = semanticFixture({
    contracts: { statusText: "3 results" },
    "people-organizations": { statusText: "1 result" },
    land: { statusText: "2 results" },
    rules: { statusText: "4 results" },
    meetings: { statusText: "5 results" },
    exams: { statusText: "1 result" },
  });
  const { root, list } = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  const items = renderFamilyNav(root, doc);
  assert.equal(items.length, 6);
  assert.equal(list.children.length, 6);
  for (const section of visibleLaneSections(root)) {
    const status = section.querySelector(".topic-search-lane-status").textContent;
    const family = section.getAttribute("data-semantic-family");
    const item = items.find((i) => i.id === family);
    assert.equal(item.statusText, status, `nav text for ${family} must not diverge from its own section`);
    assert.equal(item.state, "");
  }
});

test("partial: some families have results and others do not, in the same response", () => {
  const doc = createDocument();
  const fixture = semanticFixture({
    contracts: { statusText: "3 results" },
    meetings: { statusText: "No matches" },
    exams: { statusText: "Not covered" },
  });
  const { root } = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  const items = renderFamilyNav(root, doc);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.contracts.statusText, "3 results");
  assert.equal(byId.meetings.statusText, "No matches");
  assert.equal(byId.exams.statusText, "Not covered");
  assert.equal(items.length, 6, "an empty or uncovered family is still a valid jump target, not hidden");
});

test("empty: no family has a match anywhere, and no count is invented for any of them", () => {
  const doc = createDocument();
  const fixture = semanticFixture({});
  for (const family of SIX_FAMILIES) fixture.find((f) => f.id === family.id).statusText = "No matches";
  const { root } = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  const items = renderFamilyNav(root, doc);
  assert.equal(items.length, 6);
  assert.ok(items.every((item) => item.statusText === "No matches"));
  assert.ok(items.every((item) => item.state === ""));
});

test("loading: a family mid-search is labeled as searching, not silently blank", () => {
  const doc = createDocument();
  const fixture = semanticFixture({
    contracts: { statusText: "Searching…", bodyClassName: "topic-search-lane-body is-loading" },
    meetings: { statusText: "Searching…", bodyClassName: "topic-search-lane-body is-loading" },
  });
  const { root } = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  const items = renderFamilyNav(root, doc);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.contracts.state, "loading");
  assert.equal(byId.contracts.statusText, "Searching…");
  assert.equal(byId.land.state, "", "a family not currently loading keeps its own state");
});

test("error: an unavailable source is labeled unavailable rather than omitted or shown as empty", () => {
  const doc = createDocument();
  const fixture = semanticFixture({
    rules: { statusText: "Unavailable", bodyClassName: "topic-search-lane-body is-error" },
  });
  const { root } = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  const items = renderFamilyNav(root, doc);
  const rules = items.find((i) => i.id === "rules");
  assert.equal(rules.state, "error");
  assert.equal(rules.statusText, "Unavailable");
});

/* ---- keyboard focus movement, with no search side effect ---- */

test("activating a family's control moves focus to its own visible heading and nothing else", () => {
  const doc = createDocument();
  const fixture = semanticFixture({ meetings: { statusText: "5 results" } });
  const { root, list } = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  renderFamilyNav(root, doc);

  const meetingsHeading = root.querySelector("[data-semantic-family]") && [...root.querySelectorAll(".topic-search-lane")]
    .find((s) => s.getAttribute("data-semantic-family") === "meetings")
    .querySelector("h3");
  const otherHeadings = [...root.querySelectorAll(".topic-search-lane")]
    .filter((s) => s.getAttribute("data-semantic-family") !== "meetings")
    .map((s) => s.querySelector("h3"));

  assert.equal(meetingsHeading.hasAttribute("tabindex"), false, "not yet programmatically focusable before activation");

  const meetingsIndex = SIX_FAMILIES.findIndex((f) => f.id === "meetings");
  const button = list.children[meetingsIndex].children[0];
  assert.equal(button.tagName, "button", "the control is a native, natively keyboard-operable button");

  // A native <button> receives a "click" from a mouse activation and, in a
  // real browser, from Enter/Space keyboard activation alike; dispatching
  // the click here exercises the same handler either path reaches.
  button.click();

  assert.equal(meetingsHeading.focusCalled, true);
  assert.equal(meetingsHeading.getAttribute("tabindex"), "-1", "made focusable so keyboard focus can actually land there");
  assert.ok(meetingsHeading.scrolledInto, "the target is brought into view, not just focused off-screen");
  for (const heading of otherHeadings) assert.equal(heading.focusCalled, false, "focus moves to exactly one heading");
});

test("activateFamilyNavHeading is a no-op for a missing target and idempotent for tabindex", () => {
  assert.equal(activateFamilyNavHeading(null), false);
  const doc = createDocument();
  const heading = doc.createElement("h3");
  heading.setAttribute("tabindex", "-1");
  assert.equal(activateFamilyNavHeading(heading), true);
  assert.equal(heading.getAttribute("tabindex"), "-1", "an existing tabindex is left alone rather than reset");
});

test("the jump list stays hidden when there is nothing to jump to, and reappears once there is", () => {
  const doc = createDocument();
  const { root, nav } = buildRoot(doc, { semanticLanes: [], keywordLanes: [] });
  renderFamilyNav(root, doc);
  assert.equal(nav.hidden, true);

  const fixture = semanticFixture();
  const populated = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  renderFamilyNav(populated.root, doc);
  assert.equal(populated.nav.hidden, false);
});

test("re-rendering replaces the previous list rather than accumulating duplicate controls", () => {
  const doc = createDocument();
  const fixture = semanticFixture();
  const { root, list } = buildRoot(doc, { semanticLanes: fixture, semanticHidden: false });
  renderFamilyNav(root, doc);
  assert.equal(list.children.length, 6);
  renderFamilyNav(root, doc);
  assert.equal(list.children.length, 6, "a repaint does not duplicate the six controls");
});
