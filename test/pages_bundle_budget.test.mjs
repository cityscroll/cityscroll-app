import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_PAGES_FILE_BYTES,
  PAGES_FILE_HEADROOM_BYTES,
  oversizedPublishedSourceFiles,
  publishedSourceFiles,
} from "../tools/check_pages_bundle_sizes.mjs";

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
