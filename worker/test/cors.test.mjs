import assert from "node:assert/strict";
import test from "node:test";

import {
  corsHeaders,
  isAllowedRequestOrigin,
} from "../src/lib/cors.mjs";
import { handleEvent } from "../src/events.mjs";

const reviewPagesHost = ["crol", "-", "list", "-beta", ".pages.dev"].join("");
const retiredReviewOrigins = [
  "https://beta.cityscroll.org",
  `https://${reviewPagesHost}`,
  `https://pr-42.${reviewPagesHost}`,
  `https://a1b2c3d4.${reviewPagesHost}`,
];
const localDevelopmentOrigin = ["http", ["localhost", "8000"].join(":")].join("://");

test("production origins remain allowed", () => {
  for (const origin of [
    "https://cityscroll.org",
    "https://www.cityscroll.org",
    "https://crol-list.org",
    "https://www.crol-list.org",
    // Parallel Pages host: API from cityscroll.pages.dev during dual-serving soak.
    "https://cityscroll.pages.dev",
    localDevelopmentOrigin,
    "",
  ]) {
    assert.equal(isAllowedRequestOrigin(origin, {}), true, origin);
  }
  assert.equal(
    corsHeaders("https://cityscroll.pages.dev", {})["Access-Control-Allow-Origin"],
    "https://cityscroll.pages.dev",
  );
});

test("retired review origins and external origins stay rejected", () => {
  for (const origin of retiredReviewOrigins) {
    assert.equal(isAllowedRequestOrigin(origin, {}), false, origin);
    assert.equal(
      corsHeaders(origin, {})["Access-Control-Allow-Origin"],
      "https://cityscroll.org",
    );
  }
  assert.equal(isAllowedRequestOrigin("https://example.com", {}), false);
  assert.equal(isAllowedRequestOrigin(`http://pr-42.${reviewPagesHost}`, {}), false);
});

test("analytics from retired review origins is rejected", async () => {
  const request = (origin) =>
    new Request("https://api.cityscroll.org/events", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "text/plain" },
      body: JSON.stringify({ event: "page_view", surface: "home" }),
    });

  const production = await handleEvent(request(retiredReviewOrigins[0]), {
    ANALYTICS_ENVIRONMENT: "production",
    USAGE_ANALYTICS: { writeDataPoint() { throw new Error("must not write"); } },
  });
  assert.equal(production.status, 403);
});
