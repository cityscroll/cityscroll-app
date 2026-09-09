import assert from "node:assert/strict";
import test from "node:test";
import { ROUTE_INVENTORY } from "../../tools/pages_route_parity.mjs";
import { handleFollowing } from "../src/following.mjs";
import { handleNearYou } from "../src/near_you.mjs";

const PLACEHOLDER = /__[A-Za-z0-9_]+__/;

test("Worker-owned inventory routes serve HTML without build placeholders", async () => {
  const handlers = new Map([["following", handleFollowing], ["near-you", handleNearYou]]);
  for (const route of ROUTE_INVENTORY.filter((entry) => handlers.has(entry.id))) {
    const response = await handlers.get(route.id)(new Request(`https://cityscroll.org${route.path}`));
    assert.equal(response.status, 200, route.path);
    assert.match(response.headers.get("content-type"), /text\/html/, route.path);
    assert.equal((await response.text()).match(PLACEHOLDER), null, route.path);
  }
});

test("served Following HTML has no build placeholders in any document response", async () => {
  for (const revision of [undefined, "a".repeat(40)]) {
    for (const path of ["/following", "/following/", "/following/?lens=unknown", "/following/?lens=money&step=choose"]) {
      const response = await handleFollowing(new Request(`https://cityscroll.org${path}`), {
        GIT_COMMIT_SHA: revision,
      }, {}, { fetchImpl: () => { throw new Error("unexpected network read"); } });
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.equal(html.match(PLACEHOLDER), null, path);
      const script = html.match(/<script src="(https:\/\/cityscroll\.org\/i18n\.js[^"]*)"/);
      assert.ok(script, `${path} loads the translation runtime`);
      assert.equal(new URL(script[1]).searchParams.get("v"), revision ?? null);
    }
  }
});

