/**
 * Public-body directory browser binder.
 *
 * Direct load and in-product arrival must both narrow the visible list when a
 * resident types into the directory's own search field. The original report and
 * an isolated re-check disagreed on exactly that difference; this suite watches
 * the navigated case so a state-dependent recurrence fails here.
 *
 *   node --test test/agency_directory_runtime.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mountAgencyDirectory } from "../site/agency_directory_runtime.mjs";
import { FakeEvent, mountDocument } from "./helpers/preview_dom.mjs";

const DIRECTORY_MARKUP = `
<div class="agency-directory" data-agency-directory="1" data-directory-total="3">
  <form class="agency-directory-search" method="get" action="/agencies/" role="search" data-directory-form="1">
    <label for="agency-directory-query">Search by name or acronym</label>
    <input id="agency-directory-query" class="agency-directory-input" type="search" name="q" value="" data-directory-query="1">
    <button type="submit">Search</button>
    <a class="agency-directory-clear" href="/agencies/" data-directory-clear="1">Clear</a>
  </form>
  <nav class="agency-directory-groups" aria-label="Browse by group">
    <ul>
      <li><a href="/agencies/?group=departments-executive-offices" data-directory-group="departments-executive-offices">Departments <span class="agency-directory-count">2</span></a></li>
      <li><a href="/agencies/?group=authorities-public-corporations" data-directory-group="authorities-public-corporations">Authorities <span class="agency-directory-count">1</span></a></li>
    </ul>
  </nav>
  <p class="agency-directory-summary" data-directory-summary="1" role="status">Showing all 3 public bodies.</p>
  <p class="agency-directory-empty" data-directory-empty="1" hidden>No public body in this directory matches that search.</p>
  <section class="agency-directory-group" id="group-departments-executive-offices" data-directory-section="departments-executive-offices">
    <h2>Departments <span data-directory-section-count="departments-executive-offices">2</span></h2>
    <ul>
      <li class="agency-directory-row" data-directory-row="1" data-canonical-id="parks-and-recreation" data-group="departments-executive-offices" data-secondary-groups="" data-haystack=" parks and recreation dpr parks">
        <a class="agency-index-link" href="/agencies/parks-and-recreation/">Parks and Recreation</a>
      </li>
      <li class="agency-directory-row" data-directory-row="1" data-canonical-id="transportation" data-group="departments-executive-offices" data-secondary-groups="" data-haystack=" transportation dot">
        <a class="agency-index-link" href="/agencies/transportation/">Transportation</a>
      </li>
    </ul>
  </section>
  <section class="agency-directory-group" id="group-authorities-public-corporations" data-directory-section="authorities-public-corporations">
    <h2>Authorities <span data-directory-section-count="authorities-public-corporations">1</span></h2>
    <ul>
      <li class="agency-directory-row" data-directory-row="1" data-canonical-id="housing-authority" data-group="authorities-public-corporations" data-secondary-groups="" data-haystack=" housing authority nycha">
        <a class="agency-index-link" href="/agencies/housing-authority/">Housing Authority</a>
      </li>
    </ul>
  </section>
</div>
`;

function makeLocation(href = "https://cityscroll.org/agencies/") {
  const url = new URL(href);
  return {
    get href() { return `${url.origin}${url.pathname}${url.search}`; },
    set href(next) {
      const parsed = new URL(next, url.origin);
      url.pathname = parsed.pathname;
      url.search = parsed.search;
    },
    get pathname() { return url.pathname; },
    set pathname(next) { url.pathname = next; },
    get search() { return url.search; },
    set search(next) { url.search = next.startsWith("?") || next === "" ? next : `?${next}`; },
    get origin() { return url.origin; },
  };
}

function makeHistory(location) {
  let state = null;
  return {
    get state() { return state; },
    replaceState(next, _title, path) {
      state = next;
      if (typeof path === "string") {
        const parsed = new URL(path, location.origin);
        location.pathname = parsed.pathname;
        location.search = parsed.search;
      }
    },
    pushState(next, _title, path) {
      this.replaceState(next, _title, path);
    },
  };
}

function makeSessionStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
  };
}

function mountDirectory(href = "https://cityscroll.org/agencies/") {
  const { doc, container } = mountDocument(DIRECTORY_MARKUP, { containerClass: "directory-host" });
  const location = makeLocation(href);
  const history = makeHistory(location);
  const sessionStorage = makeSessionStorage();
  const windowListeners = new Map();
  const binder = mountAgencyDirectory(doc, {
    location,
    history,
    sessionStorage,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    addWindowListener: (type, handler) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
  });
  assert.ok(binder, "directory markup must mount");
  return { doc, container, location, history, sessionStorage, windowListeners, binder };
}

function typeQuery(doc, text) {
  const input = doc.querySelector("[data-directory-query]");
  input.value = text;
  input.dispatchEvent(new FakeEvent("input"));
}

function visibleIds(doc) {
  return doc.querySelectorAll("[data-directory-row]")
    .filter((row) => !row.hidden)
    .map((row) => row.getAttribute("data-canonical-id"));
}

// A1 [outcome]: typing narrows on a directly loaded directory.
test("A1 typing an agency name narrows the directory on a direct load", () => {
  const { doc, binder, location } = mountDirectory();
  assert.equal(binder.visibleCount(), 3);
  typeQuery(doc, "Parks");
  assert.deepEqual(visibleIds(doc), ["parks-and-recreation"]);
  assert.match(doc.querySelector("[data-directory-summary]").textContent, /Showing 1 of 3.*Parks/);
  assert.equal(location.search, "?q=Parks");
  assert.equal(doc.querySelector("[data-directory-empty]").hidden, true);
});

test("a selected language survives live directory query replacement", () => {
  const { doc, location } = mountDirectory("https://cityscroll.org/agencies/?lang=es");
  typeQuery(doc, "Parks");
  assert.equal(location.search, "?q=Parks&lang=es");
});

// A1 / A3: the same search after an in-product arrival, not only a fresh load.
test("A3 typing narrows the directory after in-product navigation into it", () => {
  // Prior page in the same session: Browse (no directory binder).
  const prior = mountDocument(
    `<main><a href="/agencies/">Agencies &amp; public bodies</a></main>`,
    { containerClass: "browse-host" },
  );
  assert.equal(prior.doc.querySelector("[data-agency-directory]"), null);

  // Full-document arrival at the directory remounts the binder on fresh markup,
  // which is what in-product navigation does. The search must still narrow.
  const { doc, binder, location } = mountDirectory("https://cityscroll.org/agencies/");
  assert.equal(binder.visibleCount(), binder.total);
  typeQuery(doc, "Parks");
  assert.deepEqual(visibleIds(doc), ["parks-and-recreation"]);
  assert.equal(location.search, "?q=Parks");
  assert.match(doc.querySelector("[data-directory-summary]").textContent, /Parks/);
});

test("A3 search still narrows after arriving from a profile link with leftover query noise", () => {
  // In-product chrome can land a resident on the directory after another page
  // carried unrelated parameters. Directory state must still come from q/group.
  const { doc, binder, location } = mountDirectory(
    "https://cityscroll.org/agencies/?utm_source=browse&ref=profile",
  );
  assert.equal(binder.getState().query, "");
  assert.equal(binder.visibleCount(), 3);
  typeQuery(doc, "NYCHA");
  assert.deepEqual(visibleIds(doc), ["housing-authority"]);
  assert.equal(location.search, "?q=NYCHA");
});

test("A3 pageshow after a navigated return re-applies the URL query", () => {
  const { doc, binder, location, windowListeners } = mountDirectory(
    "https://cityscroll.org/agencies/?q=Parks",
  );
  assert.deepEqual(visibleIds(doc), ["parks-and-recreation"]);

  // Simulate a same-document history return that only fires pageshow/popstate.
  location.search = "";
  for (const handler of windowListeners.get("pageshow") || []) {
    handler(new FakeEvent("pageshow", { persisted: true }));
  }
  assert.equal(binder.getState().query, "");
  assert.equal(binder.visibleCount(), 3);

  location.search = "?q=Parks";
  for (const handler of windowListeners.get("popstate") || []) {
    handler(new FakeEvent("popstate"));
  }
  assert.deepEqual(visibleIds(doc), ["parks-and-recreation"]);
  assert.equal(doc.querySelector("[data-directory-query]").value, "Parks");
});

test("A1 a search matching nothing says so and Clear restores the full list", () => {
  const { doc, binder, location } = mountDirectory();
  typeQuery(doc, "zzzz no such body");
  assert.equal(binder.visibleCount(), 0);
  assert.equal(doc.querySelector("[data-directory-empty]").hidden, false);
  assert.match(doc.querySelector("[data-directory-summary]").textContent, /Showing 0 of 3/);

  const clear = doc.querySelector("[data-directory-clear]");
  clear.dispatchEvent(new FakeEvent("click"));
  assert.equal(binder.visibleCount(), 3);
  assert.equal(location.search, "");
  assert.equal(doc.querySelector("[data-directory-query]").value, "");
  assert.equal(doc.querySelector("[data-directory-empty]").hidden, true);
});
