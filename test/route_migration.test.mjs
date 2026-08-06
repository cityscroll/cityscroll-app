import assert from "node:assert/strict";
import { test } from "node:test";

import { migrateLegacyUrl } from "../site/route_migration.mjs";

test("legacy fragment mappings remain finite and preserve language through docs", () => {
  assert.equal(migrateLegacyUrl("/#exam/7016").target, "/exams/7016/");
  assert.equal(migrateLegacyUrl("/?lang=es#exam/7016").target, "/exams/7016/?lang=es");
  assert.equal(migrateLegacyUrl("/index.html#notice/20240515016").target, "/notices/20240515016");
  assert.equal(migrateLegacyUrl("/#notice/20240515016?w=%7B%22lens%22%3A%22money%22%7D&focus=follow-the-dollars").target,
    "/notices/20240515016?w=%7B%22lens%22%3A%22money%22%7D&focus=follow-the-dollars");
  assert.equal(migrateLegacyUrl("/#staffing?lang=es&view=guide&role=Engineer%20Civil&window=open").target,
    "/browse/staffing/?lang=es&view=guide&role=Engineer+Civil&window=open");
});

test("unsupported legacy scope keys are surfaced explicitly", () => {
  const mapped = migrateLegacyUrl("/#notice/20240515016?q=air&retiredMode=secret");
  assert.equal(mapped.target, "/notices/20240515016?legacy=unsupported-filter");
  assert.deepEqual(mapped.unsupported, ["q", "retiredMode"]);
});

test("non-converted routes and public invariants stay outside the rewrite bridge", () => {
  assert.equal(migrateLegacyUrl("/#matter/84124P0003001").target, "/#matter/84124P0003001");
  assert.equal(migrateLegacyUrl("/stats.html").target, "/stats.html");
  assert.equal(migrateLegacyUrl("https://api.cityscroll.org/stats").target, "/stats");
  assert.equal(migrateLegacyUrl("/#alerts?foo=1").target, "/following/?legacy=unsupported-filter");
});
