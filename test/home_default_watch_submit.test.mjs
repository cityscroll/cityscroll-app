// Behavioural cover for the disclosed homepage default watch (site/home_default_watch.mjs).
//
// The homepage box works without JavaScript as a plain form POST; this module is the
// progressive enhancement over it, attached by site/app/main.mjs on every index.html
// route (static home and hash landings alike). What matters to a reader is what the enhanced submit
// actually sends and what it then says, so these tests load the real module against a
// minimal DOM, run its submit handler, and assert the posted request and the resulting
// status message rather than reading the module's source.
//
// t() is stubbed to return its own key, so an assertion names the message a reader sees
// without restating its copy; the English copy itself is pinned in test/homepage_cta.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WATCH_HANDOFF_STORAGE_KEY } from "../site/following_default_watch_receipt.mjs";

const API_ORIGIN = "https://api.test";
const FALLBACK_ORIGIN = "https://fallback.test";

function fakeElement(id = "") {
  return {
    id,
    value: "",
    href: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    focused: false,
    options: [],
    dataset: {},
    attributes: new Map(),
    listeners: new Map(),
    classList: { toggle() {} },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    removeEventListener(type) { this.listeners.delete(type); },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    focus() { this.focused = true; },
  };
}

const elements = new Map(
  ["langSelect", "homeCtaForm", "homeCtaEmail", "homeCtaMsg", "homeCtaSubmit", "homeCtaLang", "nlgo", "nlq"]
    .map((id) => [id, fakeElement(id)]),
);
const form = elements.get("homeCtaForm");
const email = elements.get("homeCtaEmail");
const message = elements.get("homeCtaMsg");
const button = elements.get("homeCtaSubmit");
const langField = elements.get("homeCtaLang");

const calls = [];
let respond = () => { throw new Error("no response configured"); };
const sessionStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
  clear() { this.values.clear(); },
};
let assigned = "";

globalThis.document = {
  body: { dataset: {} },
  getElementById(id) { return elements.get(id) || null; },
  querySelectorAll() { return []; },
  querySelector() { return null; },
};
globalThis.window = {
  LANG: "es",
  CROL_API_ORIGIN: API_ORIGIN,
  CROL_API_FALLBACK_ORIGIN: FALLBACK_ORIGIN,
  addEventListener() {},
  t: (key, values = {}) => Object.entries(values)
    .reduce((copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)), key),
};
globalThis.location = {
  hash: "",
  pathname: "/",
  assign(url) { assigned = url; },
};
globalThis.sessionStorage = sessionStorage;
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return respond(String(url));
};
// The static-first homepage loads this module before core.mjs installs workerFetch. If the
// submit reached for it, this would throw instead of silently working in a warm-cache test.
globalThis.workerFetch = () => { throw new Error("workerFetch is not loaded on the static homepage"); };

const { initHomeDefaultSubscription } = await import("../site/home_default_watch.mjs");
initHomeDefaultSubscription();

function jsonResponse(body, status = 200) {
  return { status, json: async () => body };
}

async function submit(value = "reader@example.com") {
  calls.length = 0;
  message.textContent = "";
  email.value = value;
  email.removeAttribute("aria-invalid");
  assigned = "";
  sessionStorage.clear();
  const handler = form.listeners.get("submit");
  assert.equal(typeof handler, "function", "the module never registered a submit handler");
  let defaultPrevented = false;
  await handler({ preventDefault() { defaultPrevented = true; } });
  assert.equal(defaultPrevented, true, "the enhanced submit must not also navigate away");
  return calls;
}

function defaultWatchReceipt(watch = {}) {
  return {
    watch_id: watch.watch_id || "watch:contracts-weekly-citywide",
    lens: "money",
    filter: {},
    freq: "weekly",
    label: "Citywide contracts and RFPs",
    followingUrl: "/following/",
    ...watch,
  };
}

test("a valid address posts exactly the disclosed homepage-default intent", async () => {
  respond = () => jsonResponse({ ok: true, no_topic: true, created: true });
  const [request] = await submit("reader@example.com");
  assert.equal(calls.length, 1, "one request per submit, no retry against the fallback origin");
  assert.equal(request.url, `${API_ORIGIN}/subscribe`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.options.body), {
    email: "reader@example.com",
    no_topic: true,
    source: "top-of-site",
    lang: "es",
  });
  assert.equal(langField.value, "es", "the no-JS form fields stay in sync with the posted language");
});

