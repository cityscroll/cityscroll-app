import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function runPublicSiteBuild(sourceDir, siteDir, receiptPath) {
  return spawnSync(process.execPath, [
    "tools/build_public_site.mjs",
    "--source-dir",
    sourceDir,
    "--site-dir",
    siteDir,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GENERATION_OUTPUT_RECEIPT: receiptPath },
  });
}

test("public-site generation fails loudly when its required output is missing", () => {
  const temporary = mkdtempSync(join(tmpdir(), "cityscroll-generation-guard-"));
  try {
    const sourceDir = join(temporary, "source");
    const siteDir = join(temporary, "_site");
    const receiptPath = join(temporary, "receipt.json");
    // A source tree without index.html is the injected silent-failure case.
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(temporary, "source-placeholder.txt"), "not a site entry point\n");
    const result = runPublicSiteBuild(sourceDir, siteDir, receiptPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /generation output guard failed at public-site-generation/);
    assert.ok(result.stderr.includes(`missing generated output: ${join(siteDir, "index.html")}`));
    assert.equal(existsSync(join(siteDir, "index.html")), false);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.schema, "cityscroll.generation-output-receipt.v1");
    assert.equal(receipt.boundary, "public-site-generation");
    assert.equal(receipt.status, "failed");
    assert.deepEqual(receipt.expected_artifacts, [join(siteDir, "index.html")]);
    assert.deepEqual(receipt.findings, [`missing generated output: ${join(siteDir, "index.html")}`]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("public-site generation passes with the required output and ignores optional files", () => {
  const temporary = mkdtempSync(join(tmpdir(), "cityscroll-generation-guard-"));
  try {
    const sourceDir = join(temporary, "source");
    const siteDir = join(temporary, "_site");
    const receiptPath = join(temporary, "receipt.json");
    const sourceIndex = join(sourceDir, "index.html");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourceIndex, "<!doctype html><title>CityScroll</title>\n");
    writeFileSync(join(sourceDir, "optional.txt"), "optional\n");

    const result = runPublicSiteBuild(sourceDir, siteDir, receiptPath);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(siteDir, "index.html"), "utf8"), readFileSync(sourceIndex, "utf8"));
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.schema, "cityscroll.generation-output-receipt.v1");
    assert.equal(receipt.boundary, "public-site-generation");
    assert.equal(receipt.status, "passed");
    assert.deepEqual(receipt.expected_artifacts, [join(siteDir, "index.html")]);
    assert.deepEqual(receipt.findings, []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
