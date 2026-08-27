import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { discoverClientModuleGraph } from "../tools/client_module_graph.mjs";
import { checkClientModuleAssets } from "../tools/check_client_module_assets.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

test("public site build publishes capability modules reached by client code", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "cityscroll-client-assets-"));
  const siteDir = join(temporary, "_site");
  try {
    const result = spawnSync(process.execPath, [
      "tools/build_public_site.mjs",
      "--site-dir",
      siteDir,
    ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(siteDir, "capabilities/federated_search.mjs")));
    const graph = discoverClientModuleGraph({ rootDir: siteDir });
    assert.ok(graph.modules.has("/capabilities/federated_search.mjs"));
    assert.deepEqual(graph.missing, []);
    const receipt = await checkClientModuleAssets({ siteDir });
    assert.equal(receipt.moduleCount, graph.modules.size);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("client asset guard checks the built artifact over HTTP", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "cityscroll-client-assets-"));
  try {
    writeFileSync(join(temporary, "index.html"), '<base href="/"><script type="module" src="/main.mjs"></script>');
    writeFileSync(join(temporary, "main.mjs"), 'import "./capabilities/child.mjs";');
    mkdirSync(join(temporary, "capabilities"));
    writeFileSync(join(temporary, "capabilities/child.mjs"), "export const child = true;");
    const receipt = await checkClientModuleAssets({ siteDir: temporary });
    assert.equal(receipt.moduleCount, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("client asset guard accepts JSON modules with their JSON media type", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "cityscroll-client-assets-"));
  try {
    writeFileSync(join(temporary, "index.html"), '<base href="/"><script type="module" src="/main.mjs"></script>');
    writeFileSync(join(temporary, "main.mjs"), 'import data from "./data.json" with { type: "json" }; export { data };');
    writeFileSync(join(temporary, "data.json"), '{"ok":true}');
    const graph = discoverClientModuleGraph({ rootDir: temporary });
    assert.equal(graph.missing.length, 0);
    assert.equal(graph.modules.size, 2);
    const receipt = await checkClientModuleAssets({ siteDir: temporary });
    assert.equal(receipt.moduleCount, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("client asset guard rejects an unpublished local import", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "cityscroll-client-assets-"));
  try {
    writeFileSync(join(temporary, "index.html"), '<base href="/"><script type="module" src="/main.mjs"></script>');
    writeFileSync(join(temporary, "main.mjs"), 'import "./capabilities/missing.mjs";');
    await assert.rejects(
      checkClientModuleAssets({ siteDir: temporary }),
      /Client module graph has missing assets: \/capabilities\/missing\.mjs/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
