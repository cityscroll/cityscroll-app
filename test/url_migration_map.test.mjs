import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { migrateLegacyUrl } from "../site/route_migration.mjs";
import {
  buildMigrationRows,
  renderCsv,
  renderMarkdown,
} from "../tools/build_url_migration_map.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../site/demo/demo-links.json"));

test("finite legacy routes forward to canonical documents and preserve supported parameters", () => {
  assert.equal(migrateLegacyUrl("/?lang=es#notice/20240515016").target, "/notices/20240515016?lang=es");
  assert.equal(migrateLegacyUrl("/index.html#notice/20240515016").target, "/notices/20240515016");
  assert.equal(migrateLegacyUrl("/index.html?lang=es#notice/20240515016").target, "/notices/20240515016?lang=es");
  assert.equal(
    migrateLegacyUrl("/#notice/20240515016?w=%7B%22lens%22%3A%22money%22%7D&focus=follow-the-dollars").target,
    "/notices/20240515016?w=%7B%22lens%22%3A%22money%22%7D&focus=follow-the-dollars",
  );
  assert.equal(migrateLegacyUrl("/#money?closing=week").target, "/browse/contracts/?closing=week");
  assert.equal(
    migrateLegacyUrl("/#staffing?lang=es&view=guide&role=Engineer%20Civil&window=open").target,
    "/browse/staffing/?lang=es&view=guide&role=Engineer+Civil&window=open",
  );
  assert.equal(migrateLegacyUrl("/#map?lens=property").target, "/near-you/?lens=property");
  assert.equal(migrateLegacyUrl("/#alerts").target, "/following/");
  assert.equal(migrateLegacyUrl("/#now").target, "/now/");
});

test("obsolete keys fail soft to a disclosed Browse fallback", () => {
  const mapped = migrateLegacyUrl("/#rules?q=air&retiredMode=secret");
  assert.equal(mapped.target, "/browse/rules/?q=air&legacy=unsupported-filter");
  assert.deepEqual(mapped.unsupported, ["retiredMode"]);
});

test("non-converted item routes and Stats stay outside the finite rewrite", () => {
  assert.equal(migrateLegacyUrl("/#matter/84124P0003001").target, "/#matter/84124P0003001");
  assert.equal(migrateLegacyUrl("/stats.html").target, "/stats.html");
  assert.equal(migrateLegacyUrl("https://api.cityscroll.org/stats").target, "/stats");
});

test("every public demo URL has an explicit generated mapping row", () => {
  const rows = buildMigrationRows();
  const demoRows = rows.filter((row) => row.link_class.startsWith("public demo: "));
  assert.equal(demoRows.length, manifest.entries.length);
  assert.deepEqual(
    new Set(demoRows.map((row) => row.link_class.slice("public demo: ".length))),
    new Set(manifest.entries.map((entry) => entry.id)),
  );
  for (const entry of manifest.entries) {
    const row = demoRows.find((candidate) => candidate.link_class === `public demo: ${entry.id}`);
    assert.equal(row.old_pattern, entry.url);
    assert.equal(row.new_pattern, migrateLegacyUrl(entry.url).target);
  }
});

test("committed CSV and Markdown are exact generated projections", () => {
  const rows = buildMigrationRows();
  assert.equal(read("../docs/url-migration-map.csv"), renderCsv(rows));
  assert.equal(read("../docs/url-migration-map.md"), renderMarkdown(rows));
});
