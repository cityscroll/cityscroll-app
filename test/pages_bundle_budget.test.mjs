import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_PAGES_FILE_BYTES,
  PAGES_FILE_HEADROOM_BYTES,
  oversizedPublishedSourceFiles,
  publishedSourceFiles,
} from "../tools/check_pages_bundle_sizes.mjs";
import {
  DEFAULT_ANALYTICAL_PROJECTION_SHARD_MAX_BYTES,
  buildAnalyticalProjectionShardArtifacts,
  combineAnalyticalProjection,
} from "../site/analytical_projection_shards.mjs";

const ROOT = new URL("../", import.meta.url).pathname;

function fixtureSite(files, config) {
  const root = mkdtempSync(join(tmpdir(), "pages-budget-"));
  mkdirSync(join(root, "site", "data"), { recursive: true });
  writeFileSync(join(root, "site", "index.html"), "<!doctype html>\n");
  writeFileSync(join(root, "site", "_config.yml"), config);
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(root, "site", name), Buffer.alloc(bytes, 0x20));
  }
  return root;
}

test("an excluded data artifact leaves the published payload, oversize and all", () => {
  const oversize = MAX_PAGES_FILE_BYTES + 1024;
  const root = fixtureSite(
    { "data/huge.json": oversize, "data/small.json": 16 },
    "include:\n  - _routes.json\n\nexclude:\n  - tools\n",
  );
  try {
    assert.deepEqual(
      oversizedPublishedSourceFiles(root).map((finding) => finding.relativePath),
      ["data/huge.json"],
    );

    writeFileSync(
      join(root, "site", "_config.yml"),
      "include:\n  - _routes.json\n\nexclude:\n  - data/huge.json\n  - tools\n",
    );
    assert.deepEqual(oversizedPublishedSourceFiles(root), []);
    assert.deepEqual(
      publishedSourceFiles(root).map((file) => file.relativePath).sort(),
      ["data/small.json", "index.html"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The production build refreshes source data on the runner before it builds, so
// a pull request measures a smaller copy of every refreshed artifact than the
// deploy publishes. A committed file already close to the hard 24 MiB ceiling
// is therefore a deploy that fails on a day nobody changed it, which is exactly
// how the monolithic Contracts Browse projection took production down. Hold the
// committed payload to the headroom mark so that growth is caught here.
test("every published file this checkout carries keeps its refresh headroom", () => {
  const beyondHeadroom = publishedSourceFiles(ROOT)
    .filter((file) => file.bytes > PAGES_FILE_HEADROOM_BYTES)
    .map((file) => `${file.relativePath} (${(file.bytes / (1024 * 1024)).toFixed(2)} MiB)`);
  assert.deepEqual(
    beyondHeadroom,
    [],
    "a published file above the 18 MiB headroom mark can be pushed past the 24 MiB Pages guard "
    + "by a build-time source refresh: shard it, slim it, or exclude it from site/_config.yml",
  );
});

test("the monolithic Contracts Browse projection is not published", () => {
  assert.equal(
    publishedSourceFiles(ROOT).some((file) => file.relativePath === "data/procurement_browse_rows.json"),
    false,
    "site/data/procurement_browse_rows.json is a builder input and repository artifact; the "
    + "bounded manifest, query rows and full-row shards are the read path",
  );
});

// The two families that took production down on 2026-09-06. The registered
// contract population outgrew the Pages per-file limit when its builder stopped
// accepting its own field-stripped output, and the acquisition spine outgrew it
// on the same refresh. Both are held to their fixed shape here so the next
// growth fails in this suite rather than at deploy.
test("the registered-contract projection is published as a bounded index and shards", () => {
  const published = publishedSourceFiles(ROOT);
  const index = published.find((file) => file.relativePath === "data/analytics_registered_contracts.json");
  assert.ok(index, "the registered-contract projection index must stay published");

  const document = JSON.parse(readFileSync(join(ROOT, "site", index.relativePath), "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(document, "rows"),
    false,
    "the published document is the index: its rows belong in the shards it names, or a build-time "
    + "source refresh puts it back over the 24 MiB Pages guard",
  );
  assert.ok(Array.isArray(document.shards) && document.shards.length, "the index must name its shards");
  assert.ok(index.bytes < 1024 * 1024, `the index is ${index.bytes} bytes; it must stay a small document`);

  const shards = published.filter((file) => file.relativePath.startsWith("data/analytics_registered_contracts/"));
  assert.deepEqual(
    shards.map((file) => file.relativePath).sort(),
    document.shards.map((descriptor) => `data/${descriptor.path}`).sort(),
    "every shard the index names is published, and no shard is published that it does not name",
  );
  assert.deepEqual(
    shards.filter((file) => file.bytes > DEFAULT_ANALYTICAL_PROJECTION_SHARD_MAX_BYTES)
      .map((file) => `${file.relativePath} (${(file.bytes / (1024 * 1024)).toFixed(2)} MiB)`),
    [],
    "a shard over the 18 MiB ceiling has lost its refresh headroom under the 24 MiB Pages guard",
  );
});

test("the acquisition spine is a build input, not a published file", () => {
  assert.equal(
    publishedSourceFiles(ROOT).some((file) => file.relativePath === "data/procurement_spine_sources.json"),
    false,
    "site/data/procurement_spine_sources.json is read from the repository by the procurement, "
    + "entity-intelligence and crosswalk builders; no route fetches it, and publishing it puts a "
    + "refresh-grown copy back over the Pages per-file guard",
  );
});

test("a population too large for one shard is split, and an unsplittable row is refused", () => {
  const row = (id) => ({ prime_contract_id: id, purpose: "x".repeat(4096) });
  const projection = {
    schema: "cityscroll.analytics_registered_contracts.v1",
    generated_at: "2026-09-06T00:00:00.000Z",
    rows: Array.from({ length: 64 }, (_, index) => row(`CT-${index}`)),
  };
  const { manifest, shards } = buildAnalyticalProjectionShardArtifacts(projection, { maxShardBytes: 64 * 1024 });
  assert.ok(manifest.shards.length > 1, "a population past the ceiling is split across shards");
  assert.equal(manifest.row_count, projection.rows.length);
  assert.deepEqual(manifest.shards.filter((descriptor) => descriptor.bytes > 64 * 1024), []);
  assert.deepEqual(combineAnalyticalProjection(manifest, shards), projection, "the split round-trips exactly");

  assert.throws(
    () => buildAnalyticalProjectionShardArtifacts({ rows: [row("CT-HUGE")] }, { maxShardBytes: 512 }),
    /above the 512-byte shard ceiling/,
    "a row larger than a whole shard fails the build with the path that cannot be split",
  );
});
