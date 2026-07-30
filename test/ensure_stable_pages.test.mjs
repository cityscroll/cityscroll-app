import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PAGES_DEV_ORIGIN,
  PRODUCTION_BRANCH,
  PROJECT_NAME,
  ensureProject,
  resolveAccountId,
} from "../tools/ensure_stable_pages.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("stable Pages project name and production branch are fixed for the parallel host", () => {
  assert.equal(PROJECT_NAME, "cityscroll");
  assert.equal(PRODUCTION_BRANCH, "main");
  assert.equal(PAGES_DEV_ORIGIN, "https://cityscroll.pages.dev");
});

test("ensureProject creates the Direct Upload project when missing", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if ((options.method || "GET") === "GET") {
      return {
        ok: false,
        status: 404,
        json: async () => ({ success: false, errors: [{ message: "not found" }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { name: PROJECT_NAME, production_branch: PRODUCTION_BRANCH },
      }),
    };
  };

  const result = await ensureProject({
    accountId: "a".repeat(32),
    token: "test-token",
    fetchImpl,
  });
  assert.equal(result.created, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    name: PROJECT_NAME,
    production_branch: PRODUCTION_BRANCH,
  });
});

test("ensureProject reuses an existing project with the expected production branch", async () => {
  const result = await ensureProject({
    accountId: "a".repeat(32),
    token: "test-token",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { name: PROJECT_NAME, production_branch: PRODUCTION_BRANCH },
      }),
    }),
  });
  assert.equal(result.created, false);
});

test("ensureProject rejects a production-branch mismatch", async () => {
  await assert.rejects(
    () => ensureProject({
      accountId: "a".repeat(32),
      token: "test-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { name: PROJECT_NAME, production_branch: "production" },
        }),
      }),
    }),
    /production branch production/,
  );
});

test("a single-account token needs no committed account identifier", async () => {
  const id = "b".repeat(32);
  const resolved = await resolveAccountId({
    token: "test-token",
    fetchImpl: async (url) => {
      assert.match(url, /\/accounts\?per_page=50$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: [{ id }] }),
      };
    },
  });
  assert.equal(resolved, id);
  assert.doesNotMatch(read(".github/workflows/deploy-cloudflare-pages.yml"), /\b[0-9a-f]{32}\b/);
});
