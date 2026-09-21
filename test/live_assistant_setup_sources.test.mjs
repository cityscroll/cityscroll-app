// Verify the official documentation links used by the remote-connector guide.
//
// The default test sweep stays network-independent. Run this file with
// CS_RUN_LIVE_ASSISTANT_SETUP=true to resolve every published source URL.
// Verify: CS_RUN_LIVE_ASSISTANT_SETUP=true node --test test/live_assistant_setup_sources.test.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const sourceRegistry = JSON.parse(await readFile(resolve(ROOT, "site/data/assistant_setup_sources.json"), "utf8"));
const allowedHosts = new Set(["support.claude.com", "code.claude.com", "modelcontextprotocol.io"]);
const liveEnabled = process.env.CS_RUN_LIVE_ASSISTANT_SETUP === "true";

test("A3: every published official setup source resolves without leaving its official host", { skip: !liveEnabled }, async () => {
  assert.ok(Array.isArray(sourceRegistry.sources) && sourceRegistry.sources.length > 0);

  const observations = await Promise.all(sourceRegistry.sources.map(async (source) => {
    const original = new URL(source.url);
    assert.equal(original.protocol, "https:", `${source.id} must use HTTPS`);
    assert.equal(allowedHosts.has(original.hostname), true, `${source.id} must use an allowlisted official host`);

    const response = await fetch(original, { redirect: "follow" });
    const finalUrl = new URL(response.url);
    assert.equal(response.ok, true, `${source.id} resolved with HTTP ${response.status}`);
    assert.equal(finalUrl.protocol, "https:");
    assert.equal(allowedHosts.has(finalUrl.hostname), true, `${source.id} redirected off an official host`);
    return { id: source.id, status: response.status, final_url: response.url };
  }));

  assert.equal(observations.length, sourceRegistry.sources.length);
});
