// Exercises the on-demand path: notice-detail sections owned by a lens the Notice
// route no longer boots. A section that is not on this notice must not activate its
// lens; a section that is on it must load the lens and render, never leave a blank.
//
//   node --test test/notice_lens_sections.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureNoticeLens,
  noticeProcurementChain,
  renderNoticeLandSpine,
  renderNoticeMeetingOutcomes,
} from "../site/notice_lens_sections.mjs";

/** Minimal stand-in for the element the notice detail hands each section. */
function hostElement() {
  return { innerHTML: "seed" };
}

/**
 * Install a route-module gate that records activations, plus whatever lens
 * renderers the case under test expects to become available.
 */
function installGate({ activations, onActivate = () => {}, fail = false } = {}) {
  const previous = {
    CrolRouteModules: globalThis.CrolRouteModules,
    loadNoticeLandSpine: globalThis.loadNoticeLandSpine,
    loadMeetingOutcomes: globalThis.loadMeetingOutcomes,
    loadChain: globalThis.loadChain,
  };
  globalThis.CrolRouteModules = {
    ensure(name) {
      activations.push(name);
      if (fail) return Promise.reject(new Error("activation failed"));
      onActivate(name);
      return Promise.resolve({});
    },
  };
  return () => Object.assign(globalThis, previous);
}

const LAND_NOTICE = {
  request_id: "20260101001",
  section_name: "Public Hearings and Meetings",
  agency_name: "City Planning Commission",
  additional_description_1: "Application C 260123 ZMK is scheduled for a public hearing.",
};
const PLAIN_NOTICE = {
  request_id: "20260101002",
  section_name: "Procurement",
  agency_name: "Department of Sanitation",
  short_title: "Refuse collection services",
};

test("a notice with no land project never activates the Land lens", async () => {
  const activations = [];
  const restore = installGate({ activations });
  try {
    const element = hostElement();
    await renderNoticeLandSpine(PLAIN_NOTICE, element);
    assert.deepEqual(activations, []);
    assert.equal(element.innerHTML, "", "an absent section clears its slot rather than leaving stale content");
  } finally { restore(); }
});

test("a notice with a land project activates the Land lens and renders through it", async () => {
  const activations = [];
  const rendered = [];
  const restore = installGate({
    activations,
    onActivate() { globalThis.loadNoticeLandSpine = (record, element) => { rendered.push(record.request_id); element.innerHTML = "spine"; }; },
  });
  try {
    const element = hostElement();
    await renderNoticeLandSpine(LAND_NOTICE, element);
    assert.deepEqual(activations, ["land"]);
    assert.deepEqual(rendered, [LAND_NOTICE.request_id]);
    assert.equal(element.innerHTML, "spine");
  } finally { restore(); }
});

test("a failed Land activation resolves instead of breaking the rest of the notice", async () => {
  const activations = [];
  const restore = installGate({ activations, fail: true });
  try {
    globalThis.loadNoticeLandSpine = undefined;
    const element = hostElement();
    await assert.doesNotReject(renderNoticeLandSpine(LAND_NOTICE, element));
    assert.deepEqual(activations, ["land"]);
  } finally { restore(); }
});

test("a notice with no meeting outcome never activates the Meetings lens", async () => {
  const activations = [];
  const restore = installGate({ activations });
  try {
    const reads = [];
    const fetchImpl = async (path) => { reads.push(path); return { ok: true, json: async () => ({ ok: true, record: null }) }; };
    await renderNoticeMeetingOutcomes(PLAIN_NOTICE, hostElement(), fetchImpl);
    assert.equal(reads.length, 1, "the read model is consulted before the lens is booted");
    assert.deepEqual(activations, []);
  } finally { restore(); }
});

test("a hearing notice activates the Meetings lens and hands over the record it already read", async () => {
  const activations = [];
  const handed = [];
  const payload = { ok: true, record: { join: { matched: true } } };
  const restore = installGate({
    activations,
    onActivate() { globalThis.loadMeetingOutcomes = (record, element, prefetched) => { handed.push(prefetched); }; },
  });
  try {
    let reads = 0;
    const fetchImpl = async () => { reads += 1; return { ok: true, json: async () => payload }; };
    await renderNoticeMeetingOutcomes(LAND_NOTICE, hostElement(), fetchImpl);
    assert.deepEqual(activations, ["meetings"]);
    assert.equal(reads, 1, "the record is read once, not once per owner");
    assert.deepEqual(handed, [payload]);
  } finally { restore(); }
});

test("a matched meeting on a notice that is not a hearing still renders", async () => {
  const activations = [];
  const restore = installGate({ activations, onActivate() { globalThis.loadMeetingOutcomes = () => {}; } });
  try {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, record: { join: { matched: true } } }) });
    await renderNoticeMeetingOutcomes(PLAIN_NOTICE, hostElement(), fetchImpl);
    assert.deepEqual(activations, ["meetings"]);
  } finally { restore(); }
});

test("an unavailable meeting read model activates nothing", async () => {
  const activations = [];
  const restore = installGate({ activations });
  try {
    const fetchImpl = async () => { throw new Error("upstream unavailable"); };
    await renderNoticeMeetingOutcomes(PLAIN_NOTICE, hostElement(), fetchImpl);
    assert.deepEqual(activations, []);
  } finally { restore(); }
});

test("the procurement chain activates the Contracts lens and falls back to the notice alone", async () => {
  const activations = [];
  const restore = installGate({ activations });
  try {
    globalThis.loadChain = undefined;
    assert.deepEqual(await noticeProcurementChain(PLAIN_NOTICE), [PLAIN_NOTICE]);
    assert.deepEqual(activations, ["money"]);
  } finally { restore(); }
});

test("the procurement chain returns the lens reader's chain once the lens is loaded", async () => {
  const activations = [];
  const chain = [PLAIN_NOTICE, { request_id: "prior" }];
  const restore = installGate({ activations, onActivate() { globalThis.loadChain = () => chain; } });
  try {
    assert.deepEqual(await noticeProcurementChain(PLAIN_NOTICE), chain);
  } finally { restore(); }
});

test("activating a lens on a route with no gate resolves rather than throwing", async () => {
  const previous = globalThis.CrolRouteModules;
  globalThis.CrolRouteModules = undefined;
  try {
    assert.equal(await ensureNoticeLens("money"), undefined);
  } finally { globalThis.CrolRouteModules = previous; }
});
