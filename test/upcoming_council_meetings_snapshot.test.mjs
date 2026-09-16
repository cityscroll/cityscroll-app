import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  acquireLiveUpcomingCouncilMeetingsSnapshot,
  buildUpcomingCouncilMeetingsSnapshot,
  readLegistarToken,
} from "../tools/build_upcoming_council_meetings_snapshot.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/legistar/upcoming_contracts_22691.json", import.meta.url), "utf8"),
);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fixture builder remains deterministic for offline unit coverage", () => {
  const raw = buildUpcomingCouncilMeetingsSnapshot(fixture);
  const doc = JSON.parse(raw);
  assert.equal(doc.generated_at, "2026-09-09T12:00:00.000Z");
  assert.equal(doc.counts.meetings, 1);
  assert.equal(doc.meetings[0].identity.event_id, "22691");
});

test("live acquisition refuses to invent a vintage without a token", async () => {
  const result = await acquireLiveUpcomingCouncilMeetingsSnapshot({
    token: null,
    now: new Date("2026-09-16T15:00:00.000Z"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "token-absent");
});

test("live acquisition stamps generated_at from the run clock and keeps eligible meetings", async () => {
  const now = new Date("2026-09-16T15:00:00.000Z");
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/Events?") || href.includes("/Events&") || /\/Events(?:\?|$)/.test(href.split("?")[0] + (href.includes("?") ? "?" : ""))) {
      // Events list page
      if (href.includes("/Events/") && href.includes("/EventItems") === false && /Events\/\d+/.test(href)) {
        return jsonResponse([]);
      }
      if (href.includes("EventItems") || /Events\/\d+\/EventItems/.test(href)) {
        return jsonResponse(fixture.event_items);
      }
      return jsonResponse([fixture.event]);
    }
    if (/Events\/\d+\/EventItems/.test(href) || href.includes("/EventItems")) {
      return jsonResponse(fixture.event_items);
    }
    return jsonResponse([]);
  };

  const result = await acquireLiveUpcomingCouncilMeetingsSnapshot({
    token: "test-token-not-a-secret",
    fetchImpl,
    now,
  });
  assert.equal(result.ok, true);
  assert.equal(result.view.generated_at, now.toISOString());
  assert.ok(result.view.counts.meetings >= 1);
  assert.notEqual(result.view.generated_at, "2026-09-09T12:00:00.000Z");
});

test("readLegistarToken prefers LEGISTAR_API_TOKEN_FILE without exposing the value", () => {
  assert.equal(readLegistarToken({}), null);
  assert.equal(readLegistarToken({ LEGISTAR_API_TOKEN: "  abc  " }), "abc");
});
