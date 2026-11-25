import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { discoverClientModuleGraph } from "../tools/client_module_graph.mjs";
import { checkClientModuleAssets } from "../tools/check_client_module_assets.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const START_PREVIEW_BOOT = '<script type="module" src="/start/preview.mjs"></script>';

function writePublicDocument(root, route, marker) {
  const directory = join(root, route);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), `<!doctype html><html><head><title>${marker}</title></head><body><main>${marker}</main></body></html>`);
}

function buildPublicFixture(source, destination) {
  return spawnSync(process.execPath, [
    "tools/build_public_site.mjs",
    "--source-dir", source,
    "--site-dir", destination,
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, GENERATION_OUTPUT_RECEIPT: join(destination, "generation-output-receipt.json") },
  });
}

test("public site build publishes capability modules reached by client code", async () => {
  await withTempDir("client-assets", async (temporary) => {
    const siteDir = join(temporary, "_site");
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
  });
});

test("Static Pages destinations boot the opt-in module without replacing their documents", async () => {
  await withTempDir("start-preview-build", async (temporary) => {
    const source = join(temporary, "source");
    const destination = join(temporary, "public");
    writePublicDocument(source, "", "home-normal-rendering");
    writePublicDocument(source, "browse", "browse-normal-rendering");
    writePublicDocument(source, "browse/contracts", "browse-subpage-rendering");
    writePublicDocument(source, "search", "search-normal-rendering");
    writePublicDocument(source, "now", "now-normal-rendering");
    writePublicDocument(source, "guide/reference", "guide-normal-rendering");
    mkdirSync(join(source, "start"), { recursive: true });
    writeFileSync(join(source, "start", "preview.mjs"), "export {};\n");

    const result = buildPublicFixture(source, destination);
    assert.equal(result.status, 0, result.stderr);
    for (const [route, marker] of [
      ["search/index.html", "search-normal-rendering"],
      ["now/index.html", "now-normal-rendering"],
      ["guide/reference/index.html", "guide-normal-rendering"],
    ]) {
      const document = readFileSync(join(destination, route), "utf8");
      assert.ok(document.includes(START_PREVIEW_BOOT), `${route} boots the preview module`);
      assert.ok(document.includes(`<main>${marker}</main>`), `${route} retains normal rendering`);
      assert.ok(!document.includes('/start/preview.css'), `${route} does not load preview CSS before opt-in`);
    }
    for (const route of ["browse/index.html", "browse/contracts/index.html"]) {
      const document = readFileSync(join(destination, route), "utf8");
      assert.ok(!document.includes(START_PREVIEW_BOOT), `${route} is handled by the Pages edge`);
    }
    assert.ok(!readFileSync(join(destination, "index.html"), "utf8").includes(START_PREVIEW_BOOT));
  });
});

test("minimal site fixtures without the preview module build unchanged", async () => {
  await withTempDir("start-preview-minimal", async (temporary) => {
    const source = join(temporary, "source");
    const destination = join(temporary, "public");
    writePublicDocument(source, "", "home");
    writePublicDocument(source, "browse", "browse-without-preview");
    const before = readFileSync(join(source, "browse", "index.html"), "utf8");

    const result = buildPublicFixture(source, destination);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(destination, "browse", "index.html"), "utf8"), before);
  });
});

test("client asset guard checks the built artifact over HTTP", async () => {
  await withTempDir("client-assets", async (temporary) => {
    writeFileSync(join(temporary, "index.html"), '<base href="/"><script type="module" src="/main.mjs"></script>');
    writeFileSync(join(temporary, "main.mjs"), 'import "./capabilities/child.mjs";');
    mkdirSync(join(temporary, "capabilities"));
    writeFileSync(join(temporary, "capabilities/child.mjs"), "export const child = true;");
    const receipt = await checkClientModuleAssets({ siteDir: temporary });
    assert.equal(receipt.moduleCount, 2);
  });
});

test("client asset guard accepts JSON modules with their JSON media type", async () => {
  await withTempDir("client-assets", async (temporary) => {
    writeFileSync(join(temporary, "index.html"), '<base href="/"><script type="module" src="/main.mjs"></script>');
    writeFileSync(join(temporary, "main.mjs"), 'import data from "./data.json" with { type: "json" }; export { data };');
    writeFileSync(join(temporary, "data.json"), '{"ok":true}');
    const graph = discoverClientModuleGraph({ rootDir: temporary });
    assert.equal(graph.missing.length, 0);
    assert.equal(graph.modules.size, 2);
    const receipt = await checkClientModuleAssets({ siteDir: temporary });
    assert.equal(receipt.moduleCount, 2);
  });
});

test("client asset guard rejects an unpublished local import", async () => {
  await withTempDir("client-assets", async (temporary) => {
    writeFileSync(join(temporary, "index.html"), '<base href="/"><script type="module" src="/main.mjs"></script>');
    writeFileSync(join(temporary, "main.mjs"), 'import "./capabilities/missing.mjs";');
    await assert.rejects(
      checkClientModuleAssets({ siteDir: temporary }),
      /Client module graph has missing assets: \/capabilities\/missing\.mjs/,
    );
  });
});