test("a newly stored watch reports enrollment and clears the field", async () => {
  respond = () => jsonResponse({ ok: true, no_topic: true, created: true, watch: defaultWatchReceipt() });
  await submit();
  assert.equal(message.textContent, "subscribed_now welcome_sent_to");
  assert.equal(email.value, "", "a stored watch clears the field so a second submit is deliberate");
  assert.equal(button.disabled, false);
  assert.equal(sessionStorage.values.size, 1, "a validated watch receipt is stored in same-tab state");
  assert.equal(assigned, "/following/#your-following");
});

test("a valid success stores a strict default watch receipt and does not leak the email", async () => {
  respond = () => jsonResponse({ ok: true, no_topic: true, created: true, watch: defaultWatchReceipt() });
  await submit("Reader@Example.com");
  const stored = sessionStorage.getItem(DEFAULT_WATCH_HANDOFF_STORAGE_KEY);
  const receipt = JSON.parse(stored);
  assert.equal(receipt.schema, "cityscroll.following_default_watch_handoff.v1");
  assert.equal(receipt.version, 1);
  assert.equal(receipt.watch.watch_id, "watch:contracts-weekly-citywide");
  assert.equal(receipt.workstream_card, "FS-16");
  assert.equal(receipt.watch.followingUrl, "/following/");
  assert.equal(receipt.watch.lens, "money");
  assert.equal(receipt.watch.freq, "weekly");
  assert.equal(receipt.created, true);
  assert.doesNotMatch(stored, /reader@example\.com/i);
});

test("an address that already has the default watch is told so, not told it just subscribed", async () => {
  respond = () => jsonResponse({ ok: true, no_topic: true, created: false, watch: defaultWatchReceipt() });
  await submit();
  assert.equal(message.textContent, "home_cta_active_now");
});

test("a rejected request reports the reason and never claims enrollment", async () => {
  respond = () => jsonResponse({ ok: false, reason: "rate-limited" }, 429);
  await submit();
  assert.equal(message.textContent, "rate_limited");
  assert.equal(email.value, "reader@example.com", "a rejected submit keeps the address for a retry");
});

test("a stored watch whose welcome email failed still reports the storage success", async () => {
  respond = () => jsonResponse({ ok: false, reason: "send-failed", subscribed: true }, 502);
  await submit();
  // Dropping the storage half here is what makes a retry's "you're already getting these"
  // read as a contradiction, so both halves have to survive.
  assert.equal(message.textContent, "subscribed_now send_failed");
  assert.equal(email.value, "reader@example.com");
});

test("a failed save reports a retryable error, not an unconfigured service", async () => {
  respond = () => jsonResponse({ ok: false, reason: "save-failed", subscribed: false }, 503);
  await submit();
  assert.equal(message.textContent, "generic_error");
  assert.equal(email.value, "reader@example.com");
});

test("attaching the enhancement twice registers one submit handler", async () => {
  let registrations = 0;
  const original = form.addEventListener;
  form.addEventListener = function (type, handler) { registrations += 1; original.call(this, type, handler); };
  try {
    initHomeDefaultSubscription();
  } finally {
    form.addEventListener = original;
  }
  assert.equal(registrations, 0);
});

test("a welcome failure with nothing stored reports only the failure", async () => {
  respond = () => jsonResponse({ ok: false, reason: "send-failed", subscribed: false }, 502);
  await submit();
  assert.equal(message.textContent, "send_failed");
});

test("an unreachable primary origin falls back to the second origin", async () => {
  respond = (url) => {
    if (url.startsWith(API_ORIGIN)) throw new TypeError("Failed to fetch");
    return jsonResponse({ ok: true, no_topic: true, created: true });
  };
  const requests = await submit();
  assert.deepEqual(requests.map((request) => request.url), [
    `${API_ORIGIN}/subscribe`,
    `${FALLBACK_ORIGIN}/subscribe`,
  ]);
  assert.equal(message.textContent, "subscribed_now welcome_sent_to");
});

test("both origins unreachable reports a transport failure, not a subscription", async () => {
  respond = () => { throw new TypeError("Failed to fetch"); };
  await submit();
  assert.equal(message.textContent, "cant_reach_server");
  assert.equal(button.disabled, false, "the button is re-enabled so the reader can retry");
});

test("an address the form would reject is never posted", async () => {
  respond = () => jsonResponse({ ok: true, created: true });
  const requests = await submit("reader@example");
  assert.equal(requests.length, 0);
  assert.equal(message.textContent, "enter_valid_email");
  assert.equal(email.getAttribute("aria-invalid"), "true");
  assert.equal(email.focused, true);
});
