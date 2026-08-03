import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const read = (path) => readFileSync(new URL(`../site/${path}`, import.meta.url), "utf8");

test("interactive pages honor the deploy-time beta API origin without production fallback", () => {
  for (const page of ["index.html", "about.html", "api.html"]) {
    const source = page === "index.html" ? SITE_SOURCE : read(page);
    assert.match(source, /window\.CROL_API_ORIGIN \|\| "https:\/\/api\.cityscroll\.org"/, page);
    assert.match(
      source,
      /window\.CROL_API_FALLBACK_ORIGIN \|\| "https:\/\/crol-worker\.crol-worker\.workers\.dev"/,
      page,
    );
  }
  assert.match(read("stats.html"), /window\.CROL_API_ORIGIN/);
  assert.match(read("analytics.js"), /window\.CROL_API_ORIGIN/);
});

test("review artifact preparation injects beta API selection before page scripts run", () => {
  const root = mkdtempSync(join(tmpdir(), "crol-beta-worker-"));
  try {
    writeFileSync(join(root, "index.html"), "<!doctype html><body><main>Site</main></body>");
    const result = spawnSync(
      "python3",
      [
        "tools/prepare_review_artifact.py",
        "--site-root",
        root,
        "--channel",
        "beta",
        "--commit",
        "c".repeat(40),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const source = readFileSync(join(root, "index.html"), "utf8");
    assert.match(
      source,
      /window\.CROL_API_ORIGIN = "https:\/\/api-beta\.cityscroll\.org"/,
    );
    assert.ok(
      source.indexOf("window.CROL_API_ORIGIN") < source.indexOf("<main>"),
      "channel config must precede application markup and scripts",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
