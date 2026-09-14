import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireConsultationSources, CONSULTATION_TRANSPORT_DEFAULTS } from "../site/consultation_acquisition.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const headers = (map = {}) => ({ get: (name) => map[name.toLowerCase()] || null });
const response = (status, body, extra = {}) => {
  const bytes = new TextEncoder().encode(body);
  return { status, headers: headers({ "content-type": "text/html", ...extra }), body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
};
const okFetch = async () => response(200, "<html>organizer evidence</html>");

test("acquisition uses the exact bounded transport envelope", () => {
  assert.deepEqual({
    maxRedirects: CONSULTATION_TRANSPORT_DEFAULTS.maxRedirects,
    maxRetries: CONSULTATION_TRANSPORT_DEFAULTS.maxRetries,
    minOriginIntervalMs: CONSULTATION_TRANSPORT_DEFAULTS.minOriginIntervalMs,
    requestTimeoutMs: CONSULTATION_TRANSPORT_DEFAULTS.requestTimeoutMs,
    maxRequests: CONSULTATION_TRANSPORT_DEFAULTS.maxRequests,
    maxBytes: CONSULTATION_TRANSPORT_DEFAULTS.maxBytes,
    responseCapBytes: CONSULTATION_TRANSPORT_DEFAULTS.responseCapBytes,
  }, { maxRedirects: 3, maxRetries: 2, minOriginIntervalMs: 2000, requestTimeoutMs: 25000, maxRequests: 100, maxBytes: 25000000, responseCapBytes: 5000000 });
});

test("HTTP failure and truncated response preserve a last-good materialization", async () => {
  await withPinnedClock("2026-09-14T00:00:00.000Z", async () => {
    const first = await acquireConsultationSources({ fetchImpl: okFetch, asOf: "2026-09-14T00:00:00.000Z", transportOptions: { minOriginIntervalMs: 0 } });
    let calls = 0;
    const failing = await acquireConsultationSources({ previous: first.materialization, asOf: "2026-09-15T00:00:00.000Z", transportOptions: { minOriginIntervalMs: 0, responseCapBytes: 8 }, fetchImpl: async () => (++calls === 1 ? response(503, "busy") : response(200, "0123456789")) });
    assert.ok(failing.receipt.failures > 0);
    assert.equal(failing.receipt.last_good_preserved, true);
    assert.deepEqual(failing.materialization, first.materialization);
    assert.ok(failing.observations.some((item) => item.failure));
  });
});

test("redirect boundary is retained as an explicit failure", async () => {
  const result = await acquireConsultationSources({ transportOptions: { minOriginIntervalMs: 0, maxRedirects: 3 }, fetchImpl: async (url) => response(302, "", { location: `${url}?next=1` }) });
  assert.ok(result.observations.every((item) => item.failure === "redirect_limit_exceeded"));
});

test("replaying fixed observations is deterministic", async () => {
  await withPinnedClock("2026-09-14T00:00:00.000Z", async () => {
    const options = { fetchImpl: okFetch, asOf: "2026-09-14T00:00:00.000Z", transportOptions: { minOriginIntervalMs: 0 } };
    const [a, b] = await Promise.all([acquireConsultationSources(options), acquireConsultationSources(options)]);
    assert.deepEqual(a.materialization, b.materialization);
  });
});
