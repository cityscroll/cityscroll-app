import assert from "node:assert/strict";
import test from "node:test";

import {
  corsHeaders,
  isAllowedRequestOrigin,
} from "../src/lib/cors.mjs";
import { handleEvent } from "../src/events.mjs";
import { handleFeedback } from "../src/feedback.mjs";
import { handleSubscribe } from "../src/subscribe.mjs";

const betaEnv = { DEPLOYMENT_CHANNEL: "beta", ANALYTICS_ENVIRONMENT: "preview" };
const betaOrigins = [
  "https://beta.crol-list.org",
  "https://crol-list-beta.pages.dev",
  "https://pr-42.crol-list-beta.pages.dev",
  "https://a1b2c3d4.crol-list-beta.pages.dev",
];
const localDevelopmentOrigin = ["http", ["localhost", "8000"].join(":")].join("://");

test("production origins remain allowed in every environment", () => {
  for (const origin of [
    "https://crol-list.org",
    "https://www.crol-list.org",
    "https://cityscroll.org",
    "https://www.cityscroll.org",
    localDevelopmentOrigin,
    "",
  ]) {
    assert.equal(isAllowedRequestOrigin(origin, {}), true, origin);
    assert.equal(isAllowedRequestOrigin(origin, betaEnv), true, origin);
  }
});

test("review origins are beta-only and external origins stay rejected", () => {
  for (const origin of betaOrigins) {
    assert.equal(isAllowedRequestOrigin(origin, {}), false, origin);
    assert.equal(isAllowedRequestOrigin(origin, betaEnv), true, origin);
    assert.equal(corsHeaders(origin, betaEnv)["Access-Control-Allow-Origin"], origin);
  }
  assert.equal(isAllowedRequestOrigin("https://example.com", betaEnv), false);
  assert.equal(isAllowedRequestOrigin("http://pr-42.crol-list-beta.pages.dev", betaEnv), false);
});

test("analytics from beta is accepted but dropped, while production rejects beta origins", async () => {
  const request = (origin) =>
    new Request("https://api-beta.crol-list.org/events", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "text/plain" },
      body: JSON.stringify({ event: "page_view", surface: "home" }),
    });

  const production = await handleEvent(request(betaOrigins[0]), {
    ANALYTICS_ENVIRONMENT: "production",
    USAGE_ANALYTICS: { writeDataPoint() { throw new Error("must not write"); } },
  });
  assert.equal(production.status, 403);

  const beta = await handleEvent(request(betaOrigins[0]), betaEnv);
  assert.equal(beta.status, 204);
});

test("beta subscription and feedback routes fail closed before side effects", async () => {
  const subscribe = await handleSubscribe(
    new Request("https://api-beta.crol-list.org/subscribe", {
      method: "POST",
      headers: { Origin: betaOrigins[1], "Content-Type": "application/json" },
      body: "{}",
    }),
    betaEnv,
  );
  assert.equal(subscribe.status, 503);
  assert.equal((await subscribe.json()).reason, "not-configured");

  const feedback = await handleFeedback(
    new Request("https://api-beta.crol-list.org/feedback", {
      method: "POST",
      headers: { Origin: betaOrigins[1], "Content-Type": "application/json" },
      body: "{}",
    }),
    betaEnv,
  );
  assert.equal(feedback.status, 503);
  assert.equal((await feedback.json()).reason, "not-configured");
});
